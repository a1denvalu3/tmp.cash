import * as Y from "yjs";
import {
  canonical,
  validateSyncFact,
  type TmpCashIndexedDbRepository,
  type WalletSyncFact,
} from "coco-cashu-indexeddb/tmp-cash";
import {
  createSyncSettings,
  DEFAULT_SYNC_RELAY,
  exportSyncCode,
  importSyncCode,
  readSyncSettings,
  saveSyncSettings,
} from "./nostr-sync";

/** Stored inside the same encrypted envelope as the recoverable wallet state. */
export interface WalletSyncBackup {
  version: 1;
  document: string;
  fallback: string;
}
const encode = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
const decode = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
function facts(doc: Y.Doc): WalletSyncFact[] {
  const map = doc.getMap<string>("facts");
  if (map.size > 100_000) throw new Error("Too many wallet sync records.");
  return [...map.entries()].map(([id, raw]) => {
    if (typeof raw !== "string") throw new Error("Invalid wallet sync record.");
    const fact = validateSyncFact(JSON.parse(raw));
    if (fact.id !== id) throw new Error("Sync record identity does not match.");
    return fact;
  });
}
export function validateWalletSyncBackup(input: unknown): WalletSyncBackup {
  const value = input as WalletSyncBackup;
  if (
    !value ||
    value.version !== 1 ||
    typeof value.document !== "string" ||
    value.document.length > 12_000_000 ||
    typeof value.fallback !== "string"
  )
    throw new Error("Invalid wallet synchronization backup.");
  importSyncCode(value.fallback);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, decode(value.document));
    facts(doc);
  } finally {
    doc.destroy();
  }
  return { version: 1, document: value.document, fallback: value.fallback };
}
export async function walletDocument(
  repo: TmpCashIndexedDbRepository,
): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const saved = await repo.syncData.get("document");
  if (saved) Y.applyUpdate(doc, saved.value as Uint8Array);
  const map = doc.getMap<string>("facts");
  for (const fact of await repo.readSyncFacts()) {
    const value = canonical(fact),
      previous = map.get(fact.id);
    if (previous !== undefined && previous !== value)
      throw new Error("Sync record identity was reused.");
    if (previous === undefined) map.set(fact.id, value);
  }
  return doc;
}
export async function createWalletSyncBackup(
  repo: TmpCashIndexedDbRepository,
  mint: string,
): Promise<WalletSyncBackup> {
  let config = await readSyncSettings(repo);
  if (!config) {
    config = createSyncSettings([DEFAULT_SYNC_RELAY], mint);
    await saveSyncSettings(repo, config);
  }
  const doc = await walletDocument(repo);
  try {
    const bytes = Y.encodeStateAsUpdate(doc);
    const result = validateWalletSyncBackup({
      version: 1,
      document: encode(bytes),
      fallback: exportSyncCode(config),
    });
    await repo.syncData.put({ id: "document", value: bytes });
    return result;
  } finally {
    doc.destroy();
  }
}
export async function assertWalletSyncGroup(
  repo: TmpCashIndexedDbRepository,
  backup?: WalletSyncBackup,
): Promise<void> {
  const current = await readSyncSettings(repo);
  if (
    current &&
    (!backup || current.secret !== importSyncCode(backup.fallback).secret)
  )
    throw new Error(
      "This device belongs to a different wallet sync group. Restore in a new browser profile.",
    );
}

export async function mergeWalletSyncBackup(
  repo: TmpCashIndexedDbRepository,
  value: WalletSyncBackup,
): Promise<void> {
  const backup = validateWalletSyncBackup(value);
  const config = importSyncCode(backup.fallback),
    previous = await readSyncSettings(repo);
  if (previous && previous.secret !== config.secret)
    throw new Error("This backup belongs to a different wallet sync group.");
  const doc = await walletDocument(repo);
  try {
    Y.applyUpdate(doc, decode(backup.document));
    const records = facts(doc);
    // Validate and project all incoming records before committing document bytes.
    await repo.mergeSyncFacts(records);
    await repo.syncData.put({
      id: "document",
      value: Y.encodeStateAsUpdate(doc),
    });
    if (!previous) await saveSyncSettings(repo, config);
  } finally {
    doc.destroy();
  }
}
