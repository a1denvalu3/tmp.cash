import * as Y from "yjs";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
} from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { encrypt, decrypt, getConversationKey } from "nostr-tools/nip44";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import type { Filter } from "nostr-tools/filter";
import {
  canonical,
  validateSyncFact,
  type WalletSyncFact,
  type TmpCashIndexedDbRepository,
} from "coco-cashu-indexeddb/tmp-cash";
import { normalizePSMintUrl } from "@cashu/cashu-ts/tmp-cash";

export const DEFAULT_SYNC_RELAY = "wss://buzz.cashu.space";
const SCOPE = "tmp.cash-sync-v1";
const CHUNK_SCOPE = `${SCOPE}:chunk`;
const CHECKPOINT_VERSION = 2;
const MAX_DOCUMENT = 16_000_000;
const CHUNK_SIZE = 24_000;
const MAX_HEADS = 128;
const MAX_CHUNKS = Math.ceil(MAX_DOCUMENT / CHUNK_SIZE);
const TIMEOUT = 8000;
export interface NostrSyncSettings {
  version: 1;
  secret: string;
  relays: string[];
  mint: string;
  device: string;
}
export interface RelayIO {
  query(filter: Filter): Promise<Event[]>;
  publishPacket(events: Event[]): Promise<void>;
  close(): void;
}
function timeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), TIMEOUT);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
export function normalizeSyncRelays(input: string[]): string[] {
  const urls = [
    ...new Set(
      input.map((raw) => {
        const url = new URL(raw.trim());
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
          url.hostname,
        );
        if (
          (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) ||
          url.username ||
          url.password ||
          url.hash ||
          url.search
        )
          throw new Error(
            "Use wss:// relay URLs (ws:// is allowed only on localhost).",
          );
        return url.toString();
      }),
    ),
  ];
  if (!urls.length || urls.length > 5)
    throw new Error("Choose between one and five relays.");
  return urls;
}
function settings(value: unknown): NostrSyncSettings {
  const s = value as NostrSyncSettings;
  if (
    !s ||
    s.version !== 1 ||
    typeof s.secret !== "string" ||
    !/^[0-9a-f]{64}$/.test(s.secret) ||
    !Array.isArray(s.relays) ||
    s.relays.some((r) => typeof r !== "string") ||
    typeof s.mint !== "string"
  )
    throw new Error("Invalid wallet sync code.");
  getPublicKey(hexToBytes(s.secret));
  return {
    version: 1,
    secret: s.secret,
    relays: normalizeSyncRelays(s.relays),
    mint: normalizePSMintUrl(s.mint),
    device:
      typeof s.device === "string" && /^[0-9a-f-]{36}$/.test(s.device)
        ? s.device
        : crypto.randomUUID(),
  };
}
export function createSyncSettings(
  relays: string[],
  mint: string,
): NostrSyncSettings {
  return settings({
    version: 1,
    secret: bytesToHex(generateSecretKey()),
    relays,
    mint,
    device: crypto.randomUUID(),
  });
}
export function exportSyncCode(s: NostrSyncSettings): string {
  // Device IDs are intentionally not copied: each writable installation owns its checkpoint address.
  return (
    "tmpcash-sync1:" +
    btoa(
      JSON.stringify({
        version: 1,
        secret: s.secret,
        relays: s.relays,
        mint: s.mint,
      }),
    )
  );
}
export function importSyncCode(code: string): NostrSyncSettings {
  if (code.length > 16000 || !code.startsWith("tmpcash-sync1:"))
    throw new Error("Invalid wallet sync code.");
  try {
    return settings({
      ...JSON.parse(atob(code.slice(14))),
      device: crypto.randomUUID(),
    });
  } catch {
    throw new Error("Invalid wallet sync code.");
  }
}
export async function readSyncSettings(
  repo: TmpCashIndexedDbRepository,
): Promise<NostrSyncSettings | null> {
  const row = await repo.syncData.get("settings");
  return row ? settings(row.value) : null;
}
export async function saveSyncSettings(
  repo: TmpCashIndexedDbRepository,
  s: NostrSyncSettings,
): Promise<void> {
  const previous = await readSyncSettings(repo);
  if (previous && previous.secret !== s.secret)
    throw new Error("This wallet already belongs to another sync group.");
  await repo.enableSyncJournal();
  await repo.syncData.put({ id: "settings", value: settings(s) });
}

