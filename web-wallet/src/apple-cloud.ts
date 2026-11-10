import { isEncryptedBackup, MAX_BACKUP_LENGTH } from "./backup";
import {
  CloudError,
  loadCloudScript,
  type CloudBackup,
  type CloudClient,
  type CloudUser,
} from "./CloudTypes";

export const appleContainer =
  import.meta.env.VITE_APPLE_CLOUDKIT_CONTAINER?.trim() || "";
export const appleApiToken =
  import.meta.env.VITE_APPLE_CLOUDKIT_API_TOKEN?.trim() || "";
export const appleConfigured = !!appleContainer && !!appleApiToken;
type Fields = Record<string, { value: string | number | boolean }>;
interface RecordValue {
  recordName: string;
  recordType?: string;
  fields?: Fields;
  serverErrorCode?: string;
}
interface Records {
  records?: RecordValue[];
  errors?: { ckErrorCode?: string }[];
  hasErrors?: boolean;
}
interface Identity {
  userRecordName: string;
  nameComponents?: { givenName?: string; familyName?: string };
}
interface Database {
  performQuery(
    query: { recordType: string },
    options?: { resultsLimit: number },
  ): Promise<Records>;
  fetchRecords(ids: string[]): Promise<Records>;
  saveRecords(records: RecordValue[]): Promise<Records>;
  deleteRecords(ids: string[]): Promise<Records>;
}
interface Container {
  privateCloudDatabase: Database;
  setUpAuth(): Promise<Identity | null>;
  whenUserSignsIn(): Promise<Identity>;
  signOut(): void;
}
interface CloudKitSdk {
  configure(value: unknown): void;
  getDefaultContainer(): Container;
}
declare global {
  interface Window {
    CloudKit?: CloudKitSdk;
  }
}
let container: Container | null = null;
export async function prepareApple(): Promise<Container> {
  if (!appleConfigured)
    throw new CloudError("Apple backup is not available here yet.");
  await loadCloudScript(
    "https://cdn.apple-cloudkit.com/ck/2/cloudkit.js",
    () => !!window.CloudKit,
  );
  if (!container) {
    window.CloudKit!.configure({
      containers: [
        {
          containerIdentifier: appleContainer,
          apiTokenAuth: {
            apiToken: appleApiToken,
            persist: true,
            signInButton: { id: "apple-sign-in-button", theme: "black" },
            signOutButton: { id: "apple-sign-out-button", theme: "black" },
          },
          environment:
            import.meta.env.VITE_APPLE_CLOUDKIT_ENVIRONMENT === "production"
              ? "production"
              : "development",
        },
      ],
    });
    container = window.CloudKit!.getDefaultContainer();
  }
  return container;
}
function client(identity: Identity, value: Container) {
  if (!identity.userRecordName)
    throw new CloudError(
      "Apple sign-in could not be completed. Please try again.",
    );
  const label =
    [identity.nameComponents?.givenName, identity.nameComponents?.familyName]
      .filter(Boolean)
      .join(" ") || "Your Apple account";
  return new AppleCloud(
    { account: "apple:" + identity.userRecordName, provider: "apple", label },
    value,
  );
}
export async function restoreAppleSession() {
  if (!appleConfigured) return null;
  const value = await prepareApple();
  const identity = await value.setUpAuth();
  return identity ? client(identity, value) : null;
}
export async function mountAppleSignIn(
  connected: (value: CloudClient) => void,
) {
  const value = await prepareApple();
  const identity = await value.setUpAuth();
  if (identity) {
    connected(client(identity, value));
    return;
  }
  // Apple's SDK supplies its own sign-in button and owns the popup. No Apple
  // credentials, account identifiers, or records pass through the mint.
  const next = await value.whenUserSignsIn();
  connected(client(next, value));
}
function records(response: Records): RecordValue[] {
  if (response.hasErrors || response.records?.some((r) => r.serverErrorCode))
    throw new CloudError(
      "iCloud couldn’t complete this backup. Reconnect Apple and try again.",
      true,
    );
  return response.records ?? [];
}
function metadata(value: RecordValue): CloudBackup {
  const f = value.fields;
  if (
    !f ||
    typeof f.walletId?.value !== "string" ||
    typeof f.name?.value !== "string" ||
    !Number.isFinite(Number(f.created?.value))
  )
    throw new CloudError("This iCloud backup could not be read.");
  return {
    id: value.recordName,
    walletId: f.walletId.value,
    name: f.name.value,
    updated: Number(f.created.value),
    encrypted: f.encrypted?.value === 1,
  };
}
export class AppleCloud implements CloudClient {
  constructor(
    readonly user: CloudUser,
    private container: Container,
  ) {}
  async list() {
    return records(
      await this.container.privateCloudDatabase.performQuery(
        { recordType: "TmpCashBackup" },
        { resultsLimit: 200 },
      ),
    )
      .map(metadata)
      .sort((a, b) => b.updated - a.updated);
  }
  private async manifest(id: string) {
    if (!/^[\w-]+$/.test(id))
      throw new CloudError("This backup could not be found.");
    const response = await this.container.privateCloudDatabase.fetchRecords([
      id,
    ]);
    return (
      response.records?.find(
        (value) => !value.serverErrorCode && value.recordName === id,
      ) ?? null
    );
  }
  async download(id: string) {
    const value = await this.manifest(id);
    const count = Number(value?.fields?.chunks?.value);
    if (!value || !Number.isInteger(count) || count < 1 || count > 64)
      throw new CloudError("This iCloud backup could not be read.");
    const parts = records(
      await this.container.privateCloudDatabase.fetchRecords(
        Array.from({ length: count }, (_, i) => id + "-" + i),
      ),
    );
    const payload = Array.from({ length: count }, (_, i) => {
      const part = parts.find((r) => r.recordName === id + "-" + i)?.fields
        ?.data?.value;
      if (typeof part !== "string")
        throw new CloudError(
          "This iCloud backup is incomplete. Choose another saved copy.",
        );
      return part;
    }).join("");
    if (new TextEncoder().encode(payload).byteLength > MAX_BACKUP_LENGTH)
      throw new CloudError("This backup is too large to restore.");
    return payload;
  }
  async upload(
    walletId: string,
    uploadId: string,
    created: number,
    payload: string,
    name: string,
  ) {
    if (!/^[\w-]+$/.test(walletId) || !/^[\w-]+$/.test(uploadId))
      throw new CloudError("This backup could not be saved.");
    if (new TextEncoder().encode(payload).byteLength > MAX_BACKUP_LENGTH)
      throw new CloudError("This backup is too large to save.");
    const id = "backup-" + uploadId;
    const existing = await this.manifest(id);
    if (existing) return metadata(existing);
    // Chunks stay below CloudKit's per-record limit. The manifest is written
    // last, so a partial upload never appears as a restorable backup.
    const parts: string[] = [];
    for (let start = 0; start < payload.length; ) {
      let end = Math.min(start + 250000, payload.length);
      // A chunk must not split the UTF-16 pair of a non-BMP character.
      const last = payload.charCodeAt(end - 1);
      if (end < payload.length && last >= 0xd800 && last <= 0xdbff) end--;
      parts.push(payload.slice(start, end));
      start = end;
    }
    const chunks = parts.map((data, i) => ({
      recordType: "TmpCashBackupChunk",
      recordName: id + "-" + i,
      fields: { data: { value: data } },
    }));
    const uploaded = await this.container.privateCloudDatabase.fetchRecords(
      chunks.map((chunk) => chunk.recordName),
    );
    const existingChunks =
      uploaded.records?.filter((record) => !record.serverErrorCode) ?? [];
    for (const chunk of existingChunks) {
      const expected = chunks.find(
        (record) => record.recordName === chunk.recordName,
      );
      if (expected && chunk.fields?.data?.value !== expected.fields.data.value)
        throw new CloudError(
          "This iCloud backup could not be completed. Please try a new backup.",
        );
    }
    const missing = chunks.filter(
      (chunk) =>
        !existingChunks.some(
          (record) => record.recordName === chunk.recordName,
        ),
    );
    if (missing.length)
      records(await this.container.privateCloudDatabase.saveRecords(missing));
    const manifest: RecordValue = {
      recordType: "TmpCashBackup",
      recordName: id,
      fields: {
        walletId: { value: walletId },
        name: { value: name },
        created: { value: created },
        encrypted: { value: isEncryptedBackup(payload) ? 1 : 0 },
        chunks: { value: chunks.length },
      },
    };
    return metadata(
      records(
        await this.container.privateCloudDatabase.saveRecords([manifest]),
      )[0],
    );
  }
  async remove(id: string) {
    const value = await this.manifest(id);
    if (!value) return;
    const count = Number(value.fields?.chunks?.value);
    if (!Number.isInteger(count) || count < 1 || count > 64)
      throw new CloudError("This backup could not be removed.");
    records(await this.container.privateCloudDatabase.deleteRecords([id]));
    records(
      await this.container.privateCloudDatabase.deleteRecords(
        Array.from({ length: count }, (_, i) => id + "-" + i),
      ),
    );
  }
  async disconnect() {
    this.container.signOut();
  }
}
