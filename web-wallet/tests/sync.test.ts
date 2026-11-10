import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import WebSocket from "ws";
import Dexie from "dexie";
import { useWebSocketImplementation } from "nostr-tools/relay";
import { matchFilter, type Filter } from "nostr-tools/filter";
import type { Event } from "nostr-tools/pure";
import {
  TmpCashIndexedDbRepository,
  emptyWalletState,
} from "coco-cashu-indexeddb/tmp-cash";
import { psRandomHex, psPreimageHash } from "@cashu/cashu-ts/tmp-cash";
import {
  createSyncSettings,
  exportSyncCode,
  importSyncCode,
  NostrWalletSync,
  saveSyncSettings,
  type RelayIO,
} from "../src/nostr-sync";
import {
  assertWalletSyncGroup,
  createWalletSyncBackup,
  mergeWalletSyncBackup,
} from "../src/sync-document";
import {
  createBackupKey,
  encryptBackupWithKey,
  recoverBackupKey,
  restoreBackup,
  restoreBackupWithKey,
} from "../src/backup";
import { CloudSaver, enableCloud } from "../src/cloud";
import type { CloudBackup, CloudClient } from "../src/CloudTypes";
import { testRelay } from "./helpers/nostr-relay";

useWebSocketImplementation(WebSocket);
const mint = "http://127.0.0.1:3339";
const repos: TmpCashIndexedDbRepository[] = [];
const workers: NostrWalletSync[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) worker.stop();
  for (const repo of repos.splice(0)) await repo.delete();
  vi.unstubAllGlobals();
});
function repository() {
  const repo = new TmpCashIndexedDbRepository(
    "sync-test-" + crypto.randomUUID(),
  );
  repos.push(repo);
  return repo;
}
async function funding(repo: TmpCashIndexedDbRepository) {
  const preimage = psRandomHex();
  const value = {
    id: psPreimageHash(preimage),
    mint,
    amount: 16,
    preimage,
    invoiceExpiry: 3600,
    quote: null,
    state: "waiting" as const,
    createdAt: Date.now(),
  };
  await repo.saveFunding(value);
  return value;
}
class MemoryRelay implements RelayIO {
  events = new Map<string, Event>();
  fail = false;
  loseAck = false;
  async query(filter: Filter) {
    return [...this.events.values()]
      .filter((e) => matchFilter(filter, e))
      .reverse();
  }
  async publishPacket(events: Event[]) {
    if (this.fail) throw new Error("Relay unavailable");
    for (const event of events) {
      if (event.kind === 30078)
        for (const previous of this.events.values())
          if (
            previous.kind === 30078 &&
            previous.tags.find((t) => t[0] === "d")?.[1] ===
              event.tags.find((t) => t[0] === "d")?.[1]
          )
            this.events.delete(previous.id);
      this.events.set(event.id, event);
    }
    if (this.loseAck) {
      this.loseAck = false;
      throw new Error("Acknowledgment lost");
    }
  }
  close() {}
}
async function pair(io: RelayIO) {
  const a = repository(),
    b = repository();
  const config = createSyncSettings(["wss://buzz.cashu.space"], mint);
  const other = importSyncCode(exportSyncCode(config));
  expect(other.device).not.toBe(config.device);
  await saveSyncSettings(a, config);
  await saveSyncSettings(b, other);
  const left = new NostrWalletSync(a, config, io),
    right = new NostrWalletSync(b, other, io);
  workers.push(left, right);
  return { a, b, left, right };
}
describe("Yjs checkpoints over signed, encrypted relay events", () => {
  it("merges independent writes, duplicated checkpoints, and reversed delivery", async () => {
    const io = new MemoryRelay();
    const { a, b, left, right } = await pair(io);
    const x = await funding(a),
      y = await funding(b);
    await left.flush();
    await right.flush();
    await left.synchronize();
    await right.synchronize();
    await left.synchronize();
    expect((await a.read()).fundings.map((f) => f.id).sort()).toEqual(
      [x.id, y.id].sort(),
    );
    expect(await a.read()).toEqual(await b.read());
    const wire = JSON.stringify([...io.events.values()]);
    expect(wire).not.toContain(x.preimage);
    expect(wire).not.toContain(y.preimage);
    expect(wire).not.toContain(mint);
  });
  it("retries the exact persisted packet after a lost acknowledgment and reload", async () => {
    const io = new MemoryRelay();
    const { a, b, left, right } = await pair(io);
    await funding(a);
    io.loseAck = true;
    await expect(left.flush()).rejects.toThrow("Acknowledgment");
    const pending = (await a.syncData.get("pending"))!.value as {
      events: Event[];
    };
    const before = pending.events.map((e) => e.id);
    const reloaded = new NostrWalletSync(a, left.config, io);
    workers.push(reloaded);
    await reloaded.flush();
    expect(before.every((id) => io.events.has(id))).toBe(true);
    expect(await a.syncData.get("pending")).toBeUndefined();
    await right.synchronize();
    expect(await b.read()).toEqual(await a.read());
  });
  it("retains all local data when a checkpoint chunk is missing", async () => {
    const io = new MemoryRelay();
    const { a, b, left, right } = await pair(io);
    await funding(a);
    await left.flush();
    const chunk = [...io.events.values()].find((e) => e.kind === 78)!;
    io.events.delete(chunk.id);
    const previous = await b.read();
    await expect(right.synchronize()).rejects.toThrow("incomplete");
    expect(await b.read()).toEqual(previous);
  });
  it("rejects a tampered signed event before applying any wallet changes", async () => {
    const io = new MemoryRelay();
    const { a, b, left, right } = await pair(io);
    await funding(a);
    await left.flush();
    const head = [...io.events.values()].find((e) => e.kind === 30078)!;
    head.content = head.content.slice(0, -2) + "aa";
    await expect(right.synchronize()).rejects.toThrow("Invalid signed");
    expect((await b.read()).fundings).toEqual([]);
  });
  it("chunks large documents and recovers them without exposing secrets", async () => {
    const io = new MemoryRelay();
    const { a, b, left, right } = await pair(io);
    for (let i = 0; i < 85; i++) await funding(a);
    await left.flush();
    expect(
      [...io.events.values()].filter((e) => e.kind === 78).length,
    ).toBeGreaterThan(1);
    await right.synchronize();
    expect((await b.read()).fundings).toHaveLength(85);
  });
  it("rejects malformed codes, insecure relays, and cross-wallet reconfiguration", async () => {
    expect(() => importSyncCode("bad")).toThrow();
    expect(() => createSyncSettings(["ws://remote.example"], mint)).toThrow();
    const repo = repository();
    await saveSyncSettings(
      repo,
      createSyncSettings(["wss://buzz.cashu.space"], mint),
    );
    await expect(
      saveSyncSettings(
        repo,
        createSyncSettings(["wss://buzz.cashu.space"], mint),
      ),
    ).rejects.toThrow("another");
  });
  it("authenticates reads and writes using the relay challenge, including reconnect", async () => {
    const relay = await testRelay();
    try {
      const a = repository(),
        b = repository();
      const config = createSyncSettings([relay.url], mint),
        other = importSyncCode(exportSyncCode(config));
      await saveSyncSettings(a, config);
      await saveSyncSettings(b, other);
      const left = new NostrWalletSync(a, config),
        right = new NostrWalletSync(b, other);
      workers.push(left, right);
      await funding(a);
      await left.flush();
      await right.synchronize(true);
      expect(await a.read()).toEqual(await b.read());
      expect(relay.auth.length).toBeGreaterThanOrEqual(2);
      expect(relay.auth.every((e) => e.kind === 22242)).toBe(true);
      expect(
        relay.auth.every((e) =>
          e.tags.some((t) => t[0] === "relay" && t[1] === relay.url),
        ),
      ).toBe(true);
      expect([...relay.events.values()].some((e) => e.kind === 22242)).toBe(
        false,
      );
      left.stop();
      const reload = new NostrWalletSync(a, config);
      workers.push(reload);
      await funding(a);
      await reload.flush();
      expect(relay.auth.length).toBeGreaterThanOrEqual(3);
    } finally {
      await relay.close();
    }
  });
  it("fails closed when NIP-42 authentication is denied", async () => {
    const relay = await testRelay();
    relay.state.rejectAuth = true;
    try {
      const a = repository(),
        config = createSyncSettings([relay.url], mint);
      await saveSyncSettings(a, config);
      await funding(a);
      const sync = new NostrWalletSync(a, config);
      workers.push(sync);
      await expect(sync.flush()).rejects.toThrow("No relay accepted");
      expect([...relay.events.values()]).toHaveLength(0);
      expect(await a.syncData.get("pending")).toBeDefined();
    } finally {
      await relay.close();
    }
  });
});