async function syncLock<T>(fn: () => Promise<T>): Promise<T> {
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("tmp-cash-nostr-sync", fn)
    : fn();
}

/** Caller holds the wallet lock. Only an unused setup may be forgotten. */
export async function clearEmptySyncSetup(
  repo: TmpCashIndexedDbRepository,
): Promise<void> {
  await syncLock(() =>
    repo.runTransaction(
      "rw",
      ["proofs", "operations", "fundings", "activity"],
      async () => {
        const hasRecords = (state: WalletSyncFact["state"]) =>
          Object.values(state).some((rows) => rows.length > 0);
        const hasRecovery = (fact: WalletSyncFact) =>
          hasRecords(fact.state) || !!fact.terminal || !!fact.consumed;
        let used = hasRecords(await repo.read());
        for (const fact of await repo.readSyncFacts())
          used ||= hasRecovery(validateSyncFact(fact));
        const saved = await repo.syncData.get("document");
        if (saved) {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, saved.value as Uint8Array);
            for (const raw of doc.getMap<string>("facts").values())
              used ||= hasRecovery(validateSyncFact(JSON.parse(raw)));
          } finally {
            doc.destroy();
          }
        }
        if (used)
          throw new Error(
            "This wallet has funds, history, or recovery records. Use a new browser profile to connect to a different wallet.",
          );
        await repo.syncFacts.clear();
        await repo.syncData.clear();
      },
    ),
  );
}

/** A complete packet must be accepted on the same relay before its manifest is published. */
export class NostrRelayIO implements RelayIO {
  private connections = new Map<string, Relay>();
  private closed = false;
  constructor(private config: NostrSyncSettings) {}
  private failure(message: string, results: PromiseSettledResult<unknown>[]) {
    const reasons = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : typeof result.reason === "string"
            ? result.reason
            : "Relay request failed.";
      return [`${this.config.relays[index]}: ${reason.slice(0, 240)}`];
    });
    return new Error(`${message} ${reasons.join("; ")}`);
  }
  private async connect(url: string): Promise<Relay> {
    if (this.closed) throw new Error("Wallet sync is stopped.");
    let relay = this.connections.get(url);
    if (!relay) {
      relay = new Relay(url, { enableReconnect: false });
      relay.publishTimeout = TIMEOUT;
      relay.onauth = async (event) =>
        finalizeEvent(event, hexToBytes(this.config.secret));
      this.connections.set(url, relay);
    }
    await timeout(relay.connect(), "Relay connection timed out.");
    return relay;
  }
  async query(filter: Filter): Promise<Event[]> {
    const results = await Promise.allSettled(
      this.config.relays.map(async (url) => {
        const relay = await this.connect(url);
        const query = () =>
          new Promise<Event[]>((resolve, reject) => {
            const events: Event[] = [];
            const timer = setTimeout(() => {
              reject(new Error("Relay query timed out."));
              sub.close();
            }, TIMEOUT);
            const sub = relay.subscribe([filter], {
              eoseTimeout: TIMEOUT + 1000,
              onevent: (event) => {
                events.push(event);
                if (events.length > Math.max(MAX_HEADS, MAX_CHUNKS)) {
                  clearTimeout(timer);
                  reject(new Error("Relay returned too many events."));
                  sub.close();
                }
              },
              oneose: () => {
                clearTimeout(timer);
                resolve(events);
                sub.close();
              },
              onclose: (reason) => {
                clearTimeout(timer);
                reject(new Error(reason || "Relay refused the wallet query."));
              },
            });
          });
        try {
          return await query();
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.startsWith("auth-required:")
          )
            throw error;
          await timeout(
            relay.auth(async (event) =>
              finalizeEvent(event, hexToBytes(this.config.secret)),
            ),
            "Relay authentication timed out.",
          );
          return query();
        }
      }),
    );
    const completed = results.filter(
      (r): r is PromiseFulfilledResult<Event[]> => r.status === "fulfilled",
    );
    if (!completed.length)
      throw this.failure(
        "No relay could load wallet sync data. Reconnect and retry.",
        results,
      );
    return [
      ...new Map(
        completed.flatMap((r) => r.value).map((e) => [e.id, e]),
      ).values(),
    ];
  }
  async publishPacket(events: Event[]): Promise<void> {
    const results = await Promise.allSettled(
      this.config.relays.map(async (url) => {
        const relay = await this.connect(url);
        // Preserve packet ordering: never acknowledge a manifest before all referenced chunks.
        for (const event of events) {
          try {
            await timeout(relay.publish(event), "Relay upload timed out.");
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.startsWith("auth-required:")
            )
              throw error;
            await timeout(
              relay.auth(async (event) =>
                finalizeEvent(event, hexToBytes(this.config.secret)),
              ),
              "Relay authentication timed out.",
            );
            await timeout(relay.publish(event), "Relay upload timed out.");
          }
        }
      }),
    );
    if (!results.some((r) => r.status === "fulfilled"))
      throw this.failure(
        "No relay accepted the complete wallet checkpoint. Your operation is saved locally; reconnect and retry.",
        results,
      );
  }
  close() {
    this.closed = true;
    for (const relay of this.connections.values()) relay.close();
    this.connections.clear();
  }
}
const encode64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
const decode64 = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
async function digest(bytes: Uint8Array): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  );
}
interface PendingPacket {
  hash: string;
  events: Event[];
}
interface CheckpointManifest {
  version: 1 | 2;
  hash: string;
  chunks: string[];
}

