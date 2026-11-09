from __future__ import annotations

import os
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.engine import Connection, CursorResult
from sqlalchemy.sql import ColumnElement

MINT = "tmp_cash_mint"
FAKE = "tmp_cash_fake"
SPARK = "tmp_cash_spark"
WALLET = "tmp_cash_wallet"


def _metadata(schema: str) -> sa.MetaData:
    return sa.MetaData()


def _metadata_table(metadata: sa.MetaData, schema: str) -> sa.Table:
    return sa.Table(
        "metadata",
        metadata,
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("value", sa.Text, nullable=False),
        schema=schema,
    )


MINT_METADATA = _metadata(MINT)
MINT_METADATA_TABLE = _metadata_table(MINT_METADATA, MINT)
MINT_QUOTES = sa.Table(
    "quotes",
    MINT_METADATA,
    sa.Column("quote", sa.Text, primary_key=True),
    sa.Column("payment_hash", sa.Text, nullable=False, unique=True),
    sa.Column("amount", sa.BigInteger, nullable=False),
    sa.Column("h", sa.Text, nullable=False, unique=True),
    sa.Column("request", sa.Text, nullable=False),
    sa.Column("expiry", sa.BigInteger, nullable=False),
    sa.Column("issued", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("digest", sa.Text),
    sa.Column("response", sa.Text),
    sa.Column("preimage", sa.Text),
    sa.Column("redeemed", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("reserved", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("closed", sa.BigInteger, nullable=False, server_default="0"),
    schema=MINT,
)
MINT_NULLIFIERS = sa.Table(
    "nullifiers",
    MINT_METADATA,
    sa.Column("nullifier", sa.Text, primary_key=True),
    sa.Column("state", sa.Text, nullable=False),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("digest", sa.Text, nullable=False),
    sa.Column("response", sa.Text),
    schema=MINT,
)
MINT_MELT_QUOTES = sa.Table(
    "melt_quotes",
    MINT_METADATA,
    sa.Column("quote", sa.Text, primary_key=True),
    sa.Column("payload", sa.Text, nullable=False),
    schema=MINT,
)
MINT_MELTS = sa.Table(
    "melts",
    MINT_METADATA,
    sa.Column(
        "quote",
        sa.Text,
        sa.ForeignKey(f"{MINT}.melt_quotes.quote"),
        primary_key=True,
    ),
    sa.Column("payout_hash", sa.Text, nullable=False, unique=True),
    sa.Column("request", sa.Text, nullable=False),
    sa.Column("digest", sa.Text, nullable=False),
    sa.Column("state", sa.Text, nullable=False),
    sa.Column("response", sa.Text),
    sa.Column("attempt", sa.Text, nullable=False, server_default="''"),
    sa.Column("melt_lock", sa.Text, nullable=False, server_default="''"),
    sa.Column("submitted", sa.BigInteger, nullable=False, server_default="1"),
    schema=MINT,
)
MINT_FAILED_MELTS = sa.Table(
    "failed_melts",
    MINT_METADATA,
    sa.Column(
        "quote",
        sa.Text,
        sa.ForeignKey(f"{MINT}.melt_quotes.quote"),
        primary_key=True,
    ),
    sa.Column("digest", sa.Text, nullable=False),
    sa.Column("expired", sa.BigInteger, nullable=False, server_default="0"),
    schema=MINT,
)
MINT_MELT_INPUTS = sa.Table(
    "melt_inputs",
    MINT_METADATA,
    sa.Column(
        "melt",
        sa.Text,
        sa.ForeignKey(f"{MINT}.melts.quote", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column(
        "payment_hash",
        sa.Text,
        sa.ForeignKey(f"{MINT}.quotes.payment_hash"),
        primary_key=True,
    ),
    sa.Column("amount", sa.BigInteger, nullable=False),
    schema=MINT,
)

FAKE_METADATA = _metadata(FAKE)
FAKE_METADATA_TABLE = _metadata_table(FAKE_METADATA, FAKE)
FAKE_INVOICES = sa.Table(
    "invoices",
    FAKE_METADATA,
    sa.Column("payment_hash", sa.Text, primary_key=True),
    sa.Column("amount", sa.BigInteger, nullable=False),
    sa.Column("request", sa.Text, nullable=False),
    sa.Column("expiry", sa.BigInteger, nullable=False),
    sa.Column("state", sa.Text, nullable=False),
    sa.Column("amount_paid", sa.BigInteger, nullable=False, server_default="0"),
    schema=FAKE,
)
FAKE_RECEIVERS = sa.Table(
    "receivers",
    FAKE_METADATA,
    sa.Column("request", sa.Text, primary_key=True),
    sa.Column("payment_hash", sa.Text, nullable=False),
    sa.Column("amount", sa.BigInteger, nullable=False),
    sa.Column("preimage", sa.LargeBinary, nullable=False),
    schema=FAKE,
)
FAKE_PAYMENTS = sa.Table(
    "payments",
    FAKE_METADATA,
    sa.Column("payment_hash", sa.Text, primary_key=True),
    sa.Column("state", sa.Text, nullable=False),
    sa.Column("preimage", sa.LargeBinary),
    sa.Column("fee_msat", sa.BigInteger, nullable=False, server_default="0"),
    schema=FAKE,
)

SPARK_METADATA = _metadata(SPARK)
SPARK_METADATA_TABLE = _metadata_table(SPARK_METADATA, SPARK)
SPARK_INVOICES = sa.Table(
    "invoices",
    SPARK_METADATA,
    sa.Column("payment_hash", sa.Text, primary_key=True),
    sa.Column("amount", sa.BigInteger, nullable=False),
    sa.Column("request", sa.Text, nullable=False),
    sa.Column("expiry", sa.BigInteger, nullable=False),
    sa.Column("state", sa.Text, nullable=False, server_default="OPEN"),
    sa.Column("hold_expires_at", sa.BigInteger),
    schema=SPARK,
)
SPARK_PAYMENTS = sa.Table(
    "payments",
    SPARK_METADATA,
    sa.Column("payment_hash", sa.Text, primary_key=True),
    sa.Column("request", sa.Text, nullable=False),
    sa.Column("fee_limit_sat", sa.BigInteger, nullable=False),
    sa.Column("idempotency_key", sa.Text, nullable=False),
    sa.Column("state", sa.Text, nullable=False),
    sa.Column("quoted_fee_sat", sa.BigInteger, nullable=False),
    sa.Column("preimage", sa.LargeBinary),
    sa.Column("fee_msat", sa.BigInteger, nullable=False, server_default="0"),
    schema=SPARK,
)

WALLET_METADATA = _metadata(WALLET)
WALLET_METADATA_TABLE = _metadata_table(WALLET_METADATA, WALLET)
WALLET_TOKENS = sa.Table(
    "tokens",
    WALLET_METADATA,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("token", sa.Text, nullable=False),
    sa.Column("state", sa.Text, nullable=False, server_default="LIVE"),
    sa.Column("expired_state", sa.Text),
    schema=WALLET,
)
WALLET_OPERATIONS = sa.Table(
    "operations",
    WALLET_METADATA,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("payload", sa.Text, nullable=False),
    sa.Column("attempted", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("send_amount", sa.BigInteger),
    schema=WALLET,
)
WALLET_OPERATION_SOURCES = sa.Table(
    "operation_sources",
    WALLET_METADATA,
    sa.Column(
        "source",
        sa.Text,
        sa.ForeignKey(f"{WALLET}.tokens.id"),
        primary_key=True,
    ),
    sa.Column(
        "operation",
        sa.Text,
        sa.ForeignKey(f"{WALLET}.operations.id", ondelete="CASCADE"),
        nullable=False,
    ),
    sa.Column("original_state", sa.Text),
    schema=WALLET,
)

STORE_METADATA = {
    MINT: MINT_METADATA,
    FAKE: FAKE_METADATA,
    SPARK: SPARK_METADATA,
    WALLET: WALLET_METADATA,
}
STORE_METADATA_TABLES = {
    MINT: MINT_METADATA_TABLE,
    FAKE: FAKE_METADATA_TABLE,
    SPARK: SPARK_METADATA_TABLE,
    WALLET: WALLET_METADATA_TABLE,
}
STORE_TABLES = {
    schema: {
        table.name: table
        for table in metadata.tables.values()
        if table.name != "metadata"
    }
    for schema, metadata in STORE_METADATA.items()
}


class CompatRow:
    def __init__(self, row: sa.Row):
        self._row = row

    @property
    def _mapping(self):
        return self._row._mapping

    def __getitem__(self, key):
        if isinstance(key, str):
            return self._mapping[key]
        return self._row[key]

    def __iter__(self):
        return iter(self._row)

    def __len__(self):
        return len(self._row)

    def __getattr__(self, name):
        return getattr(self._row, name)

    def __repr__(self):
        return repr(self._row)

    def keys(self):
        return self._mapping.keys()

    def items(self):
        return self._mapping.items()

    def values(self):
        return self._mapping.values()


class CompatResult:
    def __init__(self, result: CursorResult):
        self._result = result

    @staticmethod
    def _wrap(row):
        return None if row is None else CompatRow(row)

    def fetchone(self):
        return self._wrap(self._result.fetchone())

    def fetchall(self):
        return [CompatRow(row) for row in self._result.fetchall()]

    def fetchmany(self, size=None):
        rows = (
            self._result.fetchmany() if size is None else self._result.fetchmany(size)
        )
        return [CompatRow(row) for row in rows]

    def __iter__(self):
        for row in self._result:
            yield CompatRow(row)

    def __getattr__(self, name):
        return getattr(self._result, name)


class Crud:
    def __init__(self, connection: Connection, schema: str):
        self.connection = connection
        self.schema = schema

    @property
    def dialect(self) -> str:
        return self.connection.dialect.name

    @property
    def tables(self) -> dict[str, sa.Table]:
        return STORE_TABLES[self.schema]

    def execute(self, statement: str, parameters: Any = ()) -> CompatResult:
        """Run driver-specific SQL for legacy fixtures, not application queries."""
        if isinstance(parameters, list) and (
            not parameters or not isinstance(parameters[0], (tuple, list, dict))
        ):
            parameters = tuple(parameters)
        return CompatResult(self.connection.exec_driver_sql(statement, parameters))

    def executemany(self, statement: str, parameters: Any) -> CompatResult:
        """Run driver-specific batch SQL for legacy fixtures."""
        return CompatResult(self.connection.exec_driver_sql(statement, parameters))

    def table(self, name: str) -> sa.Table:
        if name == "metadata":
            return STORE_METADATA_TABLES[self.schema]
        try:
            return self.tables[name]
        except KeyError:
            raise ValueError(f"unknown {self.schema} table: {name}") from None

    @staticmethod
    def _criteria(table: sa.Table, criteria: Mapping[str, Any]) -> list[ColumnElement]:
        expressions = []
        for name, value in criteria.items():
            column = table.c[name]
            expressions.append(column.is_(None) if value is None else column == value)
        return expressions

    def get(
        self,
        table_name: str,
        *,
        columns: Sequence[str] | None = None,
        **criteria: Any,
    ) -> CompatRow | None:
        table = self.table(table_name)
        selected = [table.c[name] for name in columns] if columns else [table]
        statement = sa.select(*selected).where(*self._criteria(table, criteria))
        return CompatResult(self.connection.execute(statement)).fetchone()

    def select(
        self,
        table_name: str,
        *,
        columns: Sequence[str] | None = None,
        in_: Mapping[str, Iterable[Any]] | None = None,
        order_by: str | None = None,
        limit: int | None = None,
        **criteria: Any,
    ) -> list[CompatRow]:
        table = self.table(table_name)
        selected = [table.c[name] for name in columns] if columns else [table]
        expressions = self._criteria(table, criteria)
        for name, values in (in_ or {}).items():
            expressions.append(table.c[name].in_(list(values)))
        statement = sa.select(*selected).where(*expressions)
        if order_by is not None:
            if order_by == "rowid":
                order = sa.text("rowid") if self.dialect == "sqlite" else table.c.id
            else:
                order = table.c[order_by]
            statement = statement.order_by(order)
        if limit is not None:
            statement = statement.limit(limit)
        return CompatResult(self.connection.execute(statement)).fetchall()

    def insert(
        self,
        table_name: str,
        values: Mapping[str, Any],
        *,
        ignore: bool = False,
        replace: bool = False,
    ) -> CursorResult:
        if ignore and replace:
            raise ValueError("insert cannot both ignore and replace conflicts")
        table = self.table(table_name)
        if self.dialect == "postgresql":
            statement: Any = postgresql.insert(table).values(**values)
            if ignore:
                statement = statement.on_conflict_do_nothing()
            elif replace:
                statement = statement.on_conflict_do_update(
                    index_elements=[
                        column.name for column in table.primary_key.columns
                    ],
                    set_={
                        column.name: values[column.name]
                        for column in table.columns
                        if not column.primary_key and column.name in values
                    },
                )
        else:
            statement = sqlite.insert(table).values(**values)
            if ignore:
                statement = statement.prefix_with("OR IGNORE")
            elif replace:
                statement = statement.prefix_with("OR REPLACE")
        return self.connection.execute(statement)

    def insert_many(
        self, table_name: str, rows: Sequence[Mapping[str, Any]]
    ) -> CursorResult:
        return self.connection.execute(self.table(table_name).insert(), list(rows))

    def update(
        self, table_name: str, values: Mapping[str, Any], **criteria: Any
    ) -> CursorResult:
        table = self.table(table_name)
        statement = (
            table.update().where(*self._criteria(table, criteria)).values(**values)
        )
        return self.connection.execute(statement)

    def delete(
        self,
        table_name: str,
        *,
        in_: Mapping[str, Iterable[Any]] | None = None,
        **criteria: Any,
    ) -> CursorResult:
        table = self.table(table_name)
        expressions = self._criteria(table, criteria)
        for name, values in (in_ or {}).items():
            expressions.append(table.c[name].in_(list(values)))
        return self.connection.execute(table.delete().where(*expressions))

    def table_names(self) -> set[str]:
        schema = None if self.dialect == "sqlite" else self.schema
        return set(sa.inspect(self.connection).get_table_names(schema=schema))

    def table_columns(self, table_name: str) -> set[str]:
        schema = None if self.dialect == "sqlite" else self.schema
        columns = sa.inspect(self.connection).get_columns(table_name, schema=schema)
        return {column["name"] for column in columns}

    def ensure_columns(
        self,
        table_name: str,
        column_names: Sequence[str],
        *,
        default_overrides: Mapping[str, str] | None = None,
    ) -> None:
        table = self.table(table_name)
        missing = set(column_names) - self.table_columns(table_name)
        if not missing:
            return
        preparer = self.connection.dialect.identifier_preparer
        qualified = (
            preparer.quote(table.name)
            if self.dialect == "sqlite"
            else f"{preparer.quote_schema(self.schema)}.{preparer.quote(table.name)}"
        )
        for name in column_names:
            if name not in missing:
                continue
            column = table.c[name]
            definition = column.type.compile(self.connection.dialect)
            if not column.nullable:
                definition += " NOT NULL"
            default = (default_overrides or {}).get(name)
            if default is None and column.server_default is not None:
                default = getattr(column.server_default, "arg")
            if default is not None:
                definition += f" DEFAULT {default}"
            self.connection.execute(
                sa.text(
                    f"ALTER TABLE {qualified} "
                    f"ADD COLUMN {preparer.quote(name)} {definition}"
                )
            )

    def create_metadata(self) -> None:
        STORE_METADATA_TABLES[self.schema].create(self.connection, checkfirst=True)

    def create_store(self) -> None:
        STORE_METADATA[self.schema].create_all(self.connection, checkfirst=True)

    def metadata(self) -> dict[str, str]:
        rows = self.select("metadata")
        return {row["key"]: row["value"] for row in rows}

    def metadata_value(self, key: str) -> str | None:
        row = self.get("metadata", columns=("value",), key=key)
        return None if row is None else row["value"]

    def set_metadata(self, key: str, value: str, *, replace: bool = False) -> None:
        self.insert(
            "metadata",
            {"key": key, "value": value},
            ignore=not replace,
            replace=replace,
        )

    def migrate_mint_v2(self) -> None:
        self.ensure_columns("melts", ("attempt", "melt_lock", "submitted"))
        self.ensure_columns("failed_melts", ("expired",))
        for row in self.select("melts", columns=("quote",), attempt=""):
            self.update("melts", {"attempt": os.urandom(16).hex()}, quote=row["quote"])

    def mint_invalid_backing(self) -> bool:
        statement = (
            sa.select(1)
            .select_from(MINT_QUOTES)
            .where(
                sa.or_(
                    MINT_QUOTES.c.reserved < 0,
                    MINT_QUOTES.c.redeemed < 0,
                    MINT_QUOTES.c.redeemed + MINT_QUOTES.c.reserved
                    > MINT_QUOTES.c.amount,
                )
            )
            .limit(1)
        )
        return self.connection.execute(statement).fetchone() is not None

    def mint_clear_orphaned_locks(self):
        return self.connection.execute(
            MINT_MELTS.update().where(MINT_MELTS.c.melt_lock != "").values(melt_lock="")
        )

    def migrate_fake(self) -> None:
        self.ensure_columns("payments", ("fee_msat",))

    def migrate_spark(self) -> None:
        self.ensure_columns("invoices", ("hold_expires_at",))

    def migrate_wallet(self) -> None:
        self.ensure_columns("tokens", ("expired_state",))
        self.ensure_columns(
            "operations",
            ("attempted", "send_amount"),
            default_overrides={"attempted": "1"},
        )
        self.ensure_columns("operation_sources", ("original_state",))

    def fake_expire_invoice(self, payment_hash: str, now: int, states: Sequence[str]):
        return self.connection.execute(
            FAKE_INVOICES.update()
            .where(FAKE_INVOICES.c.payment_hash == payment_hash)
            .where(FAKE_INVOICES.c.expiry <= now)
            .where(FAKE_INVOICES.c.state.in_(states))
            .values(state="CANCELED")
        )

    def fake_accept_open_invoice(self, payment_hash: str, now: int):
        return self.connection.execute(
            FAKE_INVOICES.update()
            .where(FAKE_INVOICES.c.payment_hash == payment_hash)
            .where(FAKE_INVOICES.c.state == "OPEN")
            .where(FAKE_INVOICES.c.expiry > now)
            .values(state="ACCEPTED", amount_paid=FAKE_INVOICES.c.amount)
        )

    def fake_prune_invoice(self, payment_hash: str, now: int):
        return self.connection.execute(
            FAKE_INVOICES.delete()
            .where(FAKE_INVOICES.c.payment_hash == payment_hash)
            .where(FAKE_INVOICES.c.expiry <= now)
            .where(FAKE_INVOICES.c.amount_paid == 0)
            .where(FAKE_INVOICES.c.state.in_(("OPEN", "CANCELED")))
        )

    def spark_prune_invoice(self, payment_hash: str, now: int):
        return self.connection.execute(
            SPARK_INVOICES.delete()
            .where(SPARK_INVOICES.c.payment_hash == payment_hash)
            .where(SPARK_INVOICES.c.state == "CANCELED")
            .where(SPARK_INVOICES.c.expiry <= now)
        )

    def wallet_spend_sources(self, operation_id: str):
        return self.connection.execute(
            WALLET_TOKENS.update()
            .where(
                WALLET_TOKENS.c.id.in_(
                    sa.select(WALLET_OPERATION_SOURCES.c.source).where(
                        WALLET_OPERATION_SOURCES.c.operation == operation_id
                    )
                )
            )
            .values(state="SPENT")
        )

    def wallet_refresh(self, changes: Sequence[Sequence[Any]]) -> None:
        if not changes:
            return
        statement = (
            WALLET_TOKENS.update()
            .where(WALLET_TOKENS.c.id == sa.bindparam("b_id"))
            .where(WALLET_TOKENS.c.state == sa.bindparam("b_expected_state"))
            .where(WALLET_TOKENS.c.token == sa.bindparam("b_token"))
            .values(
                state=sa.bindparam("b_state"),
                expired_state=sa.bindparam("b_expired_state"),
            )
        )
        self.connection.execute(
            statement,
            [
                dict(
                    zip(
                        (
                            "b_state",
                            "b_expired_state",
                            "b_id",
                            "b_expected_state",
                            "b_token",
                        ),
                        row,
                    )
                )
                for row in changes
            ],
        )

    def mint_htlc_quotes(self, payment_hashes: Sequence[str]) -> list[CompatRow]:
        statement = (
            MINT_QUOTES.select()
            .where(MINT_QUOTES.c.payment_hash.in_(payment_hashes))
            .where(MINT_QUOTES.c.issued == 1)
            .where(MINT_QUOTES.c.closed == 0)
            .where(MINT_QUOTES.c.redeemed < MINT_QUOTES.c.amount)
            .order_by(MINT_QUOTES.c.payment_hash)
        )
        return CompatResult(self.connection.execute(statement)).fetchall()

    def mint_closed_hashes(self, payment_hashes: Sequence[str]) -> set[str]:
        statement = (
            sa.select(MINT_QUOTES.c.payment_hash)
            .where(MINT_QUOTES.c.payment_hash.in_(payment_hashes))
            .where(
                sa.or_(
                    MINT_QUOTES.c.closed != 0,
                    MINT_QUOTES.c.redeemed == MINT_QUOTES.c.amount,
                )
            )
        )
        return {row[0] for row in self.connection.execute(statement).fetchall()}

    def mint_reserve_backing(self, payment_hash: str, amount: int, preimage: str):
        return self.connection.execute(
            MINT_QUOTES.update()
            .where(MINT_QUOTES.c.payment_hash == payment_hash)
            .where(MINT_QUOTES.c.closed == 0)
            .where(
                MINT_QUOTES.c.redeemed + MINT_QUOTES.c.reserved + amount
                <= MINT_QUOTES.c.amount
            )
            .values(
                reserved=MINT_QUOTES.c.reserved + amount,
                preimage=preimage,
            )
        )

    def mint_claim(self, row) -> CursorResult:
        return self.connection.execute(
            MINT_MELTS.update()
            .where(MINT_MELTS.c.quote == row["quote"])
            .where(MINT_MELTS.c.digest == row["digest"])
            .where(MINT_MELTS.c.state == "PENDING")
            .where(MINT_MELTS.c.melt_lock == "")
            .where(MINT_MELTS.c.attempt == row["attempt"])
            .values(melt_lock=row["attempt"])
        )

    def mint_unlock(self, quote_id: str, attempt: str):
        return self.connection.execute(
            MINT_MELTS.update()
            .where(MINT_MELTS.c.quote == quote_id)
            .where(MINT_MELTS.c.state == "PENDING")
            .where(MINT_MELTS.c.attempt == attempt)
            .where(MINT_MELTS.c.melt_lock == attempt)
            .values(melt_lock="")
        )

    def mint_melt_backings(self, quote_id: str) -> list[CompatRow]:
        statement = (
            MINT_QUOTES.select()
            .join(
                MINT_MELT_INPUTS,
                MINT_MELT_INPUTS.c.payment_hash == MINT_QUOTES.c.payment_hash,
            )
            .where(MINT_MELT_INPUTS.c.melt == quote_id)
        )
        return CompatResult(self.connection.execute(statement)).fetchall()

    def mint_mark_submitted(self, quote_id: str, attempt: str):
        return self.connection.execute(
            MINT_MELTS.update()
            .where(MINT_MELTS.c.quote == quote_id)
            .where(MINT_MELTS.c.state == "PENDING")
            .where(MINT_MELTS.c.attempt == attempt)
            .where(MINT_MELTS.c.melt_lock == attempt)
            .values(submitted=1)
        )

    def mint_melt_input(self, quote_id: str, payment_hash: str) -> CompatRow | None:
        statement = (
            sa.select(
                MINT_QUOTES,
                MINT_MELT_INPUTS.c.amount.label("input_amount"),
            )
            .join(
                MINT_MELT_INPUTS,
                MINT_MELT_INPUTS.c.payment_hash == MINT_QUOTES.c.payment_hash,
            )
            .where(MINT_MELT_INPUTS.c.melt == quote_id)
            .where(MINT_QUOTES.c.payment_hash == payment_hash)
        )
        return CompatResult(self.connection.execute(statement)).fetchone()

    def mint_finalize_backing(self, payment_hash: str, charged: int, input_amount: int):
        return self.connection.execute(
            MINT_QUOTES.update()
            .where(MINT_QUOTES.c.payment_hash == payment_hash)
            .where(MINT_QUOTES.c.reserved >= input_amount)
            .where(MINT_QUOTES.c.redeemed + charged <= MINT_QUOTES.c.amount)
            .values(
                redeemed=MINT_QUOTES.c.redeemed + charged,
                reserved=MINT_QUOTES.c.reserved - input_amount,
            )
        )

    def mint_mark_paid(self, quote_id: str, attempt: str, response: str):
        return self.connection.execute(
            MINT_MELTS.update()
            .where(MINT_MELTS.c.quote == quote_id)
            .where(MINT_MELTS.c.state == "PENDING")
            .where(MINT_MELTS.c.attempt == attempt)
            .where(MINT_MELTS.c.melt_lock == attempt)
            .values(state="PAID", response=response, melt_lock="")
        )

    def mint_spend_nullifiers(self, digest: str, response: str):
        return self.connection.execute(
            MINT_NULLIFIERS.update()
            .where(MINT_NULLIFIERS.c.kind == "melt")
            .where(MINT_NULLIFIERS.c.digest == digest)
            .where(MINT_NULLIFIERS.c.state == "PENDING")
            .values(state="SPENT", response=response)
        )

    def mint_release_backing(self, payment_hash: str, amount: int):
        return self.connection.execute(
            MINT_QUOTES.update()
            .where(MINT_QUOTES.c.payment_hash == payment_hash)
            .where(MINT_QUOTES.c.reserved >= amount)
            .values(reserved=MINT_QUOTES.c.reserved - amount)
        )

    def mint_reconcilable(
        self, payment_hashes: Sequence[str] | None = None
    ) -> list[CompatRow]:
        statement = (
            sa.select(MINT_QUOTES.c.payment_hash)
            .where(MINT_QUOTES.c.issued == 1)
            .where(MINT_QUOTES.c.preimage.is_not(None))
            .where(MINT_QUOTES.c.closed < 2)
        )
        if payment_hashes is not None:
            statement = statement.where(MINT_QUOTES.c.payment_hash.in_(payment_hashes))
        return CompatResult(self.connection.execute(statement)).fetchall()

    def mint_prune_melt_quotes(self, now: int):
        if self.dialect == "postgresql":
            expiry = sa.cast(
                sa.cast(MINT_MELT_QUOTES.c.payload, sa.JSON).op("->>")("expiry"),
                sa.BigInteger,
            )
        else:
            expiry = sa.cast(
                sa.func.json_extract(MINT_MELT_QUOTES.c.payload, "$.expiry"),
                sa.BigInteger,
            )
        return self.connection.execute(
            MINT_MELT_QUOTES.delete()
            .where(expiry <= now)
            .where(~MINT_MELT_QUOTES.c.quote.in_(sa.select(MINT_MELTS.c.quote)))
            .where(~MINT_MELT_QUOTES.c.quote.in_(sa.select(MINT_FAILED_MELTS.c.quote)))
        )

    @staticmethod
    def _mint_prunable(now: int) -> list[ColumnElement]:
        return [
            MINT_QUOTES.c.issued == 0,
            MINT_QUOTES.c.expiry <= now,
            MINT_QUOTES.c.redeemed == 0,
            MINT_QUOTES.c.reserved == 0,
            MINT_QUOTES.c.preimage.is_(None),
            MINT_QUOTES.c.closed == 0,
            MINT_QUOTES.c.digest.is_(None),
            MINT_QUOTES.c.response.is_(None),
            ~sa.exists(
                sa.select(1)
                .select_from(MINT_MELT_INPUTS)
                .where(MINT_MELT_INPUTS.c.payment_hash == MINT_QUOTES.c.payment_hash)
            ),
        ]

    def mint_prunable_quotes(self, now: int, payment_hash: str | None = None):
        expressions = self._mint_prunable(now)
        if payment_hash is not None:
            expressions.append(MINT_QUOTES.c.payment_hash == payment_hash)
        statement = sa.select(MINT_QUOTES.c.payment_hash).where(*expressions)
        return CompatResult(self.connection.execute(statement)).fetchall()

    def mint_delete_prunable(self, now: int, payment_hash: str):
        return self.connection.execute(
            MINT_QUOTES.delete()
            .where(MINT_QUOTES.c.payment_hash == payment_hash)
            .where(*self._mint_prunable(now))
        )