describe("durable migration and immutable journal validation", () => {
  it("upgrades the original IndexedDB schema without losing wallet records", async () => {
    const name = "legacy-wallet-" + crypto.randomUUID();
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      proofs: "id,mint,state,operationId",
      operations: "id,mint",
      fundings: "id,mint,state",
      activity: "id,mint,createdAt",
    });
    const preimage = psRandomHex(),
      record = {
        id: psPreimageHash(preimage),
        mint,
        amount: 16,
        preimage,
        invoiceExpiry: 3600,
        quote: null,
        state: "waiting",
        createdAt: Date.now(),
      };
    await legacy.table("fundings").add(record);
    legacy.close();
    const repo = new TmpCashIndexedDbRepository(name);
    repos.push(repo);
    await repo.enableSyncJournal();
    expect((await repo.read()).fundings).toEqual([record]);
    expect(await repo.readSyncFacts()).toHaveLength(1);
  });
  it("atomically rejects reused fact IDs even when preceded by valid records", async () => {
    const io = new MemoryRelay(),
      { a, b, left, right } = await pair(io);
    await funding(a);
    await left.flush();
    await right.synchronize();
    const before = await b.read(),
      records = await a.readSyncFacts(),
      original = records.find((f) => f.state.fundings.length)!;
    const fresh = { ...original, id: crypto.randomUUID() },
      corrupt = {
        ...original,
        state: {
          ...original.state,
          fundings: original.state.fundings.map((f) => ({
            ...f,
            createdAt: f.createdAt + 1,
          })),
        },
      };
    await expect(b.mergeSyncFacts([fresh, corrupt])).rejects.toThrow("reused");
    expect(await b.read()).toEqual(before);
    expect((await b.readSyncFacts()).some((f) => f.id === fresh.id)).toBe(
      false,
    );
  });
});

