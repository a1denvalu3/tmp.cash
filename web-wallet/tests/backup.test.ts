import { it, expect } from "vitest";
import {
  encryptBackup,
  decryptBackup,
  plaintextBackup,
  restoreBackup,
  backupProtection,
  recoveryCodec,
  newProtection,
} from "../src/backup";
import { psPreimageHash } from "@cashu/cashu-ts/tmp-cash";
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
  expect(() => plaintextBackup(state, "http://localhost:3338")).toThrow(
    "too large",
  );
});

it("requires an explicit plaintext format and preserves funding recovery secrets", async () => {
  const preimage = "ab".repeat(32);
  const state: TmpCashState = {
    ...empty,
    fundings: [
      {
        id: psPreimageHash(preimage),
        mint: "http://localhost:3338",
        amount: 10,
        preimage,
        invoiceExpiry: 3600,
        quote: null,
        state: "waiting",
        createdAt: 1,
      },
    ],
  };
  const raw = plaintextBackup(state, "http://localhost:3338/");
  expect(raw).toContain(preimage);
  expect(backupProtection(raw)).toEqual({ mode: "plaintext" });
  expect((await restoreBackup(raw)).state).toEqual(state);
  await expect(
    restoreBackup(
      JSON.stringify({ version: 1, mint: "http://localhost:3338", state }),
    ),
  ).rejects.toThrow("Unsupported");
  await expect(decryptBackup(raw, "a test backup passphrase")).rejects.toThrow(
    "encrypted",
  );
  await expect(restoreBackup("SECRET invalid json")).rejects.toThrow(
    "Invalid backup file",
  );
  await expect(
    restoreBackup(raw.replace(preimage, "cd".repeat(32))),
  ).rejects.toThrow("inconsistent");
});

it("reuses a session key with fresh IVs and restores through the existing encrypted format", async () => {
  const password = "a reusable recovery passphrase";
  const protection = newProtection("passphrase");
  const codec = await recoveryCodec(protection, password);
  const first = await codec.encode(empty, "http://localhost:3338");
  const second = await codec.encode(empty, "http://localhost:3338");
  expect(first).not.toEqual(second);
  expect(backupProtection(first)).toEqual(protection);
  expect(await codec.decode(second)).toEqual(
    await decryptBackup(first, password),
  );
  await expect(recoveryCodec(protection)).rejects.toThrow("12");
  await expect(
    codec.decode(plaintextBackup(empty, "http://localhost:3338")),
  ).rejects.toThrow("protection changed");
  const clear = await recoveryCodec(newProtection("plaintext"));
  expect(
    await clear.decode(await clear.encode(empty, "http://localhost:3338")),
  ).toMatchObject({ state: empty });
  await expect(clear.decode(first)).rejects.toThrow("protection changed");
});
