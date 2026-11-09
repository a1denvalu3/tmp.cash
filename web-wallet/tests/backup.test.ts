import { it, expect } from "vitest";
import { encryptBackup, decryptBackup } from "../src/backup";
import type { TmpCashState } from "coco-cashu-core/tmp-cash";

const empty: TmpCashState = {
  proofs: [],
  operations: [],
  fundings: [],
  activity: [],
};
it("encrypts authenticated backups and rejects a wrong password or tampering", async () => {
  const password = "a test backup passphrase";
  const raw = await encryptBackup(empty, "http://localhost:3338", password);
  expect(raw).not.toContain("localhost");
  expect(raw).not.toContain("proofs");
  expect(await decryptBackup(raw, password)).toEqual({
    mint: "http://localhost:3338",
    state: empty,
  });
  await expect(
    decryptBackup(raw, "a different backup password"),
  ).rejects.toThrow();
  const envelope = JSON.parse(raw);
  envelope.ciphertext = "AAAA" + envelope.ciphertext.slice(4);
  await expect(
    decryptBackup(JSON.stringify(envelope), password),
  ).rejects.toThrow();
  await expect(
    encryptBackup(empty, "http://localhost:3338", "short"),
  ).rejects.toThrow("12");
});

it("refuses to export a backup that exceeds the restore limit", async () => {
  const state: TmpCashState = {
    ...empty,
    activity: Array.from({ length: 100_000 }, (_, i) => ({
      id: i.toString(16).padStart(64, "0"),
      mint: "http://localhost:3338",
      purpose: "mint",
      amount: 1,
      createdAt: 1,
      state: "complete",
      token: null,
      receipt: null,
    })),
  };
  await expect(
    encryptBackup(state, "http://localhost:3338", "a test backup passphrase"),
  ).rejects.toThrow("too large");
});

it("supports plaintext recovery and rejects malformed wallet state", async () => {
  const { plaintextBackup, restoreBackup } = await import("../src/backup");
  const raw = plaintextBackup(empty, "http://localhost:3338/");
  expect(raw).toContain('"proofs"');
  expect(await restoreBackup(raw)).toEqual({
    mint: "http://localhost:3338",
    state: empty,
  });
  const damaged = JSON.parse(raw);
  damaged.state.proofs = [{}];
  await expect(restoreBackup(JSON.stringify(damaged))).rejects.toThrow();
  await expect(
    restoreBackup(JSON.stringify({ ...damaged, format: "unknown" })),
  ).rejects.toThrow("Unsupported");
});

it("encrypts automatic saves with a persisted non-extractable key and a fresh IV", async () => {
  const { createBackupKey, encryptBackupWithKey, restoreBackup } = await import(
    "../src/backup"
  );
  const password = "a key saved only on this device";
  const backupKey = await createBackupKey(password);
  expect(backupKey.key.extractable).toBe(false);
  const persisted = structuredClone(backupKey);
  const a = await encryptBackupWithKey(
    empty,
    "http://localhost:3338",
    persisted,
  );
  const b = await encryptBackupWithKey(
    empty,
    "http://localhost:3338",
    persisted,
  );
  expect(JSON.parse(a).iv).not.toEqual(JSON.parse(b).iv);
  expect(await restoreBackup(b, password)).toEqual({
    mint: "http://localhost:3338",
    state: empty,
  });
});
