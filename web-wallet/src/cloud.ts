import type { TmpCashRepository } from "coco-cashu-core/tmp-cash";
import {
  encryptBackupWithKey,
  plaintextBackup,
  type BackupKey,
  restoreBackupWithKey,
} from "./backup";
import type { WalletSyncBackup } from "./sync-document";
import { createWalletSyncBackup, mergeWalletSyncBackup } from "./sync-document";
import type { TmpCashIndexedDbRepository } from "coco-cashu-indexeddb/tmp-cash";
import { readSyncSettings } from "./nostr-sync";
import { CloudError, type CloudClient, type CloudBackup } from "./CloudTypes";
export type {
  CloudBackup,
  CloudUser,
  CloudClient,
  CloudProvider,
} from "./CloudTypes";
export interface CloudSettings {
  storage: "provider-v1";
  account: string;
  id: string;
  name: string;
  encryption: BackupKey | null;
  fingerprint: string;
  updated: number;
  pending?: {
    id: string;
    created: number;
    payload: string;
    fingerprint: string;
  };
}
async function settingsStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("tmp_cash_cloud", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("settings");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("settings", mode);
      const request = fn(transaction.objectStore("settings"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error(
              "Your backup settings couldn’t be saved. Please try again.",
            ),
        );
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
export async function readCloudSettings() {
  const value = await settingsStore<CloudSettings | undefined>(
    "readonly",
    (s) => s.get("active"),
  );
  // The unreleased mint-hosted prototype never opts users into a different
  // storage provider. New provider storage requires the guided consent flow.
  return value?.storage === "provider-v1" ? value : undefined;
}
const writeSettings = (value: CloudSettings) =>
  settingsStore("readwrite", (s) => s.put(value, "active"));
export async function cloudLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "Automatic backup needs a newer browser. You can still download a backup file.",
    );
  return navigator.locks.request("tmp-cash-cloud-backup", fn);
}
export const enableCloud = (value: CloudSettings) =>
  cloudLock(() => writeSettings(value));
export const pauseCloud = () =>
  cloudLock(() => settingsStore("readwrite", (s) => s.delete("active")));
export interface CloudProgress {
  enabled: boolean;
  updated: number;
  encrypted: boolean;
  message: string;
  saving?: boolean;
  error?: boolean;
  reconnect?: boolean;
}
export class CloudSaver {
  private stopped = false;
  private running: Promise<void> | null = null;
  constructor(
    private repo: TmpCashRepository,
    private mint: () => string,
    private client: CloudClient,
    private report: (value: CloudProgress) => void,
  ) {}
  stop() {
    this.stopped = true;
  }
  async flush(): Promise<void> {
    await this.save();
    const settings = await readCloudSettings();
    if (
      this.stopped ||
      settings?.account !== this.client.user.account ||
      settings.pending ||
      !settings.fingerprint
    ) {
      throw new CloudError(
        "Wallet synchronization stopped before recovery data was confirmed. Reconnect and retry.",
      );
    }
  }
  save(force = false): Promise<void> {
    if (this.running) return this.running;
    this.running = cloudLock(async () => {
      if (this.stopped) return;
      let settings = await readCloudSettings();
      if (!settings || settings.account !== this.client.user.account) {
        this.report({
          enabled: false,
          updated: 0,
          encrypted: true,
          message: "Automatic backup is paused.",
        });
        return;
      }
      try {
        for (let pass = 0; pass < 2; pass++) {
          const progress = {
            enabled: true,
            encrypted: !!settings.encryption,
            updated: settings.updated,
          };
          const mint = this.mint();
          let sync: WalletSyncBackup | undefined;
          const syncRepo =
            this.client.user.provider === "google" &&
            "enableSyncJournal" in this.repo
              ? (this.repo as TmpCashIndexedDbRepository)
              : null;
          let files: CloudBackup[] = [];
          if (syncRepo) {
            await syncRepo.enableSyncJournal();
            files = (await this.client.list()).filter(
              (file) => file.walletId === settings!.id,
            );
            const seenKey = `drive-seen:${settings.account}:${settings.id}`;
            const seen = new Set(
              ((await syncRepo.syncData.get(seenKey))?.value as string[]) ?? [],
            );
            for (const file of files) {
              // Legacy snapshots have no shared CRDT identity; they remain available for explicit restore.
              if (seen.has(file.id) || !file.writer) continue;
              const data = await restoreBackupWithKey(
                await this.client.download(file.id),
                settings.encryption,
              );
              if (data.sync) await mergeWalletSyncBackup(syncRepo, data.sync);
              seen.add(file.id);
            }
            await syncRepo.syncData.put({
              id: seenKey,
              value: files.map((file) => file.id).filter((id) => seen.has(id)),
            });
            sync = await createWalletSyncBackup(syncRepo, mint);
          }
          const state = await this.repo.read();
          const fingerprint = Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(
                  JSON.stringify({ state, mint, ...(sync ? { sync } : {}) }),
                ),
              ),
            ),
            (n) => n.toString(16).padStart(2, "0"),
          ).join("");
          if (
            !settings.pending &&
            !force &&
            settings.fingerprint === fingerprint
          ) {
            if (!this.stopped)
              this.report({
                ...progress,
                message: "Your wallet is backed up automatically.",
              });
            return;
          }
          if (!this.stopped)
            this.report({
              ...progress,
              saving: true,
              message: "Saving your backup…",
            });
          const pending: NonNullable<CloudSettings["pending"]> =
            settings.pending ?? {
              id: crypto.randomUUID(),
              created: Date.now(),
              fingerprint,
              payload: settings.encryption
                ? await encryptBackupWithKey(
                    state,
                    mint,
                    settings.encryption,
                    sync,
                  )
                : plaintextBackup(state, mint, sync),
            };
          if (!settings.pending) {
            settings = { ...settings, pending };
            await writeSettings(settings);
          }
          if (this.stopped) return;
          const result = await this.client.upload(
            settings.id,
            pending.id,
            pending.created,
            pending.payload,
            settings.name,
            syncRepo ? (await readSyncSettings(syncRepo))?.device : undefined,
          );
          settings = {
            ...settings,
            pending: undefined,
            updated: result.updated,
            fingerprint: pending.fingerprint,
          };
          await writeSettings(settings);
          if (syncRepo) {
            const writer = (await readSyncSettings(syncRepo))?.device;
            // Retain the current and previous checkpoint per writer. Other devices' files are untouched.
            const own = files
              .filter((file) => file.writer === writer && file.id !== result.id)
              .sort((a, b) => b.updated - a.updated);
            for (const old of own.slice(1)) {
              try {
                await this.client.remove(old.id);
              } catch {
                /* Retry cleanup on the next successful save. */
              }
            }
          }
          if (pass === 0 && pending.fingerprint !== fingerprint) continue;
          if (!this.stopped)
            this.report({
              ...progress,
              updated: result.updated,
              message: "Your wallet is backed up automatically.",
            });
          return;
        }
      } catch (error) {
        if (!this.stopped)
          this.report({
            enabled: true,
            encrypted: !!settings.encryption,
            updated: settings.updated,
            error: true,
            reconnect: error instanceof CloudError && error.reconnect,
            message:
              error instanceof CloudError
                ? error.message
                : "Your backup couldn’t be saved. We’ll try again when you’re online.",
          });
        throw error;
      }
    }).finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
