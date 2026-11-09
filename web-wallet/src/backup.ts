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
export type RecoveryProtection =
  | { mode: "plaintext" }
  | { mode: "passphrase"; salt: string };
export interface RecoveryCodec {
  protection: RecoveryProtection;
  encode(state: TmpCashState, mint: string): Promise<string>;
  decode(raw: string): Promise<{ mint: string; state: TmpCashState }>;
}
function parseBackup(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid backup file");
  }
}
function contents(state: TmpCashState, mint: string) {
  return {
    version: 1,
    mint: normalizePSMintUrl(mint),
    state: validateTmpCashState(state),
  };
}
export function plaintextBackup(state: TmpCashState, mint: string): string {
  const raw = JSON.stringify({
    format: "tmp.cash-plaintext",
    ...contents(state, mint),
  });
  if (new TextEncoder().encode(raw).byteLength > MAX_BACKUP_LENGTH)
    throw new Error("Wallet state is too large for a restorable backup");
  return raw;
}
export function backupProtection(raw: string): RecoveryProtection {
  if (raw.length > MAX_BACKUP_LENGTH)
    throw new Error("Backup file is too large");
  const value = parseBackup(raw);
  if (value?.format === "tmp.cash-plaintext" && value.version === 1)
    return { mode: "plaintext" };
  if (
    value?.format === "cashu-layer3-encrypted" &&
    value.version === 1 &&
    typeof value.salt === "string" &&
    fromBase64(value.salt).length === 16
  )
    return { mode: "passphrase", salt: value.salt };
  throw new Error("Unsupported backup format");
}
export async function restoreBackup(raw: string, password = "") {
  if (backupProtection(raw).mode === "passphrase")
    return decryptBackup(raw, password);
  const value = parseBackup(raw);
  return contents(value.state, value.mint);
}
/** Session-only key: never persist the passphrase or derived key. */
export async function recoveryCodec(
  protection: RecoveryProtection,
  password = "",
): Promise<RecoveryCodec> {
  if (protection.mode === "plaintext")
    return {
      protection,
      encode: async (state, mint) => plaintextBackup(state, mint),
      decode: async (raw) => {
        if (backupProtection(raw).mode !== "plaintext")
          throw new Error("Backup protection changed");
        return restoreBackup(raw);
      },
    };
  const salt = fromBase64(protection.salt);
  if (salt.length !== 16)
    throw new Error("Invalid backup encryption parameters");
  const sessionKey = await key(password, salt);
  return {
    protection,
    encode: (state, mint) => encryptWithKey(state, mint, sessionKey, salt),
    decode: async (raw) => {
      const metadata = backupProtection(raw);
      if (metadata.mode !== "passphrase" || metadata.salt !== protection.salt)
        throw new Error("Backup protection changed");
      return decryptWithKey(raw, sessionKey);
    },
  };
}
export function newProtection(
  mode: "passphrase" | "plaintext",
): RecoveryProtection {
  return mode === "plaintext"
    ? { mode }
    : {
        mode,
        salt: toBase64(crypto.getRandomValues(new Uint8Array(16))),
      };
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
export async function encryptBackup(
  state: TmpCashState,
  mint: string,
  password: string,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return encryptWithKey(state, mint, await key(password, salt), salt);
}
async function encryptWithKey(
  state: TmpCashState,
  mint: string,
  sessionKey: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const contents = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      mint: normalizePSMintUrl(mint),
      state: validateTmpCashState(state),
    }),
  );
  if (contents.byteLength > MAX_BACKUP_LENGTH)
    throw new Error("Wallet state is too large for a restorable backup");
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode("cashu-layer3-backup-v1"),
    },
    sessionKey,
    contents,
  );
  const backup = JSON.stringify({
    format: "cashu-layer3-encrypted",
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: 250000,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  });
  if (backup.length > MAX_BACKUP_LENGTH)
    throw new Error("Wallet state is too large for a restorable backup");
  return backup;
}
export async function decryptBackup(
  raw: string,
  password: string,
): Promise<{ mint: string; state: TmpCashState }> {
  const metadata = backupProtection(raw);
  if (metadata.mode !== "passphrase")
    throw new Error("Expected an encrypted backup");
  return decryptWithKey(raw, await key(password, fromBase64(metadata.salt)));
}
async function decryptWithKey(
  raw: string,
  sessionKey: CryptoKey,
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
      sessionKey,
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
