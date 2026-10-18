import asyncio
import os
import time

import pytest
from conftest import SEED
from fastapi.testclient import TestClient

from tmp_cash.api import create_app
from tmp_cash.client import Client
from tmp_cash.lightning import FakeBackend
from tmp_cash.mint import Mint
from tmp_cash.models import InvoiceState, preimage_hash


def test_default_keeps_manual_funding_and_auto_mode_can_accept_existing_invoice(
    tmp_path,
):
    path = tmp_path / "fake.sqlite3"
    backend = FakeBackend(path)
    payment_hash = preimage_hash(os.urandom(32).hex())
    invoice = asyncio.run(backend.create_hold_invoice(100, payment_hash, 3600))
    assert invoice.state == InvoiceState.open
    assert invoice.amount_paid == 0
    automatic = FakeBackend(path, auto_accept=True)
    invoice = asyncio.run(automatic.get_invoice(payment_hash))
    assert invoice.state == InvoiceState.accepted
    assert invoice.amount_paid == 100
    # The funding decision is persisted and remains held with auto mode off.
    assert (
        asyncio.run(FakeBackend(path).get_invoice(payment_hash)).state
        == InvoiceState.accepted
    )


@pytest.mark.parametrize("terminal", ["canceled", "expired", "settled"])
def test_auto_accept_preserves_terminal_invoice_states(tmp_path, terminal):
    backend = FakeBackend(tmp_path / "fake.sqlite3", auto_accept=True)
    preimage = os.urandom(32).hex()
    payment_hash = preimage_hash(preimage)
    assert (
        asyncio.run(backend.create_hold_invoice(100, payment_hash, 3600)).state
        == InvoiceState.accepted
    )
    if terminal == "canceled":
        asyncio.run(backend.cancel(payment_hash))
    elif terminal == "settled":
        asyncio.run(backend.settle_invoice(bytes.fromhex(preimage)))
    else:
        # Include a previously OPEN invoice expiring before its first auto check.
        with backend.db.transaction() as db:
            db.execute(
                "UPDATE invoices SET state='OPEN',amount_paid=0,expiry=? WHERE payment_hash=?",
                (int(time.time()) - 1, payment_hash),
            )
    invoice = asyncio.run(backend.get_invoice(payment_hash))
    assert invoice.state == (
        InvoiceState.settled if terminal == "settled" else InvoiceState.canceled
    )


def test_auto_accept_mints_and_pays_through_the_http_api_without_manual_funding(
    tmp_path,
):
    backend = FakeBackend(tmp_path / "fake.sqlite3", auto_accept=True)
    mint = Mint(tmp_path / "mint.sqlite3", SEED, backend)
    with TestClient(create_app(mint, recovery=False)) as http:
        client = Client("http://testserver", http)
        preimage = os.urandom(32).hex()
        quote = client.quote(100, preimage_hash(preimage))
        assert quote.state == InvoiceState.accepted
        token = client.finish_mint(client.prepare_mint(quote.quote, preimage))
        assert token.amount == 100
        invoice = backend.receiver_invoice(10, os.urandom(32))
        operation = client.prepare_melt(token, invoice, fee_reserve=0)
        receipt = client.finish_melt(operation)
        assert receipt.amount == 10
        change = client.melt_change(operation, receipt)
        assert change is not None and change.amount == 90
        assert (
            asyncio.run(backend.get_invoice(quote.payment_hash)).state
            == InvoiceState.accepted
        )


@pytest.mark.parametrize("value", ["true", "false", 1, None])
def test_backend_requires_a_boolean_auto_accept_setting(tmp_path, value):
    with pytest.raises(ValueError, match="boolean"):
        FakeBackend(tmp_path / "fake.sqlite3", auto_accept=value)
