import asyncio
import threading

import httpx
import pytest

from tmp_cash.concurrency import run_blocking


async def test_database_connection_wait_does_not_block_http(service, monkeypatch):
    token, _ = await asyncio.to_thread(service.fund, 16)
    with service.mint.db.read() as db:
        quote = db.get("quotes", payment_hash=token.payment_hash)["quote"]
    started = threading.Event()
    release = threading.Event()
    connect = service.mint.db.connect

    def blocked_connect():
        started.set()
        assert release.wait(5)
        return connect()

    monkeypatch.setattr(service.mint.db, "connect", blocked_connect)
    transport = httpx.ASGITransport(app=service.client.http.app)
    # Ensure an accidental event-loop block fails instead of hanging the test.
    watchdog = threading.Timer(3, release.set)
    watchdog.start()
    try:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver"
        ) as client:
            request = asyncio.create_task(client.get(f"/v1/mint/quote/bolt11/{quote}"))
            try:
                assert await asyncio.to_thread(started.wait, 2)
                assert not request.done()
                response = await asyncio.wait_for(client.get("/v1/info"), 1)
                assert response.status_code == 200
            finally:
                release.set()
                assert (await request).status_code == 200
    finally:
        release.set()
        watchdog.cancel()


async def test_cancelled_transaction_finishes_before_releasing_caller(service):
    started = threading.Event()
    release = threading.Event()

    def write(db):
        db.set_metadata("cancellation-test", "committed", replace=True)
        started.set()
        assert release.wait(5)

    task = asyncio.create_task(service.mint.db.run_transaction(write))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    value = await service.mint.db.run_read(
        lambda db: db.metadata_value("cancellation-test")
    )
    assert value == "committed"


async def test_cancelled_crypto_keeps_admission_until_worker_finishes(service):
    started = threading.Event()
    release = threading.Event()

    def work():
        started.set()
        assert release.wait(5)

    service.mint._sync_work = asyncio.Semaphore(1)
    task = asyncio.create_task(service.mint._run_sync(work))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        assert service.mint._sync_work.locked()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert not service.mint._sync_work.locked()


async def test_cancelled_worker_error_preserves_cancellation():
    started = threading.Event()
    release = threading.Event()

    def fail():
        started.set()
        assert release.wait(5)
        raise ValueError("worker failed")

    task = asyncio.create_task(run_blocking(fail))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_worker_cancellation_does_not_spin():
    def cancel():
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(run_blocking(cancel), 1)
