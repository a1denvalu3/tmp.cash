import { expect, it } from "vitest";
import { GoogleDrive } from "../src/google-drive";
import { AppleCloud } from "../src/apple-cloud";
import { responseText } from "../src/CloudTypes";
const user = {
  account: "google:test-user",
  provider: "google" as const,
  label: "wallet-test@example.com",
};
const session = {
  user,
  token: "private-cloud-access-token",
  expires: Date.now() + 3600000,
};
const payload = JSON.stringify({
  format: "tmp-cash-plaintext",
  version: 1,
  mint: "https://mint.example",
  state: { proofs: [], operations: [], fundings: [], activity: [] },
});

it("stores immutable snapshots only in Drive app data and recovers a lost upload acknowledgement", async () => {
  let saved: any = null,
    posts = 0;
  const urls: string[] = [];
  const drive = new GoogleDrive(session, async (input, init) => {
    const url = new URL(String(input));
    urls.push(url.href);
    expect(url.hostname).toBe("www.googleapis.com");
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer private-cloud-access-token",
    );
    if (init?.method === "POST") {
      posts++;
      const body = await (init.body as Blob).text();
      expect(body).toContain(payload);
      expect(body).toContain('"parents":["appDataFolder"]');
      saved = {
        id: "drive-file-id",
        name: "My wallet",
        appProperties: {
          walletId: "wallet-id",
          uploadId: "snapshot-id",
          created: "1000",
          encrypted: "false",
        },
      };
      throw new TypeError(
        "Response lost after the server accepted this upload",
      );
    }
    expect(url.searchParams.get("spaces")).toBe("appDataFolder");
    return Response.json({ files: saved ? [saved] : [] });
  });
  await expect(
    drive.upload("wallet-id", "snapshot-id", 1000, payload, "My wallet"),
  ).rejects.toThrow();
  const recovered = await drive.upload(
    "wallet-id",
    "snapshot-id",
    1000,
    payload,
    "My wallet",
  );
  expect(recovered).toEqual({
    id: "drive-file-id",
    name: "My wallet",
    walletId: "wallet-id",
    updated: 1000,
    encrypted: false,
  });
  expect(posts).toBe(1);
  expect(urls).toHaveLength(3);
});

it("asks to reconnect after expiry and does not send expired tokens", async () => {
  let calls = 0;
  const expired = new GoogleDrive({ ...session, expires: 1 }, async () => {
    calls++;
    return Response.json({});
  });
  await expect(expired.list()).rejects.toMatchObject({ reconnect: true });
  expect(calls).toBe(0);
  const revoked = new GoogleDrive(session, async () =>
    Response.json({ sensitive: "provider details" }, { status: 401 }),
  );
  await expect(revoked.list()).rejects.toMatchObject({ reconnect: true });
});

it("bounds downloaded provider data before parsing it", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(11));
      controller.close();
    },
  });
  await expect(responseText(new Response(stream), 10)).rejects.toThrow(
    "too large",
  );
});

it("keeps iCloud chunks private and hides incomplete uploads until the manifest is saved", async () => {
  const stored = new Map<string, any>();
  let failChunks = true;
  const writes: string[][] = [];
  const database = {
    async performQuery() {
      return {
        records: [...stored.values()].filter(
          (record) => record.recordType === "TmpCashBackup",
        ),
      };
    },
    async fetchRecords(ids: string[]) {
      return {
        records: ids.map(
          (id) =>
            stored.get(id) ?? { recordName: id, serverErrorCode: "NOT_FOUND" },
        ),
      };
    },
    async saveRecords(records: any[]) {
      writes.push(records.map((record) => record.recordName));
      for (const record of records) {
        expect(stored.has(record.recordName)).toBe(false);
        stored.set(record.recordName, record);
      }
      if (failChunks && records[0]?.recordType === "TmpCashBackupChunk") {
        failChunks = false;
        throw new TypeError("Lost chunk response");
      }
      return { records };
    },
    async deleteRecords(ids: string[]) {
      for (const id of ids) stored.delete(id);
      return { records: [] };
    },
  };
  const container = {
    privateCloudDatabase: database,
    setUpAuth: async () => null,
    whenUserSignsIn: async () => ({ userRecordName: "test-user" }),
    signOut() {},
    get publicCloudDatabase(): never {
      throw Error("Public iCloud storage must never be used");
    },
  };
  const apple = new AppleCloud(
    { account: "apple:test-user", provider: "apple", label: "Apple user" },
    container,
  );
  const prefix = '{"format":"tmp-cash-plaintext","padding":"';
  const raw =
    prefix +
    "x".repeat(249999 - prefix.length) +
    "😀" +
    "x".repeat(350000) +
    '"}';
  await expect(
    apple.upload("wallet-id", "snapshot-id", 1000, raw, "My wallet"),
  ).rejects.toThrow("Lost chunk");
  expect(await apple.list()).toEqual([]);
  const recovered = await apple.upload(
    "wallet-id",
    "snapshot-id",
    1000,
    raw,
    "My wallet",
  );
  expect(recovered.id).toBe("backup-snapshot-id");
  expect(writes).toHaveLength(2); // Chunk retries reuse confirmed records.
  for (const record of stored.values()) {
    if (record.recordType === "TmpCashBackupChunk") {
      const last = record.fields.data.value.charCodeAt(
        record.fields.data.value.length - 1,
      );
      expect(last < 0xd800 || last > 0xdbff).toBe(true);
    }
  }
  expect(writes.at(-1)).toEqual(["backup-snapshot-id"]);
  expect(await apple.download(recovered.id)).toBe(raw);
  expect((await apple.list())[0]).toEqual(recovered);
  await apple.remove(recovered.id);
  expect(stored.size).toBe(0);
});
