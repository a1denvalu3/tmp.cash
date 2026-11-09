import { validateTmpCashState } from "coco-cashu-indexeddb/tmp-cash";
import { normalizePSMintUrl } from "@cashu/cashu-ts/tmp-cash";
import type { TmpCashState } from "coco-cashu-core/tmp-cash";

export const MAX_BACKUP_LENGTH = 16_000_000;

// The serialized format and authenticated-data bytes remain stable across the
// rebrand, allowing existing backups to be restored by tmp.cash.

const toBase64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (n) => String.fromCharCode(n)).join(""));
function fromBase64(raw: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
}
async function key(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  if (password.length < 12)
    throw new Error("Use a backup password with at least 12 characters");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export interface BackupKey {
  key: CryptoKey;
  salt: Uint8Array<ArrayBuffer>;
}
export async function createBackupKey(password: string): Promise<BackupKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await key(password, salt), salt };
}
function contents(state: TmpCashState, mint: string) {
  return {
    version: 1,
    mint: normalizePSMintUrl(mint),
    state: validateTmpCashState(state),
  };
}
function checked(raw: string) {
  if (new TextEncoder().encode(raw).byteLength > MAX_BACKUP_LENGTH)
    throw new Error("Wallet state is too large for a restorable backup");
  return raw;
}
export function plaintextBackup(state: TmpCashState, mint: string): string {
  return checked(
    JSON.stringify({ format: "tmp-cash-plaintext", ...contents(state, mint) }),
  );
}
export function isEncryptedBackup(raw: string): boolean {
  return JSON.parse(raw).format === "cashu-layer3-encrypted";
}
export async function restoreBackup(raw: string, password = "") {
  if (raw.length > MAX_BACKUP_LENGTH)
    throw new Error("Backup file is too large");
  if (isEncryptedBackup(raw)) return decryptBackup(raw, password);
  const data = JSON.parse(raw);
  if (
    data.format !== "tmp-cash-plaintext" ||
    data.version !== 1 ||
    typeof data.mint !== "string"
  )
    throw new Error("Unsupported backup format");
  return {
    mint: normalizePSMintUrl(data.mint),
    state: validateTmpCashState(data.state),
  };
}
export async function encryptBackup(
  state: TmpCashState,
  mint: string,
  password: string,
): Promise<string> {
  return encryptBackupWithKey(state, mint, await createBackupKey(password));
}
export async function encryptBackupWithKey(
  state: TmpCashState,
  mint: string,
  backupKey: BackupKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(
    checked(JSON.stringify(contents(state, mint))),
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode("cashu-layer3-backup-v1"),
    },
    backupKey.key,
    encoded,
  );
  const backup = JSON.stringify({
    format: "cashu-layer3-encrypted",
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: 250000,
    salt: toBase64(backupKey.salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  });
  return checked(backup);
}
export async function decryptBackup(
  raw: string,
  password: string,
): Promise<{ mint: string; state: TmpCashState }> {
  if (raw.length > MAX_BACKUP_LENGTH)
    throw new Error("Backup file is too large");
  const envelope = JSON.parse(raw);
  if (
    envelope.format !== "cashu-layer3-encrypted" ||
    envelope.version !== 1 ||
    envelope.kdf !== "PBKDF2-SHA256" ||
    envelope.iterations !== 250000 ||
    typeof envelope.salt !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  )
    throw new Error("Unsupported backup format");
  const salt = fromBase64(envelope.salt),
    iv = fromBase64(envelope.iv);
  if (salt.length !== 16 || iv.length !== 12)
    throw new Error("Invalid backup encryption parameters");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode("cashu-layer3-backup-v1"),
      },
      await key(password, salt),
      fromBase64(envelope.ciphertext),
    );
  } catch {
    throw new Error("Incorrect password or damaged backup");
  }
  const contents = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(plain),
  );
  if (contents.version !== 1 || typeof contents.mint !== "string")
    throw new Error("Unsupported backup contents");
  return {
    mint: normalizePSMintUrl(contents.mint),
    state: validateTmpCashState(contents.state),
  };
}
