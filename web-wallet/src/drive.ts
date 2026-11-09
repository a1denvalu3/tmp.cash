import { MAX_BACKUP_LENGTH, backupProtection } from "./backup";

export interface DriveBackup {
  id: string;
  name: string;
  createdTime: string;
}
const API = "https://www.googleapis.com/drive/v3/files";

/** Tokens stay in the active session; this client never logs requests or backup contents. */
export class DriveRecovery {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}
  private async request(url: string, init: RequestInit = {}) {
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        Authorization: `Bearer ${this.token}`,
      },
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 401 || response.status === 403)
      throw new Error("Reconnect Google Drive to continue backing up");
    if (!response.ok)
      throw new Error(
        "Google Drive is unavailable; your wallet remains saved in this browser",
      );
    return response;
  }
  async list(): Promise<DriveBackup[]> {
    const query = new URLSearchParams({
      spaces: "appDataFolder",
      q: "appProperties has { key='application' and value='tmp.cash-recovery-v1' }",
      fields: "files(id,name,createdTime)",
      orderBy: "createdTime desc",
      pageSize: "20",
    });
    const result = await (await this.request(`${API}?${query}`)).json();
    if (!Array.isArray(result.files))
      throw new Error("Google Drive returned an invalid backup listing");
    return result.files.filter(
      (file: DriveBackup) =>
        typeof file.id === "string" &&
        /^[\w-]+$/.test(file.id) &&
        typeof file.name === "string" &&
        typeof file.createdTime === "string",
    );
  }
  async download(id: string): Promise<string> {
    if (!/^[\w-]+$/.test(id)) throw new Error("Invalid backup file");
    const response = await this.request(`${API}/${id}?alt=media`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Google Drive returned an empty backup");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > MAX_BACKUP_LENGTH)
          throw new Error("Backup file is too large");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const raw = await new Blob(chunks).text();
    backupProtection(raw);
    return raw;
  }
  async upload(
    raw: string,
    name = `tmp.cash-backup-${new Date().toISOString()}.json`,
  ): Promise<void> {
    backupProtection(raw);
    const boundary = `tmpcash_${crypto.randomUUID()}`;
    const metadata = {
      name,
      parents: ["appDataFolder"],
      appProperties: { application: "tmp.cash-recovery-v1" },
    };
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      raw,
      `\r\n--${boundary}--`,
    ]);
    await this.request(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
  }
}