describe("the Google Drive backup is the mergeable document", () => {
  it("roundtrips the document and reuses its encryption key when restored on another device", async () => {
    const a = repository(),
      b = repository();
    await funding(a);
    const sync = await createWalletSyncBackup(a, mint),
      key = await createBackupKey("a sufficiently long password");
    const raw = await encryptBackupWithKey(await a.read(), mint, key, sync);
    const restored = await restoreBackup(raw, "a sufficiently long password");
    await b.importState(restored.state);
    await mergeWalletSyncBackup(b, restored.sync!);
    const restoredKey = await recoverBackupKey(
      raw,
      "a sufficiently long password",
    );
    const next = await encryptBackupWithKey(
      await b.read(),
      mint,
      restoredKey,
      await createWalletSyncBackup(b, mint),
    );
    expect((await restoreBackupWithKey(next, key)).state).toEqual(
      await a.read(),
    );
    expect((await createWalletSyncBackup(a, mint)).fallback).toBe(
      (await createWalletSyncBackup(b, mint)).fallback,
    );
  });
  it("merges simultaneous changes carried by independent backups", async () => {
    const a = repository(),
      b = repository();
    const initial = await createWalletSyncBackup(a, mint);
    await mergeWalletSyncBackup(b, initial);
    const x = await funding(a),
      y = await funding(b);
    const aa = await createWalletSyncBackup(a, mint),
      bb = await createWalletSyncBackup(b, mint);
    await mergeWalletSyncBackup(a, bb);
    await mergeWalletSyncBackup(b, aa);
    expect(await a.read()).toEqual(await b.read());
    expect((await a.read()).fundings.map((f) => f.id).sort()).toEqual(
      [x.id, y.id].sort(),
    );
  });
  it("uses Drive for write-ahead recovery, merges another writer, and keeps two checkpoints per writer", async () => {
    vi.stubGlobal("navigator", {
      locks: { request: async (_: string, fn: () => Promise<unknown>) => fn() },
    });
    const files = new Map<string, { backup: CloudBackup; raw: string }>();
    let fail = false;
    const client: CloudClient = {
      user: { provider: "google", account: "google:test", label: "test" },
      list: async () => [...files.values()].map((f) => f.backup),
      download: async (id) => files.get(id)!.raw,
      upload: async (walletId, id, created, raw, name, writer) => {
        const backup = {
          id,
          walletId,
          updated: created,
          encrypted: false,
          name,
          writer,
        };
        files.set(id, { backup, raw });
        if (fail) {
          fail = false;
          throw new Error("lost upload response");
        }
        return backup;
      },
      remove: async (id) => {
        files.delete(id);
      },
      disconnect: async () => {},
    };
    const a = repository(),
      b = repository();
    const key = await createBackupKey("a sufficiently long password");
    await enableCloud({
      storage: "provider-v1",
      account: client.user.account,
      id: "shared-wallet",
      name: "wallet",
      encryption: key,
      fingerprint: "",
      updated: 0,
    });
    const left = new CloudSaver(
      a,
      () => mint,
      client,
      () => {},
    );
    await funding(a);
    await left.save();
    const latest = [...files.values()][0];
    const restored = await restoreBackupWithKey(latest.raw, key);
    await b.importState(restored.state);
    await mergeWalletSyncBackup(b, restored.sync!);
    const right = new CloudSaver(
      b,
      () => mint,
      client,
      () => {},
    );
    await funding(b);
    fail = true;
    await expect(right.save()).rejects.toThrow("lost");
    await right.save();
    await left.save();
    expect((await a.read()).fundings).toHaveLength(2);
    expect(await a.read()).toEqual(await b.read());
    for (let i = 0; i < 4; i++) {
      await funding(a);
      await left.save();
    }
    const counts = new Map<string, number>();
    for (const { backup } of files.values())
      counts.set(backup.writer!, 1 + (counts.get(backup.writer!) ?? 0));
    expect([...counts.values()].every((n) => n <= 2)).toBe(true);
    left.stop();
    await expect(left.flush()).rejects.toThrow("stopped before recovery data");
    right.stop();
  });
  it("checks existing sync membership before importing another wallet's funds", async () => {
    const a = repository(),
      b = repository();
    await funding(a);
    const backup = await createWalletSyncBackup(a, mint);
    await createWalletSyncBackup(b, mint);
    await expect(assertWalletSyncGroup(b, backup)).rejects.toThrow(
      "different wallet sync group",
    );
    await expect(assertWalletSyncGroup(b)).rejects.toThrow(
      "different wallet sync group",
    );
    expect(await b.read()).toEqual(emptyWalletState());
  });
  it("rejects corrupt sync metadata without changing the wallet", async () => {
    const a = repository(),
      b = repository();
    const sync = await createWalletSyncBackup(a, mint);
    await expect(
      mergeWalletSyncBackup(b, { ...sync, document: "broken" }),
    ).rejects.toThrow();
    expect(await b.read()).toEqual(emptyWalletState());
  });
});
