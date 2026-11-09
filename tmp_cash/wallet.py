"""Store individual denomination proofs and reserve complete input sets."""

import os
from pathlib import Path

from .client import Client, ClientError, MeltOperation, MintOperation, SwapOperation
from .crud import WALLET
from .db import Database
from .keyset import denominations
from .models import MeltResponse, Token, preimage_hash
from .token import encode_token

Operation = MintOperation | SwapOperation | MeltOperation


class Wallet:
    def __init__(self, path: Path | str):
        self.db = Database(path, WALLET)
        if self.db.path is not None:
            os.chmod(self.db.path, 0o600)
        with self.db.transaction() as db:
            db.create_metadata()
            protocol = db.metadata_value("protocol")
            tables = db.table_names()
            if (protocol is not None and protocol != "ps-wallet-v3") or (
                protocol is None and "tokens" in tables
            ):
                raise ValueError(
                    "wallet database uses a previous protocol; use a new v3 wallet"
                )
            db.set_metadata("protocol", "ps-wallet-v3")
            db.create_store()
            db.migrate_wallet()

    def save(self, operation: Operation, send_amount: int | None = None):
        with self.db.transaction() as conn:
            self._save(conn, operation, send_amount)

    def save_many(self, operations: list[Operation]):
        """Persist every recovery request before starting a multi-backing receive."""
        with self.db.transaction() as conn:
            conn.lock_keys("operation", [operation.id for operation in operations])
            conn.lock_keys(
                "mint-quote",
                [
                    operation.quote.quote
                    for operation in operations
                    if isinstance(operation, MintOperation)
                ],
            )
            # Lock imported proofs in a consistent order across the full batch.
            sources = sorted(
                {
                    Client.nullifier(proof)
                    for operation in operations
                    if not isinstance(operation, MintOperation)
                    for proof in operation.token.proofs
                }
            )
            conn.lock_keys("token", sources)
            for operation in sorted(operations, key=lambda operation: operation.id):
                self._save(conn, operation)

    def _save(self, conn, operation: Operation, send_amount: int | None = None):
        conn.lock_keys("operation", [operation.id])
        if isinstance(operation, MintOperation):
            conn.lock_keys("mint-quote", [operation.quote.quote])
        else:
            conn.lock_keys(
                "token", [Client.nullifier(proof) for proof in operation.token.proofs]
            )
        if send_amount is not None and (
            not isinstance(operation, SwapOperation)
            or not 0 < send_amount <= operation.token.amount
            or [
                p.amount
                for p in operation.request.outputs[: len(denominations(send_amount))]
            ]
            != denominations(send_amount)
        ):
            raise ValueError("invalid split-send operation")
        previous = conn.get(
            "operations",
            columns=("payload", "send_amount"),
            id=operation.id,
            for_update=True,
        )
        if previous:
            if previous[0] != operation.model_dump_json() or previous[1] != send_amount:
                raise ValueError("operation id already belongs to another request")
            return
        if isinstance(operation, MintOperation) and any(
            MintOperation.model_validate_json(row[0]).quote.quote
            == operation.quote.quote
            for row in conn.select("operations", columns=("payload",), kind="mint")
        ):
            raise ValueError(
                "mint quote already has a saved recovery request; retry it"
            )
        conn.insert(
            "operations",
            {
                "id": operation.id,
                "kind": operation.kind,
                "payload": operation.model_dump_json(),
                "attempted": 0,
                "send_amount": send_amount,
            },
        )
        if operation.kind != "mint":
            for proof in sorted(operation.token.proofs, key=Client.nullifier):
                source = Client.nullifier(proof)
                row = conn.get("tokens", columns=("state",), id=source, for_update=True)
                allowed = {"LIVE", "SENT"} if operation.kind == "swap" else {"LIVE"}
                if row is not None and row[0] not in allowed:
                    raise ValueError(
                        "token is already spent or has a pending operation"
                    )
                token = Token(mint=operation.token.mint, proofs=[proof])
                conn.insert(
                    "tokens",
                    {"id": source, "token": token.model_dump_json(), "state": "LIVE"},
                    ignore=True,
                )
                conn.insert(
                    "operation_sources",
                    {
                        "source": source,
                        "operation": operation.id,
                        "original_state": "LIVE" if row is None else row[0],
                    },
                )
                conn.update(
                    "tokens",
                    {"state": "PENDING", "token": token.model_dump_json()},
                    id=source,
                )

    def operation(self, operation_id: str) -> Operation:
        with self.db.read() as conn:
            row = conn.get("operations", id=operation_id)
        if row is None:
            raise ValueError("unknown pending operation")
        if row["kind"] == "mint":
            return MintOperation.model_validate_json(row["payload"])
        if row["kind"] == "swap":
            return SwapOperation.model_validate_json(row["payload"])
        return MeltOperation.model_validate_json(row["payload"])

    def pending_mint(self, quote_id: str) -> MintOperation | None:
        with self.db.read() as conn:
            operations = [
                MintOperation.model_validate_json(row[0])
                for row in conn.select("operations", columns=("payload",), kind="mint")
            ]
        matches = [o for o in operations if o.quote.quote == quote_id]
        if len(matches) > 1:
            raise ValueError(
                "multiple saved requests for this quote; use pending and retry"
            )
        return matches[0] if matches else None

    def set_mint_preimage(self, operation_id: str, preimage: str) -> MintOperation:
        operation = self.operation(operation_id)
        if not isinstance(operation, MintOperation):
            raise ValueError("not a mint operation")
        if preimage_hash(preimage) != operation.quote.payment_hash:
            raise ValueError("HTLC preimage does not match the mint quote")
        operation = MintOperation.model_validate(
            operation.model_dump() | {"preimage": preimage}
        )
        with self.db.transaction() as conn:
            conn.update(
                "operations",
                {"payload": operation.model_dump_json()},
                id=operation_id,
            )
        return operation

    def pending(self) -> list[dict]:
        with self.db.read() as conn:
            return [
                dict(row._mapping)
                for row in conn.select("operations", columns=("id", "kind"))
            ]

    def complete(self, operation_id: str, token: Token | None) -> Token | None:
        with self.db.transaction() as conn:
            conn.lock_keys("operation", [operation_id])
            operation = conn.get(
                "operations", columns=("send_amount",), id=operation_id, for_update=True
            )
            if operation is None:
                raise ValueError("unknown pending operation")
            outgoing = None
            sent_count = 0
            if operation["send_amount"] is not None:
                amounts = denominations(operation["send_amount"])
                sent_count = len(amounts)
                if (
                    token is None
                    or [p.amount for p in token.proofs[:sent_count]] != amounts
                ):
                    raise ValueError("split-send outputs do not match the saved intent")
                outgoing = Token(mint=token.mint, proofs=token.proofs[:sent_count])
            conn.wallet_spend_sources(operation_id)
            if token:
                for index, proof in enumerate(token.proofs):
                    single = Token(mint=token.mint, proofs=[proof])
                    conn.insert(
                        "tokens",
                        {
                            "id": Client.nullifier(proof),
                            "token": single.model_dump_json(),
                            "state": "SENT" if index < sent_count else "LIVE",
                        },
                    )
            conn.delete("operations", id=operation_id)
            return outgoing

    def retry(
        self, client: Client, operation_id: str, kind: str | None = None
    ) -> Token | MeltResponse:
        operation = self.operation(operation_id)
        if kind is not None and kind != operation.kind:
            raise ValueError("incorrect operation kind")
        if (
            operation.kind != "mint"
            and operation.token.mint.rstrip("/") != client.mint_url
        ):
            raise ValueError("operation belongs to another mint")
        with self.db.transaction() as conn:
            updated = conn.update(
                "operations",
                {"attempted": 1},
                id=operation_id,
                payload=operation.model_dump_json(),
            )
            if updated.rowcount != 1:
                raise ValueError("pending operation changed; reload before retrying")
        if isinstance(operation, MintOperation):
            token = client.finish_mint(operation)
            self.complete(operation_id, token)
            return token
        if isinstance(operation, SwapOperation):
            token = client.finish_swap(operation)
            return self.complete(operation_id, token) or token
        try:
            response = client.finish_melt(operation)
        except ClientError as exc:
            if (
                exc.status_code == 410
                and exc.detail == "melt payment failed; backing has expired"
            ):
                # Terminal: the backing was settled or expired before the
                # payout failed, so the inputs must never be reused. The mint
                # keeps the wire nullifiers UNSPENT; expire them locally.
                self._expire_operation(operation_id)
                raise
            if exc.status_code == 409 and exc.detail in {
                "melt payment failed; tokens are unspent",
                "melt quote already belongs to another request",
                "payout invoice is already paid",
                "melt quote has expired",
                "backing HTLC is closed; its tokens have expired",
                "backing HTLC redemption deadline has passed",
                "backing HTLC is too close to its settlement cutoff for a new melt",
            }:
                nullifiers = [Client.nullifier(p) for p in operation.token.proofs]
                try:
                    unspent = client.check(nullifiers).states == ["UNSPENT"] * len(
                        nullifiers
                    )
                except Exception:
                    unspent = False
                if unspent:
                    self._release_operation(operation_id)
                    try:
                        self.refresh(client)
                    except Exception:
                        # Preserve the original rejection and all proof records.
                        pass
            raise
        self.complete(operation_id, client.melt_change(operation, response))
        return response

    def abandon(self, client: Client, operation_id: str):
        operation = self.operation(operation_id)
        if isinstance(operation, MintOperation):
            raise ValueError("retry mint operations to preserve recovery secrets")
        if operation.token.mint.rstrip("/") != client.mint_url:
            raise ValueError("operation belongs to another mint")
        nullifiers = [Client.nullifier(p) for p in operation.token.proofs]
        if client.check(nullifiers).states != ["UNSPENT"] * len(nullifiers):
            raise ValueError("mint has spent or reserved an input; retry the operation")
        self._release_operation(operation_id, require_unsubmitted=True)

    def _expire_operation(self, operation_id: str):
        """Clear a terminally failed melt and mark its inputs locally expired."""
        with self.db.transaction() as conn:
            conn.lock_keys("operation", [operation_id])
            operation = conn.get(
                "operations", columns=("kind",), id=operation_id, for_update=True
            )
            if operation is None:
                raise ValueError("unknown pending operation")
            if operation["kind"] != "melt":
                raise ValueError("only melt operations can expire terminally")
            for source in conn.select(
                "operation_sources",
                columns=("source", "original_state"),
                operation=operation_id,
            ):
                conn.update(
                    "tokens",
                    {
                        "state": "EXPIRED",
                        "expired_state": source["original_state"] or "LIVE",
                    },
                    id=source["source"],
                    state="PENDING",
                )
            conn.delete("operations", id=operation_id)

    def _release_operation(self, operation_id: str, require_unsubmitted: bool = False):
        with self.db.transaction() as conn:
            conn.lock_keys("operation", [operation_id])
            operation = conn.get(
                "operations",
                columns=("kind", "attempted"),
                id=operation_id,
                for_update=True,
            )
            if operation is None:
                raise ValueError("unknown pending operation")
            if require_unsubmitted and operation["attempted"]:
                raise ValueError(
                    "operation was submitted; retry it to preserve recovery secrets"
                )
            for source in conn.select(
                "operation_sources",
                columns=("source", "original_state"),
                operation=operation_id,
            ):
                # Legacy operations lost their original LIVE/SENT distinction.
                conn.update(
                    "tokens",
                    {
                        "state": source["original_state"]
                        or ("LIVE" if operation["kind"] == "melt" else "SENT")
                    },
                    id=source["source"],
                    state="PENDING",
                )
            conn.delete("operations", id=operation_id)

    def tokens(self) -> list[dict]:
        with self.db.read() as conn:
            rows = conn.select("tokens", order_by="rowid")
        return [
            {
                "id": row["id"],
                "state": row["state"],
                "mint": token.mint,
                "amount": token.amount,
                "payment_hash": token.payment_hash,
                "backing_amount": token.proofs[0].backing_amount,
            }
            for row in rows
            for token in [Token.model_validate_json(row["token"])]
        ]

    def token(self, token_id: str, state: str = "LIVE") -> Token:
        with self.db.read() as conn:
            row = conn.get("tokens", columns=("token",), id=token_id, state=state)
        if row is None:
            raise ValueError("unknown token or token is not available")
        return Token.model_validate_json(row[0])

    def select_token(
        self,
        amount: int,
        mint: str,
        payment_hash: str | None = None,
        token_ids: list[str] | None = None,
    ) -> Token:
        if amount <= 0:
            raise ValueError("amount must be positive")
        candidates = [
            r
            for r in self.tokens()
            if r["state"] == "LIVE"
            and r["mint"].rstrip("/") == mint.rstrip("/")
            and (payment_hash is None or r["payment_hash"] == payment_hash)
            and (token_ids is None or r["id"] in token_ids)
        ]
        selected = []
        total = 0
        for row in sorted(candidates, key=lambda r: r["amount"], reverse=True):
            selected.extend(self.token(row["id"]).proofs)
            total += row["amount"]
            if total >= amount:
                return Token(mint=mint, proofs=selected)
        raise ValueError("insufficient available tokens for amount and fee reserve")

    def refresh(self, client: Client):
        with self.db.read() as conn:
            candidates = [
                dict(row._mapping)
                for row in conn.select(
                    "tokens", in_={"state": ("LIVE", "SENT", "EXPIRED")}
                )
                if Token.model_validate_json(row["token"]).mint.rstrip("/")
                == client.mint_url
            ]
        snapshot = client.check_htlcs(
            Token.model_validate_json(row["token"]).payment_hash for row in candidates
        )
        changes = []
        for row in candidates:
            token = Token.model_validate_json(row["token"])
            try:
                client._check_backing(token.proofs[0], snapshot)
            except ClientError:
                if row["state"] in {"LIVE", "SENT"}:
                    changes.append(
                        ("EXPIRED", row["state"], row["id"], row["state"], row["token"])
                    )
            else:
                if row["state"] != "EXPIRED":
                    continue
                try:
                    client.credentials(token)
                except (ClientError, ValueError):
                    continue
                if client.check([row["id"]]).states == ["UNSPENT"]:
                    changes.append(
                        (
                            row["expired_state"] or "SENT",
                            None,
                            row["id"],
                            "EXPIRED",
                            row["token"],
                        )
                    )
        with self.db.transaction() as conn:
            conn.wallet_refresh(changes)

    def send(
        self,
        client: Client,
        amount: int,
        payment_hash: str | None = None,
        token_ids: list[str] | None = None,
        preimage: str | None = None,
    ) -> str:
        if token_ids:
            rows = {r["id"]: r for r in self.tokens()}
            if all(n in rows and rows[n]["state"] == "SENT" for n in token_ids):
                tokens = [self.token(n, "SENT") for n in token_ids]
                recovered = Token(
                    mint=client.mint_url, proofs=[p for t in tokens for p in t.proofs]
                )
                if recovered.amount != amount or any(
                    t.mint.rstrip("/") != client.mint_url for t in tokens
                ):
                    raise ValueError(
                        "sent tokens do not match requested amount or mint"
                    )
                return encode_token(recovered)
        totals: dict[str, int] = {}
        for row in self.tokens():
            if (
                row["state"] == "LIVE"
                and row["mint"].rstrip("/") == client.mint_url
                and (token_ids is None or row["id"] in token_ids)
            ):
                totals[row["payment_hash"]] = (
                    totals.get(row["payment_hash"], 0) + row["amount"]
                )
        matches = [
            h
            for h, total in totals.items()
            if total >= amount and (payment_hash is None or h == payment_hash)
        ]
        if len(matches) != 1:
            raise ValueError(
                "send needs one HTLC with enough value; select --payment-hash if ambiguous"
            )
        token = self.select_token(amount, client.mint_url, matches[0], token_ids)
        if preimage is not None:
            token = token.with_preimage(preimage)
        if any(p.preimage is None for p in token.proofs):
            raise ValueError("token has no backing preimage; supply --preimage")
        client.check_backing(token)
        if token.amount != amount:
            send_amounts = denominations(amount)
            operation = client.prepare_swap(
                token, send_amounts + denominations(token.amount - amount)
            )
            self.save(operation, send_amount=amount)
            received = self.retry(client, operation.id)
            assert isinstance(received, Token)
            return encode_token(received)
        with self.db.transaction() as conn:
            for proof in token.proofs:
                single = Token(mint=token.mint, proofs=[proof])
                updated = conn.update(
                    "tokens",
                    {"state": "SENT", "token": single.model_dump_json()},
                    id=Client.nullifier(proof),
                    state="LIVE",
                )
                if updated.rowcount != 1:
                    raise ValueError("token is already sent or has a pending operation")
        return encode_token(token)
