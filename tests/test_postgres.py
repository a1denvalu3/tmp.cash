import asyncio
import os
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
import sqlalchemy as sa
from conftest import PREIMAGE, SEED
from fastapi.testclient import TestClient
from test_spark import MNEMONIC, SdkStub, held, receiver

from tmp_cash.api import create_app
from tmp_cash.client import Client, ClientError
from tmp_cash.crud import FAKE, MINT, SPARK, WALLET
from tmp_cash.lightning import FakeBackend
from tmp_cash.mint import Mint
from tmp_cash.models import InvoiceState, QuoteRequest, preimage_hash
from tmp_cash.sparkl2 import SparkBackend
from tmp_cash.wallet import Wallet

pytestmark = pytest.mark.postgres


@pytest.fixture
def postgres_url():
    url = os.environ.get("TMP_CASH_TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TMP_CASH_TEST_POSTGRES_URL is not configured")
    engine = sa.create_engine(url.replace("postgresql://", "postgresql+psycopg://", 1))
    with engine.begin() as connection:
        for schema in (MINT, FAKE, SPARK, WALLET):
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
    engine.dispose()
    return url


def test_postgres_shared_server_protocol_wallet_and_pruning(postgres_url):
    backend = FakeBackend(postgres_url)
    mint = Mint(postgres_url, SEED, backend)
    wallet = Wallet(postgres_url)
    with TestClient(create_app(mint, recovery=False)) as http:
        client = Client("http://testserver", http)
        quote = client.quote(16, preimage_hash(PREIMAGE.hex()))
        asyncio.run(backend.accept(quote.payment_hash))
        mint_operation = client.prepare_mint(quote.quote, PREIMAGE.hex())
        wallet.save(mint_operation)
        token = wallet.retry(client, mint_operation.id)
        assert token.amount == 16

        swap_operation = client.prepare_swap(token, [8, 8])
        wallet.save(swap_operation)
        swapped = wallet.retry(client, swap_operation.id)
        assert swapped.amount == 16

        payout = backend.receiver_invoice(8, os.urandom(32))
        melt_operation = client.prepare_melt(swapped, payout, fee_reserve=0)
        wallet.save(melt_operation)
        receipt = wallet.retry(client, melt_operation.id)
        assert receipt.amount == 8
        assert wallet.pending() == []

        change = client.melt_change(melt_operation, receipt)
        with pytest.raises(ClientError, match="already paid"):
            client.finish_melt(client.prepare_melt(change, payout, fee_reserve=0))

        past = int(time.time()) - 1
        bare_melt = client.melt_quote(backend.receiver_invoice(1, os.urandom(32)))
        with mint.db.transaction() as db:
            for melt_quote in (bare_melt, melt_operation.quote):
                payload = melt_quote.model_copy(update={"expiry": past})
                db.update(
                    "melt_quotes",
                    {"payload": payload.model_dump_json()},
                    quote=melt_quote.quote,
                )
        mint._prune_melt_quotes()
        with mint.db.read() as db:
            assert db.get("melt_quotes", quote=bare_melt.quote) is None
            assert db.get("melt_quotes", quote=melt_operation.quote.quote) is not None

        expired = client.quote(16, preimage_hash(os.urandom(32).hex()), expiry=60)
        with mint.db.transaction() as db:
            db.update("quotes", {"expiry": past}, quote=expired.quote)
        with backend.db.transaction() as db:
            db.update("invoices", {"expiry": past}, payment_hash=expired.payment_hash)
        asyncio.run(mint._prune_mint_quotes())
        with mint.db.read() as db:
            assert db.get("quotes", quote=expired.quote) is None
        with backend.db.read() as db:
            assert db.get("invoices", payment_hash=expired.payment_hash) is None


def test_postgres_concurrent_duplicate_quotes(postgres_url):
    backend = FakeBackend(postgres_url)
    mint = Mint(postgres_url, SEED, backend)
    request = QuoteRequest(amount=16, payment_hash=preimage_hash(PREIMAGE.hex()))

    def create_quote(_):
        return asyncio.run(mint.quote(request))

    with ThreadPoolExecutor(max_workers=6) as executor:
        responses = list(executor.map(create_quote, range(12)))
    assert len({response.quote for response in responses}) == 1
    assert asyncio.run(backend.get_invoice(request.payment_hash)).amount == 16


def test_postgres_spark_invoice_and_payment_persistence(postgres_url, tmp_path):
    async def scenario():
        backend = SparkBackend(postgres_url, MNEMONIC, storage_dir=tmp_path)
        sdk = SdkStub()
        backend.sdk = sdk
        _, payment_hash, _ = await held((backend, sdk), amount=16)
        assert (await backend.get_invoice(payment_hash)).state == InvoiceState.accepted

        request, payout_hash, _ = receiver(sdk, amount=8)
        payment = await backend.pay_invoice(request, 0, idempotency_key=str(uuid4()))
        assert payment.state.value == "SUCCEEDED"

        reopened = SparkBackend(postgres_url, MNEMONIC, storage_dir=tmp_path)
        reopened.sdk = sdk
        recovered = await reopened.get_payment(payout_hash)
        assert recovered.state == payment.state
        assert recovered.preimage == payment.preimage

    asyncio.run(scenario())
