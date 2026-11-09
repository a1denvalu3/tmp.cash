"""Async coordination shared by the mint and its backends."""

import asyncio
from collections.abc import AsyncIterator, Callable, Hashable, Iterable
from contextlib import AsyncExitStack, asynccontextmanager
from functools import partial
from typing import TypeVar

T = TypeVar("T")


async def run_blocking(operation: Callable[..., T], *args, **kwargs) -> T:
    """Finish worker work before cancellation can release its caller's locks.

    Cancelling an executor future cannot stop its thread. Shield it and drain
    it on cancellation so a transaction never outlives its operation lock.
    """
    loop = asyncio.get_running_loop()
    future = loop.run_in_executor(None, partial(operation, *args, **kwargs))
    cancelled = False
    while True:
        try:
            result = await asyncio.shield(future)
            break
        except asyncio.CancelledError:
            cancelled = True
            if future.done():
                # A worker may itself raise CancelledError, or the event loop
                # may cancel a queued future during shutdown. Do not spin on
                # a completed future; consume its outcome and propagate cancel.
                try:
                    future.result()
                except BaseException:
                    pass
                raise
        except BaseException:
            if cancelled:
                raise asyncio.CancelledError from None
            raise
    if cancelled:
        raise asyncio.CancelledError
    return result


class KeyedLocks:
    """Reference-counted asyncio locks; idle entries are evicted."""

    def __init__(self) -> None:
        self._entries: dict[Hashable, list] = {}
        self._mutex = asyncio.Lock()

    @asynccontextmanager
    async def hold(self, key: Hashable) -> AsyncIterator[None]:
        async with self._mutex:
            entry = self._entries.setdefault(key, [asyncio.Lock(), 0])
            entry[1] += 1
        try:
            await entry[0].acquire()
        except BaseException:
            await self._drop(key, entry)
            raise
        try:
            yield
        finally:
            entry[0].release()
            await self._drop(key, entry)

    async def _drop(self, key: Hashable, entry: list) -> None:
        async with self._mutex:
            entry[1] -= 1
            if entry[1] == 0:
                self._entries.pop(key, None)

    @asynccontextmanager
    async def hold_many(self, keys: Iterable[str]) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            for key in sorted(set(keys)):
                await stack.enter_async_context(self.hold(key))
            yield
