"""Denominated, expiring HTLC credentials and a durable Lightning melt outbox."""

import asyncio
import hashlib
import hmac
import os
import time
import uuid
from collections import OrderedDict
from collections.abc import Iterable, Sequence
from pathlib import Path

from bolt11 import decode
from sqlalchemy.exc import IntegrityError

from .concurrency import KeyedLocks, run_blocking
from .crud import MINT
from .crypto.bls import PublicKey
from .crypto.ps import (
    DlogEqProof,
    LinearProof,
    Presentation,
    PrivatePresentation,
    issue,
    issue_blind,
    verify_linear,
    verify_owner_secret,
    verify_presentation,
    verify_private_presentation,
)
from .db import BackendError, Database, IncompatibleMintDatabase, MintError
from .keyset import COMMON_H_DST, Keyset, common_h_statements, denominations
from .lightning import (
    HoldInvoiceBackend,
    Invoice,
    Payment,
    PaymentState,
    invoice_details,
)
from .models import (
    CheckResponse,
    HTLCCheckRequest,
    InvoiceState,
    KeysetResponse,
    MeltQuoteRequest,
    MeltQuoteResponse,
    MeltRequest,
    MeltResponse,
    MintRequest,
    Output,
    PendingHTLC,
    PendingHTLCsResponse,
    QuoteRequest,
    QuoteResponse,
    SignatureResponse,
    SignaturesResponse,
    SwapRequest,
    htlc_claim_scalar,
    melt_binding,
    preimage_hash,
    swap_binding,
)


def request_digest(request) -> str:
    return hashlib.sha256(request.model_dump_json().encode()).hexdigest()


SCHEMA_VERSION = 2


