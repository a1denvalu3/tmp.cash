import asyncio
import os
import threading
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
from tmp_cash.crud import FAKE, MINT, SPARK, WALLET, Crud
from tmp_cash.db import Database, MintDatabaseInUse, MintError
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


async def test_postgres_independent_writes_overlap_but_same_row_waits(postgres_url):
    db = FakeBackend(postgres_url).db
    with db.transaction() as tx:
        tx.set_metadata("first", "0")
        tx.set_metadata("second", "0")
    started = threading.Event()
    release = threading.Event()

    def hold_row(tx):
        tx.update("metadata", {"value": "1"}, key="first")
        started.set()
        assert release.wait(5)

    held = asyncio.create_task(db.run_transaction(hold_row))
    same = None
    try:
        assert await asyncio.to_thread(started.wait, 2)
        same = asyncio.create_task(
            db.run_transaction(
                lambda tx: tx.update("metadata", {"value": "2"}, key="first")
            )
        )
        await asyncio.wait_for(
            db.run_transaction(
                lambda tx: tx.update("metadata", {"value": "1"}, key="second")
            ),
            2,
        )
        assert not held.done() and not same.done()
    finally:
        release.set()
        await asyncio.gather(*(task for task in (held, same) if task is not None))
    assert await db.run_read(lambda tx: tx.metadata_value("first")) == "2"
    assert await db.run_read(lambda tx: tx.metadata_value("second")) == "1"


def test_postgres_reuses_connections(postgres_url):
    db = FakeBackend(postgres_url).db
    backends = []
    for _ in range(5):
        with db.read() as tx:
            backends.append(
                tx.connection.execute(sa.text("SELECT pg_backend_pid()")).scalar_one()
            )
    assert len(set(backends)) == 1
    assert isinstance(db.engine.pool, sa.pool.QueuePool)


def test_postgres_singleton_cannot_be_bypassed_by_url_options(postgres_url):
    mint = Mint(postgres_url, SEED, FakeBackend(postgres_url))
    separator = "&" if "?" in postgres_url else "?"
    alias = Database(postgres_url + separator + "application_name=another-mint", MINT)
    try:
        assert alias._singleton_key == mint.db._singleton_key
        with pytest.raises(MintDatabaseInUse):
            alias.acquire_singleton()
    finally:
        alias.engine.dispose()


@pytest.mark.parametrize("kind", ["mint", "swap"])
def test_postgres_wallet_preserves_one_recovery_request_per_source(postgres_url, kind):
    backend = FakeBackend(postgres_url)
    mint = Mint(postgres_url, SEED, backend)
    wallet = Wallet(postgres_url)
    with TestClient(create_app(mint, recovery=False)) as http:
        client = Client("http://testserver", http)
        quote = client.quote(16, preimage_hash(PREIMAGE.hex()))
        asyncio.run(backend.accept(quote.payment_hash))
        if kind == "mint":
            operations = [
                client.prepare_mint(quote.quote, PREIMAGE.hex()) for _ in range(2)
            ]
        else:
            operation = client.prepare_mint(quote.quote, PREIMAGE.hex())
            wallet.save(operation)
            token = wallet.retry(client, operation.id)
            operations = [client.prepare_swap(token, [8, 8]) for _ in range(2)]
    barrier = threading.Barrier(2)

    def save(operation):
        barrier.wait(timeout=5)
        try:
            wallet.save(operation)
            return True
        except ValueError:
            return False

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sum(executor.map(save, operations)) == 1
    assert len(wallet.pending()) == 1


@pytest.mark.parametrize("identical", [True, False])
def test_postgres_concurrent_swaps_resolve_conflicts(
    postgres_url, monkeypatch, identical
):
    backend = FakeBackend(postgres_url)
    mint = Mint(postgres_url, SEED, backend)
    with TestClient(create_app(mint, recovery=False)) as http:
        client = Client("http://testserver", http)
        quote = client.quote(16, preimage_hash(PREIMAGE.hex()))
        asyncio.run(backend.accept(quote.payment_hash))
        token = client.finish_mint(client.prepare_mint(quote.quote, PREIMAGE.hex()))
        first = client.prepare_swap(token, [8, 8])
        second = first if identical else client.prepare_swap(token, [8, 8])
    barrier = threading.Barrier(2)
    local = threading.local()
    select = Crud.select

    def synchronized_select(tx, table_name, **kwargs):
        rows = select(tx, table_name, **kwargs)
        if table_name == "nullifiers" and not getattr(local, "checked", False):
            local.checked = True
            assert rows == []
            barrier.wait(timeout=5)
        return rows

    monkeypatch.setattr(Crud, "select", synchronized_select)

    def swap(operation):
        try:
            return mint._swap(operation.request)
        except MintError as exc:
            return exc

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(swap, (first, second)))
    if identical:
        assert results[0] == results[1]
        assert not isinstance(results[0], Exception)
    else:
        failures = [result for result in results if isinstance(result, MintError)]
        assert len(failures) == 1 and failures[0].status_code == 409
    with mint.db.read() as tx:
        spent = select(tx, "nullifiers")
        assert len(spent) == len(token.proofs)
        assert all(row["state"] == "SPENT" for row in spent)


def test_postgres_concurrent_backing_reservations_do_not_overspend(postgres_url):
    backend = FakeBackend(postgres_url)
    mint = Mint(postgres_url, SEED, backend)
    quote = asyncio.run(
        mint.quote(QuoteRequest(amount=8, payment_hash=preimage_hash(PREIMAGE.hex())))
    )

    def reserve(_):
        with mint.db.transaction() as tx:
            return tx.mint_reserve_backing(
                quote.payment_hash, 1, PREIMAGE.hex()
            ).rowcount

    with ThreadPoolExecutor(max_workers=8) as executor:
        assert sum(executor.map(reserve, range(16))) == 8
    with mint.db.read() as tx:
        assert tx.get("quotes", quote=quote.quote)["reserved"] == 8
