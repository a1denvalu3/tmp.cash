import type { TmpCashRepository } from "coco-cashu-core/tmp-cash";
import {
  encryptBackupWithKey,
  plaintextBackup,
  type BackupKey,
} from "./backup";

export interface CloudUser {
  account: string;
  provider: string;
  label: string;
}
export interface CloudBackup {
  id: string;
  name: string;
  revision: number;
  updated: number;
  encrypted: boolean;
}
export interface CloudSettings {
  account: string;
  id: string;
  name: string;
  encryption: BackupKey | null;
  revision: number;
  fingerprint: string;
  updated: number;
  pending?: { payload: string; fingerprint: string };
}
export class CloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function cloudRequest<T>(
  path: string,
  init: RequestInit = {},
  account?: string,
): Promise<T> {
  const response = await fetch("/api/cloud" + path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Cloud-Request": "1",
      ...(account ? { "X-Cloud-Account": account } : {}),
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    // Only display server messages from our JSON API, never proxy HTML.
    const error = await response.json().catch(() => null);
    throw new CloudError(
      typeof error?.detail === "string"
        ? error.detail
        : "Cloud backup service is unavailable. Try again when online.",
      response.status,
    );
  }
  return response.json();
}

// CryptoKey is structured-cloned into IndexedDB, never exported or replaced by
// the passphrase. Browser data loss still requires the original passphrase.
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
            new Error("Could not save cloud backup settings"),
        );
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
export const readCloudSettings = () =>
  settingsStore<CloudSettings | undefined>("readonly", (s) => s.get("active"));
const writeSettings = (value: CloudSettings) =>
  settingsStore("readwrite", (s) => s.put(value, "active"));
export async function cloudLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "Automatic cloud backups require a browser with Web Locks support.",
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
}
export class CloudSaver {
  private stopped = false;
  private running: Promise<void> | null = null;
  constructor(
    private repo: TmpCashRepository,
    private mint: () => string,
    private account: string,
    private report: (progress: CloudProgress) => void,
  ) {}
  stop() {
    this.stopped = true;
  }
  save(force = false): Promise<void> {
    if (this.running) return this.running;
    this.running = cloudLock(async () => {
      if (this.stopped) return;
      let settings = await readCloudSettings();
      if (!settings || settings.account !== this.account) {
        this.report({
          enabled: false,
          updated: 0,
          encrypted: true,
          message: "Automatic backups are paused on this browser.",
        });
        return;
      }
      try {
        // A retry first finishes its exact saved upload. If that snapshot is
        // behind the wallet, save the current state in the same pass as well.
        for (let pass = 0; pass < 2; pass++) {
          const progress = {
            enabled: true,
            encrypted: !!settings.encryption,
            updated: settings.updated,
          };
          const state = await this.repo.read();
          const mint = this.mint();
          const fingerprint = Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(JSON.stringify({ state, mint })),
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
                message:
                  "Changes are saved automatically while this wallet is open.",
              });
            return;
          }
          if (!this.stopped)
            this.report({
              ...progress,
              saving: true,
              message: "Saving cloud backup…",
            });
          const pending: NonNullable<CloudSettings["pending"]> =
            settings.pending ?? {
              payload: settings.encryption
                ? await encryptBackupWithKey(state, mint, settings.encryption)
                : plaintextBackup(state, mint),
              fingerprint,
            };
          if (!settings.pending) {
            settings = { ...settings, pending };
            // Save before sending, so reloads and response loss replay the same
            // ciphertext/IV and revision rather than creating a conflicting save.
            await writeSettings(settings);
          }
          if (this.stopped) return;
          const result: CloudBackup = await cloudRequest<CloudBackup>(
            "/backups/" + settings.id,
            {
              method: "PUT",
              body: JSON.stringify({
                name: settings.name,
                revision: settings.revision,
                payload: pending.payload,
                acknowledgeUnencrypted: !settings.encryption,
              }),
            },
            this.account,
          );
          settings = {
            ...settings,
            revision: result.revision,
            updated: result.updated,
            fingerprint: pending.fingerprint,
            pending: undefined,
          };
          await writeSettings(settings);
          if (pass === 0 && pending.fingerprint !== fingerprint) continue;
          if (!this.stopped)
            this.report({
              ...progress,
              updated: result.updated,
              message:
                "Changes are saved automatically while this wallet is open.",
            });
          return;
        }
      } catch (error) {
        if (!this.stopped)
          this.report({
            enabled: true,
            encrypted: !!settings.encryption,
            updated: settings.updated,
            message:
              error instanceof Error
                ? error.message
                : "Cloud backup failed. Retrying automatically.",
          });
        throw error;
      }
    }).finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