class Mint:
    def __init__(
        self,
        path: Path | str,
        seed: bytes,
        backend: HoldInvoiceBackend,
        settle_margin_blocks: int = 6,
        settle_margin_seconds: int = 120,
    ):
        if len(seed) < 32:
            raise ValueError("mint seed must contain at least 32 bytes")
        if settle_margin_blocks < 1 or settle_margin_seconds < 1:
            raise ValueError("settlement margins must be positive")
        self.db = Database(path, MINT)
        acquire = self.db.acquire_singleton()
        self.backend = backend
        self.settle_margin_blocks = settle_margin_blocks
        self.settle_margin_seconds = settle_margin_seconds
        self.fee_limit_sat = getattr(backend, "fee_limit_sat", 10)
        self.keys = Keyset(seed)
        self._melt_locks = KeyedLocks()
        self._hold_locks = KeyedLocks()
        self._sync_work = asyncio.Semaphore(4)
        self._last_prune = 0.0
        self._last_mint_prune = 0.0
        fingerprint = hmac.new(
            seed, b"Cashu_PS_Denominations_DB_v3", hashlib.sha256
        ).hexdigest()
        with self.db.transaction() as db:
            db.create_metadata()
            metadata = db.metadata()
            tables = db.table_names()
            if metadata.get("protocol") not in (None, "ps-htlc-denominations-v3") or (
                "quotes" in tables and "protocol" not in metadata
            ):
                raise IncompatibleMintDatabase(
                    "mint database uses a previous protocol; use a new v3 database"
                )
            if metadata.get("seed_fingerprint", fingerprint) != fingerprint:
                raise ValueError("mint database belongs to a different seed")
            # An existing v3 database without a version is schema version 1.
            raw_version = metadata.get(
                "schema_version", "1" if "quotes" in tables else str(SCHEMA_VERSION)
            )
            try:
                version = int(raw_version)
            except ValueError:
                raise IncompatibleMintDatabase(
                    "mint database has an invalid schema version"
                ) from None
            if not 1 <= version <= SCHEMA_VERSION:
                raise IncompatibleMintDatabase(
                    "mint database uses a newer schema version; upgrade tmp.cash"
                )
            db.set_metadata("protocol", "ps-htlc-denominations-v3")
            db.set_metadata("seed_fingerprint", fingerprint)
            db.create_store()
            if version < 2:
                db.migrate_mint_v2()
            if db.mint_invalid_backing():
                raise IncompatibleMintDatabase(
                    "mint database contains invalid backing accounting"
                )
            db.set_metadata("schema_version", str(SCHEMA_VERSION), replace=True)
            # Single-process ownership makes clearing orphaned executor locks
            # from a previous run safe (Nutshell PR #8 startup recovery) — but
            # only on this process's first acquisition; a reentrant in-process
            # reopen must not steal locks from live executors.
            if acquire:
                db.mint_clear_orphaned_locks()

    async def _run_sync(self, operation, *args):
        """Bounded admission for expensive synchronous proof/signature work.

        At most four operations run concurrently, offloaded from the event
        loop; admission waits at most half a second before asking the caller
        to retry instead of queueing unbounded unauthenticated work.
        """
        try:
            await asyncio.wait_for(self._sync_work.acquire(), 0.5)
        except asyncio.TimeoutError:
            raise MintError(
                "mint is busy with cryptographic work; retry the request", 503
            ) from None
        try:
            return await run_blocking(operation, *args)
        finally:
            self._sync_work.release()

    def keyset(self) -> KeysetResponse:
        return KeysetResponse(
            id=self.keys.id,
            keys={
                amount: key.to_bytes().hex() for amount, key in self.keys.public.items()
            },
        )

    def _key(self, amount: int):
        if amount not in self.keys.private:
            raise MintError("unsupported denomination")
        return self.keys.private[amount]

    def _owner(self, output: Output) -> PublicKey:
        self._key(output.amount)
        point = PublicKey(compressed=bytes.fromhex(output.commitment), group="G1")
        if not verify_owner_secret(
            point, DlogEqProof.from_bytes(bytes.fromhex(output.proof))
        ):
            raise MintError("invalid owner commitment proof")
        return point

    def _sign(
        self, output: Output, h: int, payment_hash: str | None = None
    ) -> SignatureResponse:
        u, v = issue(self._key(output.amount), h, self._owner(output))
        return SignatureResponse(
            amount=output.amount,
            keyset_id=self.keys.id,
            u=u.format().hex(),
            v=v.format().hex(),
            payment_hash=payment_hash,
        )

    @staticmethod
    def _unique_outputs(outputs: Sequence[Output]):
        if len({p.commitment for p in outputs}) != len(outputs):
            raise MintError("duplicate output commitment")

    def _validate_invoice(self, invoice: Invoice, payment_hash: str, amount: int):
        try:
            details = invoice_details(invoice.request)
        except ValueError as exc:
            raise BackendError("backend returned an invalid backing invoice") from exc
        if (
            invoice.payment_hash != payment_hash
            or invoice.amount != amount
            or details != (payment_hash, amount)
        ):
            raise BackendError("backend invoice does not match the quote")

    def _deadline(
        self, invoice: Invoice, height: int | None
    ) -> tuple[int | None, int | None]:
        if height is not None:
            if (
                invoice.expiry_height is None
                or invoice.htlc_expiry_height is None
                or not 0 <= invoice.expiry_height <= invoice.htlc_expiry_height
            ):
                raise BackendError("accepted backing HTLC expiry is unavailable")
            return max(0, invoice.expiry_height - self.settle_margin_blocks), None
        if invoice.hold_expires_at is None:
            raise BackendError("accepted backing HTLC expiry is unavailable")
        return None, max(0, invoice.hold_expires_at - self.settle_margin_seconds)

    def _before_deadline(self, invoice: Invoice, height: int | None) -> bool:
        block, timestamp = self._deadline(invoice, height)
        if height is not None and block is not None:
            return height < block
        if timestamp is None:
            raise BackendError("accepted backing HTLC deadline is unavailable")
        return int(time.time()) < timestamp

    async def _live_invoice(self, row) -> Invoice:
        if row["closed"]:
            raise MintError("backing HTLC is closed; its tokens have expired", 409)
        invoice = await self.backend.get_invoice(row["payment_hash"])
        self._validate_invoice(invoice, row["payment_hash"], row["amount"])
        if row["issued"] and (
            invoice.state == InvoiceState.open
            or (
                invoice.state == InvoiceState.accepted
                and invoice.amount_paid < row["amount"]
            )
        ):
            raise BackendError("issued backing HTLC state is unavailable")
        if row["issued"] and invoice.state in (
            InvoiceState.settled,
            InvoiceState.canceled,
        ):
            raise MintError("backing HTLC is closed; its tokens have expired", 409)
        if (
            invoice.state != InvoiceState.accepted
            or invoice.amount_paid < row["amount"]
        ):
            raise MintError(
                "backing HTLC is not fully accepted; its tokens are unavailable", 409
            )
        height = await self.backend.get_block_height()
        if not self._before_deadline(invoice, height):
            raise MintError("backing HTLC redemption deadline has passed", 409)
        return invoice

    async def check_htlcs(self, request: HTLCCheckRequest) -> PendingHTLCsResponse:
        hashes = list(dict.fromkeys(request.payment_hashes))
        rows = await self.db.run_read(lambda conn: conn.mint_htlc_quotes(hashes))
        height = await self.backend.get_block_height()
        semaphore = asyncio.Semaphore(8)

        async def lookup(row):
            async with semaphore:
                invoice = await self.backend.get_invoice(row["payment_hash"])
                self._validate_invoice(invoice, row["payment_hash"], row["amount"])
                return invoice

        invoices = await asyncio.gather(*(lookup(row) for row in rows))
        now = int(time.time())
        closed = await self.db.run_read(lambda conn: conn.mint_closed_hashes(hashes))
        entries = []
        for invoice in invoices:
            if invoice.state == InvoiceState.open or (
                invoice.state == InvoiceState.accepted
                and invoice.amount_paid < invoice.amount
            ):
                raise BackendError("issued backing HTLC state is unavailable")
            if (
                invoice.payment_hash in closed
                or invoice.state != InvoiceState.accepted
                or invoice.amount_paid < invoice.amount
            ):
                continue
            deadline_height, deadline = self._deadline(invoice, height)
            if height is not None:
                if invoice.expiry_height is None or invoice.expiry_height <= height:
                    continue
            elif invoice.hold_expires_at is None or invoice.hold_expires_at <= now:
                continue
            entries.append(
                PendingHTLC(
                    payment_hash=invoice.payment_hash,
                    amount=invoice.amount,
                    invoice_expires_at=invoice.expiry,
                    htlc_expiry_height=invoice.htlc_expiry_height,
                    expiry_height=invoice.expiry_height,
                    blocks_remaining=None
                    if height is None
                    else invoice.expiry_height - height,
                    expires_at=invoice.hold_expires_at if height is None else None,
                    melt_deadline_height=deadline_height,
                    melt_deadline=deadline,
                )
            )
        return PendingHTLCsResponse(checked_at=now, block_height=height, htlcs=entries)

    async def quote(self, request: QuoteRequest) -> QuoteResponse:
        h = htlc_claim_scalar(request.payment_hash, request.amount)
        existing = await self.db.run_read(
            lambda conn: conn.get(
                "quotes", columns=("quote", "amount"), payment_hash=request.payment_hash
            )
        )
        if existing:
            if existing["amount"] != request.amount:
                raise MintError("payment hash already has a different amount", 409)
            return await self.get_quote(existing["quote"])
        invoice = await self.backend.create_hold_invoice(
            request.amount, request.payment_hash, request.expiry
        )
        self._validate_invoice(invoice, request.payment_hash, request.amount)
        quote_id = os.urandom(32).hex()
        try:
            await self.db.run_transaction(
                lambda conn: conn.insert(
                    "quotes",
                    {
                        "quote": quote_id,
                        "payment_hash": request.payment_hash,
                        "amount": request.amount,
                        "h": f"{h:064x}",
                        "request": invoice.request,
                        "expiry": invoice.expiry,
                    },
                )
            )
        except IntegrityError:
            existing = await self.db.run_read(
                lambda conn: conn.get(
                    "quotes",
                    columns=("quote", "amount"),
                    payment_hash=request.payment_hash,
                )
            )
            if existing is None or existing["amount"] != request.amount:
                raise MintError("payment hash or HTLC claim already used", 409)
            quote_id = existing["quote"]
        return await self.get_quote(quote_id)

    async def get_quote(self, quote_id: str) -> QuoteResponse:
        row = await self.db.run_read(lambda conn: conn.get("quotes", quote=quote_id))
        if row is None:
            raise MintError("unknown mint quote", 404)
        invoice = await self.backend.get_invoice(row["payment_hash"])
        self._validate_invoice(invoice, row["payment_hash"], row["amount"])
        return QuoteResponse(
            quote=row["quote"],
            amount=row["amount"],
            payment_hash=row["payment_hash"],
            request=row["request"],
            expiry=row["expiry"],
            state=invoice.state,
            issued=bool(row["issued"]),
            keyset_id=self.keys.id,
        )

    def _validate_outputs(self, request: MintRequest):
        self._unique_outputs(request.outputs)
        for output in request.outputs:
            self._owner(output)

    def _commit_issuance(
        self, request: MintRequest, row, digest: str
    ) -> SignaturesResponse:
        response = SignaturesResponse(
            signatures=[self._sign(p, int(row["h"], 16)) for p in request.outputs]
        )
        with self.db.transaction() as conn:
            updated = conn.update(
                "quotes",
                {
                    "issued": 1,
                    "digest": digest,
                    "response": response.model_dump_json(),
                },
                quote=request.quote,
                issued=0,
            )
            if updated.rowcount != 1:
                current = conn.get(
                    "quotes", columns=("digest", "response"), quote=request.quote
                )
                if current is not None and current["digest"] == digest:
                    return SignaturesResponse.model_validate_json(current["response"])
                raise MintError("quote already issued to another request", 409)
        return response

    async def mint(self, request: MintRequest) -> SignaturesResponse:
        await self._run_sync(self._validate_outputs, request)
        digest = request_digest(request)
        row = await self.db.run_read(
            lambda conn: conn.get("quotes", quote=request.quote)
        )
        if row is None:
            raise MintError("unknown mint quote", 404)
        async with self._hold_locks.hold(row["payment_hash"]):
            row = await self.db.run_read(
                lambda conn: conn.get("quotes", quote=request.quote)
            )
            if row is None:
                raise MintError("unknown mint quote", 404)
            if row["issued"]:
                if row["digest"] == digest:
                    return SignaturesResponse.model_validate_json(row["response"])
                raise MintError("quote already issued to another request", 409)
            if sum(p.amount for p in request.outputs) != row["amount"]:
                raise MintError(
                    "output denominations must sum to the funded HTLC amount"
                )
            await self._live_invoice(row)
            return await self._run_sync(self._commit_issuance, request, row, digest)

    async def swap(self, request: SwapRequest) -> SignaturesResponse:
        return await self._run_sync(self._swap, request)

    def _swap(self, request: SwapRequest) -> SignaturesResponse:
        if sum(p.amount for p in request.inputs) != sum(
            p.amount for p in request.outputs
        ):
            raise MintError("swap must conserve denomination value")
        self._unique_outputs(request.outputs)
        presentations = [
            PrivatePresentation.from_bytes(bytes.fromhex(p.presentation))
            for p in request.inputs
        ]
        nullifiers = [p.nullifier.format().hex() for p in presentations]
        if len(set(nullifiers)) != len(nullifiers):
            raise MintError("duplicate input nullifier")
        owners = [self._owner(p) for p in request.outputs]
        commitments = [
            PublicKey(compressed=bytes.fromhex(p.b), group="G1")
            for p in request.outputs
        ]
        if any(p.is_infinity() for p in commitments):
            raise MintError("invalid blinded commitment")
        binding = swap_binding(
            [(p.amount, n) for p, n in zip(request.inputs, nullifiers)], request.outputs
        )
        for item, presentation in zip(request.inputs, presentations):
            if not verify_private_presentation(
                self.keys.public[item.amount], presentation, binding
            ):
                raise MintError("invalid private spending proof")
        statements = common_h_statements(
            [
                (self.keys.public[item.amount], p)
                for item, p in zip(request.inputs, presentations)
            ],
            [
                (self.keys.public[item.amount], b)
                for item, b in zip(request.outputs, commitments)
            ],
        )
        if not verify_linear(
            statements,
            LinearProof.from_bytes(bytes.fromhex(request.equality_proof)),
            COMMON_H_DST,
            binding,
        ):
            raise MintError("invalid common HTLC equality proof")
        digest = request_digest(request)
        # Signing depends only on the validated request. Keep it outside the
        # write transaction so unrelated writers do not wait for cryptography.
        signatures = []
        for output, owner, b in zip(request.outputs, owners, commitments):
            u, v = issue_blind(self._key(output.amount), b, owner)
            signatures.append(
                SignatureResponse(
                    amount=output.amount,
                    keyset_id=self.keys.id,
                    u=u.format().hex(),
                    v=v.format().hex(),
                )
            )
        response = SignaturesResponse(signatures=signatures)
        try:
            with self.db.transaction() as conn:
                rows = conn.select("nullifiers", in_={"nullifier": nullifiers})
                if rows:
                    return self._existing_swap(rows, nullifiers, digest)
                # Unique nullifiers arbitrate concurrent spends, including
                # races where neither transaction initially found a row.
                conn.insert_many(
                    "nullifiers",
                    [
                        {
                            "nullifier": nullifier,
                            "state": "SPENT",
                            "kind": "swap",
                            "digest": digest,
                            "response": response.model_dump_json(),
                        }
                        for nullifier in sorted(nullifiers)
                    ],
                )
        except IntegrityError:
            with self.db.read() as conn:
                rows = conn.select("nullifiers", in_={"nullifier": nullifiers})
            return self._existing_swap(rows, nullifiers, digest)
        return response

    @staticmethod
    def _existing_swap(rows, nullifiers, digest):
        if len(rows) == len(nullifiers) and all(
            row["kind"] == "swap" and row["digest"] == digest for row in rows
        ):
            return SignaturesResponse.model_validate_json(rows[0]["response"])
        raise MintError("input token is already spent or reserved", 409)

    async def check(self, nullifiers: list[str]) -> CheckResponse:
        return await self._run_sync(self._check, nullifiers)

    def _check(self, nullifiers: list[str]) -> CheckResponse:
        states = []
        with self.db.read() as conn:
            for n in nullifiers:
                if PublicKey(compressed=bytes.fromhex(n), group="G1").is_infinity():
                    raise MintError("invalid nullifier")
                row = conn.get("nullifiers", columns=("state",), nullifier=n)
                states.append("UNSPENT" if row is None else row["state"])
        return CheckResponse.model_validate({"states": states})

    async def melt_quote(self, request: MeltQuoteRequest) -> MeltQuoteResponse:
        payout_hash, amount = invoice_details(request.request)
        invoice = decode(request.request)
        expiry = invoice.date + invoice.expiry
        if expiry <= int(time.time()):
            raise MintError("payout invoice has expired")
        if expiry > int(time.time()) + 24 * 60 * 60:
            raise MintError("payout invoice expiry exceeds 24 hours")
        fee = self.fee_limit_sat if request.fee_reserve is None else request.fee_reserve
        if fee > self.fee_limit_sat:
            raise MintError("requested fee reserve exceeds the mint routing fee limit")
        response = MeltQuoteResponse(
            quote=os.urandom(32).hex(),
            request=request.request,
            payment_hash=payout_hash,
            amount=amount,
            fee_reserve=fee,
            expiry=expiry,
        )
        await self.db.run_transaction(
            lambda conn: conn.insert(
                "melt_quotes",
                {"quote": response.quote, "payload": response.model_dump_json()},
            )
        )
        return response

    def _melt_quote(self, quote_id: str) -> MeltQuoteResponse:
        with self.db.read() as conn:
            row = conn.get("melt_quotes", columns=("payload",), quote=quote_id)
        if row is None:
            raise MintError("unknown melt quote", 404)
        return MeltQuoteResponse.model_validate_json(row["payload"])

    def _prepare_melt(
        self, request: MeltRequest, quote: MeltQuoteResponse
    ) -> tuple[list[str], OrderedDict]:
        """Synchronous melt proof, binding and change-commitment validation."""
        presentations = [
            Presentation.from_bytes(bytes.fromhex(p.presentation))
            for p in request.inputs
        ]
        nullifiers = [p.nullifier.format().hex() for p in presentations]
        if len(set(nullifiers)) != len(nullifiers):
            raise MintError("duplicate input nullifier")
        binding = melt_binding(
            quote,
            [
                (p.amount, p.backing_amount, p.preimage, n)
                for p, n in zip(request.inputs, nullifiers)
            ],
            request.change,
        )
        groups: OrderedDict[str, dict] = OrderedDict()
        for item, presentation in zip(request.inputs, presentations):
            payment_hash = preimage_hash(item.preimage)
            if presentation.h != htlc_claim_scalar(
                payment_hash, item.backing_amount
            ) or not verify_presentation(
                self.keys.public[item.amount], presentation, binding
            ):
                raise MintError("invalid melt proof, denomination or backing preimage")
            group = groups.setdefault(
                payment_hash,
                {
                    "amount": 0,
                    "backing_amount": item.backing_amount,
                    "preimage": item.preimage,
                },
            )
            if (group["backing_amount"], group["preimage"]) != (
                item.backing_amount,
                item.preimage,
            ):
                raise MintError("inconsistent HTLC backing metadata")
            group["amount"] += item.amount
        self._unique_outputs(request.change)
        slots = set()
        for output in request.change:
            self._owner(output)
            slot = (output.payment_hash, output.amount)
            if slot in slots or output.payment_hash not in groups:
                raise MintError("duplicate or unrelated change output")
            slots.add(slot)
        # Precommit all denominations that a fee outcome could need. This
        # prevents a paid melt from being unrecoverable for lack of change.
        for payment_hash, group in groups.items():
            required = {
                (payment_hash, 1 << i) for i in range(group["amount"].bit_length())
            }
            if not required.issubset(slots):
                raise MintError("incomplete change denomination commitments")
        return nullifiers, groups

    async def melt(self, request: MeltRequest) -> MeltResponse:
        quote = await run_blocking(self._melt_quote, request.quote)
        digest = request_digest(request)
        async with self._melt_locks.hold(quote.quote):
            previous, failed = await self.db.run_read(
                lambda conn: (
                    conn.get("melts", quote=quote.quote),
                    conn.get(
                        "failed_melts", columns=("digest", "expired"), quote=quote.quote
                    ),
                )
            )
            if failed is not None:
                if failed["digest"] != digest:
                    raise MintError(
                        "melt quote already belongs to another request", 409
                    )
                if failed["expired"]:
                    raise MintError("melt payment failed; backing has expired", 410)
                raise MintError("melt payment failed; tokens are unspent", 409)
            if previous is not None:
                if previous["digest"] != digest:
                    raise MintError(
                        "melt quote already belongs to another request", 409
                    )
                if previous["state"] == "PAID":
                    return MeltResponse.model_validate_json(previous["response"])
                if previous["melt_lock"] or not await run_blocking(
                    self._claim_melt, previous
                ):
                    # An executor owns this payment attempt; pollers must not
                    # consult backend status or release inputs behind its back.
                    raise MintError(
                        "melt payment is pending; retry the same request", 409
                    )
                return await self._execute_melt(
                    request,
                    quote,
                    digest,
                    previous["attempt"],
                    bool(previous["submitted"]),
                )
            if quote.expiry <= int(time.time()):
                raise MintError("melt quote has expired", 409)
            if sum(p.amount for p in request.inputs) < quote.amount + quote.fee_reserve:
                raise MintError("inputs do not cover invoice amount and fee reserve")
            nullifiers, groups = await self._run_sync(
                self._prepare_melt, request, quote
            )
            # Hold the involved backing locks in sorted order so reconciliation
            # cannot close or settle a hold underneath this reservation.
            async with self._hold_locks.hold_many(groups):
                rows = await self.db.run_read(
                    lambda conn: {
                        payment_hash: conn.get(
                            "quotes", payment_hash=payment_hash, issued=1
                        )
                        for payment_hash in groups
                    }
                )
                height = await self.backend.get_block_height()
                for payment_hash, row in rows.items():
                    if (
                        row is None
                        or row["amount"] != groups[payment_hash]["backing_amount"]
                    ):
                        raise MintError("unknown issued backing HTLC")
                    invoice = await self._live_invoice(row)
                    if self._within_melt_lockout(invoice, height):
                        raise MintError(
                            "backing HTLC is too close to its settlement cutoff "
                            "for a new melt",
                            409,
                        )
                # Arm the outbox and its executor lock atomically with the
                # reservation: the attempt owns these inputs from this point.
                attempt = uuid.uuid4().hex
                try:
                    await run_blocking(
                        self._reserve_melt,
                        quote,
                        request,
                        digest,
                        attempt,
                        nullifiers,
                        groups,
                    )
                except IntegrityError as exc:
                    occupied = await self.db.run_read(
                        lambda conn: conn.get(
                            "melts", columns=("state",), payout_hash=quote.payment_hash
                        )
                    )
                    if occupied is not None and occupied["state"] == "PAID":
                        raise MintError("payout invoice is already paid", 409) from exc
                    raise MintError(
                        "payout invoice is already reserved or paid", 409
                    ) from exc
            return await self._execute_melt(request, quote, digest, attempt, False)

    def _reserve_melt(self, quote, request, digest, attempt, nullifiers, groups):
        with self.db.transaction() as conn:
            if conn.select("nullifiers", in_={"nullifier": nullifiers}):
                raise MintError("input token is already spent or reserved", 409)
            conn.insert(
                "melts",
                {
                    "quote": quote.quote,
                    "payout_hash": quote.payment_hash,
                    "request": request.model_dump_json(),
                    "digest": digest,
                    "state": "PENDING",
                    "response": None,
                    "attempt": attempt,
                    "melt_lock": attempt,
                    "submitted": 0,
                },
            )
            conn.insert_many(
                "nullifiers",
                [
                    {
                        "nullifier": nullifier,
                        "state": "PENDING",
                        "kind": "melt",
                        "digest": digest,
                        "response": None,
                    }
                    for nullifier in sorted(nullifiers)
                ],
            )
            for payment_hash in sorted(groups):
                group = groups[payment_hash]
                updated = conn.mint_reserve_backing(
                    payment_hash, group["amount"], group["preimage"]
                )
                if updated.rowcount != 1:
                    raise MintError("backing HTLC value is exhausted or reserved", 409)
                conn.insert(
                    "melt_inputs",
                    {
                        "melt": quote.quote,
                        "payment_hash": payment_hash,
                        "amount": group["amount"],
                    },
                )

    def _within_melt_lockout(self, invoice: Invoice, height: int | None) -> bool:
        """Conservative submission lockout: twice the settlement margin."""
        if height is not None:
            if invoice.expiry_height is None:
                raise BackendError("accepted backing HTLC expiry is unavailable")
            return height + 2 * self.settle_margin_blocks >= invoice.expiry_height
        if invoice.hold_expires_at is None:
            raise BackendError("accepted backing HTLC expiry is unavailable")
        return (
            int(time.time()) + 2 * self.settle_margin_seconds >= invoice.hold_expires_at
        )

    def _claim_melt(self, row) -> bool:
        """Arm this process as the executor of an unlocked outbox (PR #8 CAS)."""
        with self.db.transaction() as conn:
            updated = conn.mint_claim(row)
            return updated.rowcount == 1

    def _unlock_melt(self, quote_id: str, attempt: str):
        """Explicit pending: keep the outbox but release the executor lock."""
        with self.db.transaction() as conn:
            conn.mint_unlock(quote_id, attempt)

    async def _execute_melt(
        self,
        request: MeltRequest,
        quote: MeltQuoteResponse,
        digest: str,
        attempt: str,
        submitted: bool,
    ) -> MeltResponse:
        """Drive one payment attempt while holding its durable executor lock."""
        if not submitted:
            try:
                payment = await self.backend.get_payment(quote.payment_hash)
                if payment is None or payment.state == PaymentState.failed:
                    # A FAILED record seen before the first submission can only
                    # come from an older quote for the same payout invoice; the
                    # new attempt may still send (the backend deduplicates).
                    rows = await self.db.run_read(
                        lambda conn: conn.mint_melt_backings(quote.quote)
                    )
                    try:
                        height = await self.backend.get_block_height()
                        cltv_limit = None
                        for row in rows:
                            invoice = await self._live_invoice(row)
                            if self._within_melt_lockout(invoice, height):
                                raise MintError(
                                    "backing HTLC is too close to its settlement "
                                    "cutoff for a new melt",
                                    409,
                                )
                            if height is not None:
                                # The outgoing HTLC must resolve before the
                                # earliest backing cutoff; longer routes refused.
                                if invoice.expiry_height is None:
                                    raise BackendError(
                                        "accepted backing HTLC expiry is unavailable"
                                    )
                                remaining = (
                                    invoice.expiry_height
                                    - height
                                    - self.settle_margin_blocks
                                )
                                cltv_limit = (
                                    remaining
                                    if cltv_limit is None
                                    else min(cltv_limit, remaining)
                                )
                        if quote.expiry <= int(time.time()):
                            raise MintError("melt quote has expired", 409)
                    except MintError:
                        # Never submitted: the reservation can safely be released.
                        await run_blocking(
                            self._release_melt, quote.quote, digest, attempt
                        )
                        raise
                    updated = await self.db.run_transaction(
                        lambda conn: conn.mint_mark_submitted(quote.quote, attempt)
                    )
                    if updated.rowcount != 1:
                        raise BackendError("melt outbox changed before submission")
            except BackendError:
                # Nothing was submitted yet, so the failure is not uncertain:
                # unlock the outbox and let a later retry submit it. Fail-closed
                # locking applies only once the send becomes uncertain (below).
                await run_blocking(self._unlock_melt, quote.quote, attempt)
                raise
            if payment is None or payment.state == PaymentState.failed:
                # Retries of this outbox reuse the same attempt-derived key, so
                # a Spark resume is idempotent; a new quote or attempt or a
                # different invoice derives a fresh key.
                idempotency_key = str(
                    uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        f"{quote.quote}:{attempt}:{quote.request}",
                    )
                )
                # An exception after this send is uncertain: the executor lock
                # stays held with submitted=1 and the outbox fails closed until
                # restart/orphan recovery instead of risking a second send.
                payment = await self.backend.pay_invoice(
                    quote.request,
                    fee_limit_sat=quote.fee_reserve,
                    idempotency_key=idempotency_key,
                    cltv_limit=cltv_limit,
                )
        else:
            payment = await self.backend.get_payment(quote.payment_hash)
            if payment is None:
                # submitted=1 with no tracked payment: the first send may or
                # may not have reached the backend. Reconcile only; never send
                # again, and never release merely because expiry moved.
                payment = Payment(PaymentState.pending)
        if payment.state == PaymentState.pending:
            await run_blocking(self._unlock_melt, quote.quote, attempt)
            raise MintError("melt payment is pending; retry the same request", 409)
        if payment.state == PaymentState.failed:
            if await self._fail_melt(quote.quote, digest, attempt):
                raise MintError("melt payment failed; backing has expired", 410)
            raise MintError("melt payment failed; tokens are unspent", 409)
        if (
            payment.preimage is None
            or hashlib.sha256(payment.preimage).hexdigest() != quote.payment_hash
        ):
            raise BackendError("payout did not return a valid preimage")
        if type(payment.fee_msat) is not int or payment.fee_msat < 0:
            raise BackendError("payout did not return a valid routing fee")
        fee = (payment.fee_msat + 999) // 1000
        if fee > quote.fee_reserve:
            raise BackendError("backend exceeded the authorized routing fee reserve")
        # First appearance of an HTLC in the inputs determines charging order;
        # the spending transcript binds that order. Reconcile only those holds.
        hashes = list(dict.fromkeys(preimage_hash(p.preimage) for p in request.inputs))
        await self.reconcile_holds(hashes)
        try:
            response = await self._run_sync(
                self._finalize_paid, request, quote, digest, attempt, payment, fee
            )
        except MintError as exc:
            if exc.status_code != 503:
                raise
            # The payout succeeded externally but signing admission is busy:
            # leave the durable outbox unlocked for recovery; never convert a
            # paid external payout into a failure or release.
            await run_blocking(self._unlock_melt, quote.quote, attempt)
            raise MintError(
                "melt payment is pending; retry the same request", 409
            ) from None
        await self.reconcile_holds(hashes)
        return response

    def _finalize_paid(
        self,
        request: MeltRequest,
        quote: MeltQuoteResponse,
        digest: str,
        attempt: str,
        payment: Payment,
        fee: int,
    ) -> MeltResponse:
        """Synchronous paid-melt signing and guarded database finalization."""
        if payment.preimage is None:
            raise BackendError("payout did not return a valid preimage")
        slots = {(p.payment_hash, p.amount): p for p in request.change}
        cost = quote.amount + fee
        signatures: list[SignatureResponse] = []
        expired_change = 0
        hashes = list(dict.fromkeys(preimage_hash(p.preimage) for p in request.inputs))
        with self.db.transaction() as conn:
            previous = conn.get("melts", quote=quote.quote, for_update=True)
            if previous is None:
                raise BackendError("melt outbox disappeared during finalization")
            if previous["state"] == "PAID":
                if previous["digest"] == digest:
                    return MeltResponse.model_validate_json(previous["response"])
                raise BackendError("melt outbox is owned by another request")
            if (
                previous["digest"] != digest
                or previous["attempt"] != attempt
                or previous["melt_lock"] != attempt
            ):
                raise BackendError("melt outbox is owned by another attempt")
            conn.select(
                "quotes",
                columns=("payment_hash",),
                in_={"payment_hash": hashes},
                order_by="payment_hash",
                for_update=True,
            )
            for payment_hash in hashes:
                entry = conn.mint_melt_input(quote.quote, payment_hash)
                if entry is None:
                    raise BackendError("melt input disappeared during finalization")
                charged = min(cost, entry["input_amount"])
                cost -= charged
                change = entry["input_amount"] - charged
                if entry["closed"]:
                    expired_change += change
                else:
                    signatures.extend(
                        self._sign(
                            slots[(payment_hash, amount)],
                            int(entry["h"], 16),
                            payment_hash,
                        )
                        for amount in denominations(change)
                    )
                updated = conn.mint_finalize_backing(
                    payment_hash, charged, entry["input_amount"]
                )
                if updated.rowcount != 1:
                    raise BackendError(
                        "backing accounting conflict during finalization"
                    )
            if cost:
                raise BackendError("melt outbox does not cover the confirmed payment")
            response = MeltResponse(
                amount=quote.amount,
                fee=fee,
                fee_msat=payment.fee_msat,
                payout_hash=quote.payment_hash,
                payout_preimage=payment.preimage.hex(),
                change=signatures,
                expired_change=expired_change,
            )
            updated = conn.mint_mark_paid(
                quote.quote, attempt, response.model_dump_json()
            )
            if updated.rowcount != 1:
                raise BackendError("melt outbox changed during finalization")
            conn.mint_spend_nullifiers(digest, response.model_dump_json())
        return response

    async def _fail_melt(self, quote_id: str, digest: str, attempt: str) -> bool:
        """Release a definite failure; terminal once any backing is closed.

        Returns True when an involved backing HTLC is already closed or past
        its cutoff: the reservation is released, but the credentials must
        never be presented as reusable again (failed_melts.expired=1).

        All involved hold locks are held across reconciliation, the liveness
        read and the release, so no settlement can land in between. If backing
        liveness cannot be determined, the outbox is kept (unlocked — the
        payout is already definitively failed) for a later retry instead of
        falsely reporting an ordinary unspent failure.
        """
        hashes = await self.db.run_read(
            lambda conn: [
                row[0]
                for row in conn.select(
                    "melt_inputs", columns=("payment_hash",), melt=quote_id
                )
            ]
        )
        async with self._hold_locks.hold_many(hashes):
            unavailable = False
            for payment_hash in hashes:
                try:
                    await self._reconcile_hold_locked(payment_hash)
                except Exception:
                    unavailable = True
            if unavailable:
                await run_blocking(self._unlock_melt, quote_id, attempt)
                raise BackendError(
                    "backing liveness unavailable; retry to finish the failed melt"
                )
            expired = await self.db.run_read(
                lambda conn: any(
                    row["closed"]
                    for row in conn.select(
                        "quotes", columns=("closed",), in_={"payment_hash": hashes}
                    )
                )
            )
            await run_blocking(
                self._release_melt,
                quote_id,
                digest,
                attempt,
                payment_failed=True,
                expired=expired,
            )
            return expired

    def _release_melt(
        self,
        quote_id: str,
        digest: str,
        attempt: str,
        payment_failed: bool = False,
        expired: bool = False,
    ):
        """Compare-and-set release; paid outboxes are terminal, never released."""
        with self.db.transaction() as conn:
            row = conn.get("melts", quote=quote_id, for_update=True)
            if row is None:
                return
            if row["state"] != "PENDING":
                raise BackendError("paid melt outbox is terminal; cannot release")
            if (
                row["digest"] != digest
                or row["attempt"] != attempt
                or row["melt_lock"] != attempt
            ):
                raise BackendError("melt outbox is owned by another attempt")
            if payment_failed:
                conn.insert(
                    "failed_melts",
                    {
                        "quote": quote_id,
                        "digest": digest,
                        "expired": int(expired),
                    },
                    ignore=True,
                )
            inputs = conn.select("melt_inputs", melt=quote_id)
            conn.select(
                "quotes",
                columns=("payment_hash",),
                in_={"payment_hash": [item["payment_hash"] for item in inputs]},
                order_by="payment_hash",
                for_update=True,
            )
            for input_row in inputs:
                updated = conn.mint_release_backing(
                    input_row["payment_hash"], input_row["amount"]
                )
                if updated.rowcount != 1:
                    raise BackendError("backing reservation accounting conflict")
            conn.delete("nullifiers", kind="melt", digest=digest, state="PENDING")
            conn.delete("melts", quote=quote_id, state="PENDING")

    async def reconcile_holds(self, payment_hashes: Iterable[str] | None = None):
        """Close on full consumption (including fees) or the published cutoff.

        This is terminal claim accounting, never a post-settlement user balance.
        A known preimage is retained even after a definite failed payout.
        Rows are reconciled concurrently, each under its own payment-hash lock;
        one failing hold never blocks the others.
        """
        hashes = None
        if payment_hashes is not None:
            hashes = sorted(set(payment_hashes))
            if not hashes:
                return
        rows = await self.db.run_read(lambda conn: conn.mint_reconcilable(hashes))
        semaphore = asyncio.Semaphore(8)

        async def reconcile(payment_hash: str):
            async with semaphore:
                try:
                    await self._reconcile_hold(payment_hash)
                except Exception:
                    # One malformed or unreachable hold must not stop others.
                    return

        await asyncio.gather(*(reconcile(row[0]) for row in rows))

    async def _reconcile_hold(self, payment_hash: str):
        async with self._hold_locks.hold(payment_hash):
            await self._reconcile_hold_locked(payment_hash)

    async def _reconcile_hold_locked(self, payment_hash: str):
        """Reconcile one hold; caller must hold its payment-hash lock.

        Backend or data failures propagate so callers can distinguish "not
        due" from "liveness unknown"; the full-scan wrapper isolates them.
        """
        row = await self.db.run_read(
            lambda conn: conn.get("quotes", payment_hash=payment_hash)
        )
        if (
            row is None
            or not row["issued"]
            or row["preimage"] is None
            or row["closed"] >= 2
        ):
            return
        invoice = await self.backend.get_invoice(payment_hash)
        self._validate_invoice(invoice, payment_hash, row["amount"])
        terminal = invoice.state in (
            InvoiceState.settled,
            InvoiceState.canceled,
        )
        height = None if terminal else await self.backend.get_block_height()
        full = row["redeemed"] == row["amount"] and row["reserved"] == 0
        # closed=1 means settlement is in progress and is retried here.
        due = (
            terminal
            or row["closed"]
            or full
            or not self._before_deadline(invoice, height)
        )
        if not due:
            return
        if not row["closed"]:
            updated = await self.db.run_transaction(
                lambda conn: conn.update(
                    "quotes", {"closed": 1}, payment_hash=payment_hash, closed=0
                )
            )
            if updated.rowcount != 1:
                return
        if invoice.state == InvoiceState.accepted:
            await self.backend.settle_invoice(bytes.fromhex(row["preimage"]))
            invoice = await self.backend.get_invoice(payment_hash)
            self._validate_invoice(invoice, payment_hash, row["amount"])
        if invoice.state in (InvoiceState.settled, InvoiceState.canceled):
            await self.db.run_transaction(
                lambda conn: conn.update(
                    "quotes", {"closed": 2}, payment_hash=payment_hash, closed=1
                )
            )

    def _prune_melt_quotes(self):
        """Delete expired quotes with no recovery value, at most every 5 minutes.

        Quotes with a pending or paid melt or a failed tombstone are retained
        for pending, paid, failed and exact-retry recovery.
        """
        now = time.time()
        if now - self._last_prune < 300:
            return
        self._last_prune = now
        with self.db.transaction() as conn:
            conn.mint_prune_melt_quotes(int(now))

    async def _prune_mint_quotes(self):
        """Prune expired unpaid mint quotes, at most every five minutes.

        Backend uncertainty and every recovery-bearing state retain the quote.
        """
        now = time.time()
        if now - self._last_mint_prune < 300:
            return
        self._last_mint_prune = now
        rows = await self.db.run_read(lambda conn: conn.mint_prunable_quotes(int(now)))
        semaphore = asyncio.Semaphore(8)

        async def prune(payment_hash: str):
            async with semaphore:
                async with self._hold_locks.hold(payment_hash):
                    try:
                        rows = await self.db.run_read(
                            lambda conn: conn.mint_prunable_quotes(
                                int(now), payment_hash=payment_hash
                            )
                        )
                        if not rows or not await self.backend.prune_invoice(
                            payment_hash
                        ):
                            return
                        await self.db.run_transaction(
                            lambda conn: conn.mint_delete_prunable(
                                int(now), payment_hash
                            )
                        )
                    except Exception:
                        # A missing or unreachable backend must not stop other rows;
                        # cancellation (BaseException) still propagates.
                        return

        await asyncio.gather(*(prune(row[0]) for row in rows))

    async def resume_pending_melts(self):
        await self.reconcile_holds()
        await self._prune_mint_quotes()
        await run_blocking(self._prune_melt_quotes)
        rows = await self.db.run_read(
            lambda conn: conn.select(
                "melts", columns=("request",), state="PENDING", melt_lock=""
            )
        )
        for row in rows:
            try:
                await self.melt(MeltRequest.model_validate_json(row["request"]))
            except Exception:
                # One malformed or failing row must not stop later rows;
                # task cancellation (BaseException) still propagates.
                continue
