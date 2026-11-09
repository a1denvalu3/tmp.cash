"""Disposable, loopback-only Python mint for browser/protocol interoperability tests."""

import argparse
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, urlencode

import httpx
import jwt
import uvicorn
from bolt11 import Tag, TagChar, Tags, decode, encode
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tmp_cash.api import create_app
from tmp_cash.cloud import ENDPOINTS, CloudConfig, Provider, create_cloud_app
from tmp_cash.lightning import FakeBackend
from tmp_cash.mint import Mint


class Funding(BaseModel):
    payment_hash: str


class Receiver(BaseModel):
    amount: int
    metadata: str | None = None


class Quote(BaseModel):
    quote: str


class PaymentControl(BaseModel):
    payment_hash: str
    state: Literal["IN_FLIGHT", "FAILED"] | None


class FeePolicy(BaseModel):
    fee_limit_sat: int = Field(ge=0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3339)
    parser.add_argument("--fee-limit-sat", type=int, default=2)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="tmp-cash-web-test-") as directory:
        path = Path(directory)
        backend = FakeBackend(
            path / "fake.sqlite3",
            fee_msat=1500,
            fee_limit_sat=args.fee_limit_sat,
        )
        mint = Mint(path / "mint.sqlite3", bytes.fromhex("42" * 32), backend)
        app = create_app(mint)
        # The browser follows a real authorization-code redirect. Only the
        # external identity provider is simulated; sessions, signatures, backup
        # storage and all wallet cryptography run through production code.
        origin = os.environ.get("WALLET_E2E_ORIGIN", "http://127.0.0.1:5173")
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key()))
        jwk.update(kid="browser-test-key", alg="RS256")
        codes = {}

        def identity_provider(request):
            if request.url.path.endswith("certs"):
                return httpx.Response(200, json={"keys": [jwk]})
            code = parse_qs(request.content.decode())["code"][0]
            return httpx.Response(
                200,
                json={
                    "id_token": jwt.encode(
                        codes.pop(code),
                        private,
                        algorithm="RS256",
                        headers={"kid": "browser-test-key"},
                    )
                },
            )

        cloud = create_cloud_app(
            CloudConfig(
                origin, {"google": Provider("browser-test-client", "test-secret")}
            ),
            path / "cloud.sqlite3",
            transport=httpx.MockTransport(identity_provider),
        )
        app.mount("/api/cloud", cloud)
        ENDPOINTS["google"] = (
            f"http://127.0.0.1:{args.port}/test/oidc",
            *ENDPOINTS["google"][1:],
        )

        @app.get("/test/oidc")
        async def authorize(request: Request):
            code = os.urandom(32).hex()
            now = int(time.time())
            codes[code] = {
                "iss": "https://accounts.google.com",
                "aud": "browser-test-client",
                "sub": "browser-test-user",
                "nonce": request.query_params["nonce"],
                "iat": now,
                "exp": now + 300,
                "email": "wallet-test@example.com",
            }
            return RedirectResponse(
                origin
                + "/api/cloud/callback/google?"
                + urlencode({"code": code, "state": request.query_params["state"]})
            )

        @app.get("/test/health")
        async def health():
            return {"test_fixture": True}

        @app.post("/test/accept")
        async def accept(request: Funding):
            await backend.accept(request.payment_hash)
            return {"accepted": True}

        @app.post("/test/settle")
        async def settle(request: Funding):
            # Simulate settlement/expiry without exposing a production control API.
            with backend.db.transaction() as conn:
                conn.execute(
                    "UPDATE invoices SET state='SETTLED' WHERE payment_hash=?",
                    (request.payment_hash,),
                )
            return {"settled": True}

        @app.post("/test/receiver")
        async def receiver(request: Receiver):
            invoice = backend.receiver_invoice(request.amount, os.urandom(32))
            if request.metadata is not None:
                decoded = decode(invoice)
                decoded.tags = Tags(
                    [tag for tag in decoded.tags if tag.char != TagChar.description]
                    + [
                        Tag(
                            TagChar.description_hash,
                            hashlib.sha256(request.metadata.encode()).hexdigest(),
                        )
                    ]
                )
                hashed = encode(decoded, private_key="11" * 32)
                with backend.db.transaction() as conn:
                    conn.execute(
                        "UPDATE receivers SET request=? WHERE request=?",
                        (hashed, invoice),
                    )
                invoice = hashed
            return {"request": invoice}

        @app.post("/test/expire-melt-quote")
        async def expire_melt_quote(request: Quote):
            quote = mint._melt_quote(request.quote).model_copy(update={"expiry": 0})
            with mint.db.transaction() as conn:
                conn.execute(
                    "UPDATE melt_quotes SET payload=? WHERE quote=?",
                    (quote.model_dump_json(), quote.quote),
                )
            return {"expired": True}

        @app.post("/test/payment-state")
        async def payment_state(request: PaymentControl):
            with backend.db.transaction() as conn:
                if request.state is None:
                    conn.execute(
                        "DELETE FROM payments WHERE payment_hash=?",
                        (request.payment_hash,),
                    )
                else:
                    conn.execute(
                        "INSERT OR REPLACE INTO payments VALUES (?,?,NULL,0)",
                        (request.payment_hash, request.state),
                    )
            return {"updated": True}

        @app.post("/test/fee-policy")
        async def fee_policy(request: FeePolicy):
            mint.fee_limit_sat = request.fee_limit_sat
            backend.fee_limit_sat = request.fee_limit_sat
            return {"configured": True}

        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="error")


if __name__ == "__main__":
    main()