export class NostrWalletSync {
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  readonly pubkey: string;
  private key: Uint8Array;
  constructor(
    readonly repo: TmpCashIndexedDbRepository,
    readonly config: NostrSyncSettings,
    private io: RelayIO = new NostrRelayIO(config),
  ) {
    this.pubkey = getPublicKey(hexToBytes(config.secret));
    this.key = getConversationKey(hexToBytes(config.secret), this.pubkey);
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = () =>
      syncLock(async () => {
        if (this.stopped) throw new Error("Wallet sync is stopped.");
        const current = await readSyncSettings(this.repo);
        if (
          !current ||
          current.secret !== this.config.secret ||
          current.device !== this.config.device
        )
          throw new Error(
            "Wallet sync settings changed. Reload this device before syncing.",
          );
        return fn();
      });
    const task = this.queue.then(run, run);
    this.queue = task.catch(() => undefined);
    return task;
  }
  private event(
    kind: number,
    tags: string[][],
    content: string,
    created_at = Math.floor(Date.now() / 1000),
  ): Event {
    return finalizeEvent(
      { kind, tags, content: encrypt(content, this.key), created_at },
      hexToBytes(this.config.secret),
    );
  }
  private plaintext(event: Event, kind: number, scope = SCOPE): string {
    // Parse a fresh wire object so no library verification-cache flag can bypass signature checks.
    const wire: Event = JSON.parse(JSON.stringify(event));
    if (
      wire.pubkey !== this.pubkey ||
      wire.kind !== kind ||
      wire.content.length > 100_000 ||
      !wire.tags.some((t) => t[0] === "t" && t[1] === scope) ||
      !verifyEvent(wire)
    )
      throw new Error("Invalid signed wallet sync event.");
    return decrypt(wire.content, this.key);
  }
  private manifest(head: Event): CheckpointManifest {
    if (!head.tags.some((t) => t[0] === "d" && t[1]?.startsWith(SCOPE + ":")))
      throw new Error("Invalid wallet checkpoint address.");
    const manifest = JSON.parse(this.plaintext(head, 30078));
    if (
      (manifest.version !== 1 && manifest.version !== CHECKPOINT_VERSION) ||
      !/^[0-9a-f]{64}$/.test(manifest.hash) ||
      !Array.isArray(manifest.chunks) ||
      !manifest.chunks.length ||
      manifest.chunks.length > MAX_CHUNKS ||
      manifest.chunks.some(
        (id: unknown) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id),
      )
    )
      throw new Error("Invalid wallet checkpoint manifest.");
    return manifest;
  }
  private chunk(content: string): Event {
    // Never reuse an address: replacing a chunk would invalidate older manifests' event IDs.
    return this.event(
      30078,
      [
        ["d", `${CHUNK_SCOPE}:${crypto.randomUUID()}`],
        ["t", CHUNK_SCOPE],
      ],
      content,
    );
  }
  private async nextStamp(previous = 0): Promise<number> {
    const saved = Number((await this.repo.syncData.get("stamp"))?.value ?? 0);
    return Math.max(Math.floor(Date.now() / 1000), saved + 1, previous + 1);
  }
  private async savePending(pending: PendingPacket): Promise<void> {
    await this.repo.syncData.bulkPut([
      { id: "stamp", value: pending.events.at(-1)!.created_at },
      { id: "pending", value: pending },
    ]);
  }
  private async upgradePending(pending: PendingPacket): Promise<PendingPacket> {
    const head = pending.events.at(-1)!;
    const manifest = this.manifest(head);
    if (manifest.version === CHECKPOINT_VERSION) return pending;
    const byId = new Map(pending.events.map((event) => [event.id, event]));
    const chunks = manifest.chunks.map((id) => {
      const event = byId.get(id);
      if (!event) throw new Error("Pending wallet checkpoint is incomplete.");
      return this.chunk(this.plaintext(event, 78));
    });
    const upgraded = {
      hash: pending.hash,
      events: [
        ...chunks,
        this.event(
          30078,
          head.tags,
          JSON.stringify({
            version: CHECKPOINT_VERSION,
            hash: manifest.hash,
            chunks: chunks.map((chunk) => chunk.id),
          }),
          await this.nextStamp(head.created_at),
        ),
      ],
    };
    // Persist the converted packet before any upload; a reload retries these exact signed events.
    await this.savePending(upgraded);
    return upgraded;
  }
  private async document(): Promise<Y.Doc> {
    const doc = new Y.Doc();
    const saved = await this.repo.syncData.get("document");
    if (saved) Y.applyUpdate(doc, saved.value as Uint8Array);
    const facts = doc.getMap<string>("facts");
    for (const fact of await this.repo.readSyncFacts()) {
      const value = canonical(fact),
        previous = facts.get(fact.id);
      if (previous !== undefined && previous !== value)
        throw new Error("Sync fact identity was reused.");
      if (previous === undefined) facts.set(fact.id, value);
    }
    return doc;
  }
  private async saveDocument(doc: Y.Doc): Promise<void> {
    const data = Y.encodeStateAsUpdate(doc);
    if (data.length > MAX_DOCUMENT)
      throw new Error(
        "Wallet sync reached its storage limit. Recovery records have been retained; export a backup before continuing.",
      );
    await this.repo.syncData.put({ id: "document", value: data });
  }
  private async flushUnlocked(): Promise<void> {
    const doc = await this.document();
    try {
      const data = Y.encodeStateAsUpdate(doc);
      if (data.length > MAX_DOCUMENT)
        throw new Error(
          "Wallet sync reached its storage limit. Export a backup before continuing.",
        );
      const hash = await digest(data);
      let pending = (await this.repo.syncData.get("pending"))?.value as
        | PendingPacket
        | undefined;
      if (pending) {
        pending = await this.upgradePending(pending);
        await this.io.publishPacket(pending.events);
        await this.repo.syncData.put({
          id: "published",
          value: `${CHECKPOINT_VERSION}:${pending.hash}`,
        });
        await this.repo.syncData.delete("pending");
      }
      // Including the wire version republishes legacy checkpoints even when the document is unchanged.
      if (
        (await this.repo.syncData.get("published"))?.value ===
        `${CHECKPOINT_VERSION}:${hash}`
      ) {
        await this.saveDocument(doc);
        return;
      }
      const chunks: Event[] = [];
      for (let start = 0; start < data.length; start += CHUNK_SIZE)
        chunks.push(
          this.chunk(encode64(data.slice(start, start + CHUNK_SIZE))),
        );
      const stamp = await this.nextStamp();
      // Addressable-event replacement is by timestamp, including rapid consecutive wallet operations.
      const head = this.event(
        30078,
        [
          ["d", `${SCOPE}:${this.config.device}`],
          ["t", SCOPE],
        ],
        JSON.stringify({
          version: CHECKPOINT_VERSION,
          hash,
          chunks: chunks.map((c) => c.id),
        }),
        stamp,
      );
      pending = { hash, events: [...chunks, head] };
      await this.saveDocument(doc);
      await this.savePending(pending);
      await this.io.publishPacket(pending.events);
      await this.repo.syncData.put({
        id: "published",
        value: `${CHECKPOINT_VERSION}:${hash}`,
      });
      await this.repo.syncData.delete("pending");
    } finally {
      doc.destroy();
    }
  }
  /** Write-ahead barrier: publication only; never acquires the wallet lock or triggers mint side effects. */
  flush(): Promise<void> {
    return this.exclusive(() => this.flushUnlocked());
  }
  /** Caller holds the manager's wallet lock. A bad/incomplete checkpoint never changes wallet tables. */
  synchronize(requireRemote = false): Promise<void> {
    return this.exclusive(async () => {
      const heads = await this.io.query({
        kinds: [30078],
        authors: [this.pubkey],
        "#t": [SCOPE],
        limit: MAX_HEADS,
      });
      if (heads.length >= MAX_HEADS)
        throw new Error("Too many wallet checkpoints; no data was discarded.");
      if (requireRemote && !heads.length)
        throw new Error(
          "No saved wallet was found on these relays. Check the sync code and retry.",
        );
      const doc = await this.document();
      try {
        for (const head of heads) {
          const manifest = this.manifest(head);
          const chunkKind = manifest.version === 1 ? 78 : 30078;
          const chunkScope = manifest.version === 1 ? SCOPE : CHUNK_SCOPE;
          const events: Event[] = [];
          for (let i = 0; i < manifest.chunks.length; i += 64)
            events.push(
              ...(await this.io.query({
                ids: manifest.chunks.slice(i, i + 64),
                kinds: [chunkKind],
                authors: [this.pubkey],
              })),
            );
          const byId = new Map(events.map((e) => [e.id, e]));
          const pieces = manifest.chunks.map((id: string) => {
            const event = byId.get(id);
            if (!event)
              throw new Error(
                "A wallet checkpoint is incomplete. Recovery data was retained; retry synchronization.",
              );
            const piece = decode64(
              this.plaintext(event, chunkKind, chunkScope),
            );
            if (piece.length > CHUNK_SIZE)
              throw new Error("Wallet sync chunk is too large.");
            return piece;
          }) as Uint8Array[];
          const length = pieces.reduce((n, p) => n + p.length, 0);
          if (length > MAX_DOCUMENT)
            throw new Error("Wallet sync checkpoint is too large.");
          const data = new Uint8Array(length);
          let offset = 0;
          for (const piece of pieces) {
            data.set(piece, offset);
            offset += piece.length;
          }
          if ((await digest(data)) !== manifest.hash)
            throw new Error("Wallet checkpoint checksum does not match.");
          Y.applyUpdate(doc, data);
        }
        const map = doc.getMap<string>("facts");
        if (map.size > 100_000)
          throw new Error("Too many wallet sync records.");
        const facts: WalletSyncFact[] = [];
        for (const [id, value] of map.entries()) {
          if (typeof value !== "string")
            throw new Error("Invalid wallet sync record.");
          const fact = validateSyncFact(JSON.parse(value));
          if (fact.id !== id)
            throw new Error("Wallet sync record identity does not match.");
          facts.push(fact);
        }
        await this.repo.mergeSyncFacts(facts);
        await this.saveDocument(doc);
      } finally {
        doc.destroy();
      }
      await this.flushUnlocked();
    });
  }
  stop() {
    this.stopped = true;
    this.io.close();
  }
}
