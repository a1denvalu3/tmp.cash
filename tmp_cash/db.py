import fcntl
import hashlib
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.engine import Connection
from sqlalchemy.pool import NullPool
from sqlalchemy.schema import CreateSchema

from .crud import STORE_METADATA, Crud


class Database:
    """Short transactions with one CRUD interface per logical data store."""

    def __init__(self, location: Path | str, schema: str):
        if schema not in STORE_METADATA:
            raise ValueError(f"unknown database schema: {schema}")
        self.schema = schema
        raw = str(location)
        self.path = Path(location) if "://" not in raw else None
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            url = f"sqlite:///{self.path}"
        elif raw.startswith("postgresql://"):
            url = "postgresql+psycopg://" + raw.removeprefix("postgresql://")
        elif raw.startswith("postgresql+psycopg://"):
            url = raw
        else:
            raise ValueError("database URL must use SQLite or PostgreSQL")
        self.url = url
        self.engine = sa.create_engine(url, poolclass=NullPool, hide_parameters=True)
        if self.path is not None:
            sa.event.listen(self.engine, "connect", self._configure_sqlite)
            self.engine.connect().close()
        else:
            with self.engine.begin() as connection:
                connection.execute(CreateSchema(schema, if_not_exists=True))
        identity = f"{url}\0{schema}"
        digest = hashlib.sha256(identity.encode()).digest()
        self._singleton_key = int.from_bytes(
            hashlib.sha256(digest + b"singleton").digest()[:8], "big", signed=True
        )
        self._transaction_key = int.from_bytes(
            hashlib.sha256(digest + b"transaction").digest()[:8], "big", signed=True
        )
        self._lock_identity = identity

    @staticmethod
    def _configure_sqlite(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
        finally:
            cursor.close()

    def connect(self) -> Connection:
        connection = self.engine.connect()
        translated = None if self.path is not None else self.schema
        return connection.execution_options(
            schema_translate_map={self.schema: translated}
        )

    @contextmanager
    def read(self) -> Iterator[Crud]:
        connection = self.connect()
        try:
            yield Crud(connection, self.schema)
        finally:
            connection.close()

    @contextmanager
    def transaction(self) -> Iterator[Crud]:
        connection = self.connect()
        try:
            if self.path is not None:
                connection.exec_driver_sql("BEGIN IMMEDIATE")
            else:
                connection.begin()
                connection.execute(
                    sa.text("SELECT pg_advisory_xact_lock(:key)"),
                    {"key": self._transaction_key},
                )
            yield Crud(connection, self.schema)
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def acquire_singleton(self) -> bool:
        if self.path is not None:
            return acquire_singleton_lock(self.path)
        if self._lock_identity in _postgres_singleton_locks:
            return False
        connection = self.engine.connect()
        acquired = connection.execute(
            sa.text("SELECT pg_try_advisory_lock(:key)"), {"key": self._singleton_key}
        ).scalar()
        if not acquired:
            connection.close()
            raise MintDatabaseInUse(
                "mint database is already in use by another mint process"
            )
        _postgres_singleton_locks[self._lock_identity] = connection
        return True


class MintError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class BackendError(Exception):
    pass


class IncompatibleMintDatabase(ValueError):
    pass


class MintDatabaseInUse(RuntimeError):
    pass


_singleton_locks: dict[Path, int] = {}
_postgres_singleton_locks: dict[str, Connection] = {}


def acquire_singleton_lock(path: Path) -> bool:
    """Hold an exclusive flock next to the mint database for process lifetime.

    One mint process per database: a second OS process fails closed instead of
    inheriting orphaned melt executor locks. Reentrant per canonical path so
    tests and embedders can reopen a mint inside the same process. Returns
    True only for this process's first acquisition of the database.
    """
    key = path.resolve()
    if key in _singleton_locks:
        return False
    key.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(key.with_name(key.name + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise MintDatabaseInUse(
            "mint database is already in use by another mint process"
        ) from None
    _singleton_locks[key] = fd
    return True
