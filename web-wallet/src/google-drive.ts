import { isEncryptedBackup, MAX_BACKUP_LENGTH } from "./backup";
import {
  CloudError,
  loadCloudScript,
  responseText,
  type CloudBackup,
  type CloudClient,
  type CloudUser,
} from "./CloudTypes";

const API = "https://www.googleapis.com/drive/v3/files";
const APP = "tmp.cash-browser-backup-v1";
const SESSION = "tmpcash-google-session";
export const GOOGLE_SCOPE =
  "openid email https://www.googleapis.com/auth/drive.appdata";
export const googleClientId =
  import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || "";
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}
interface GoogleSdk {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback(response: TokenResponse): void;
        error_callback(error: { type: string }): void;
      }): { requestAccessToken(config: { prompt: string }): void };
    };
  };
}
declare global {
  interface Window {
    google?: GoogleSdk;
  }
}
interface Session {
  user: CloudUser;
  token: string;
  expires: number;
}
function remember(session: Session | null) {
  try {
    session
      ? sessionStorage.setItem(SESSION, JSON.stringify(session))
      : sessionStorage.removeItem(SESSION);
  } catch {
    /* The active session still works when storage is blocked. */
  }
}
export function restoreGoogleSession(): GoogleDrive | null {
  try {
    const value: Session = JSON.parse(
      sessionStorage.getItem(SESSION) || "null",
    );
    if (
      googleClientId &&
      value?.token &&
      value.user?.provider === "google" &&
      value.expires > Date.now() + 30000
    )
      return new GoogleDrive(value);
  } catch {
    /* An expired or malformed session requires sign-in. */
  }
  remember(null);
  return null;
}
export async function prepareGoogle() {
  await loadCloudScript(
    "https://accounts.google.com/gsi/client",
    () => !!window.google?.accounts?.oauth2,
  );
}
export function connectGoogle(): Promise<GoogleDrive> {
  // Called directly by the user's click, after the SDK has loaded, so the
  // browser allows Google's own sign-in popup.
  if (!window.google?.accounts.oauth2)
    return Promise.reject(
      new CloudError("Sign-in is still loading. Please try again."),
    );
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: GOOGLE_SCOPE,
      callback: (response) => {
        if (
          response.error ||
          !response.access_token ||
          !response.scope
            ?.split(" ")
            .includes("https://www.googleapis.com/auth/drive.appdata")
        ) {
          reject(
            new CloudError(
              "Allow wallet backups in Google Drive to continue. Your other files stay private.",
            ),
          );
          return;
        }
        void (async () => {
          const token = response.access_token!;
          const info = await fetch(
            "https://openidconnect.googleapis.com/v1/userinfo",
            {
              headers: { Authorization: `Bearer ${token}` },
              credentials: "omit",
              cache: "no-store",
              signal: AbortSignal.timeout(20000),
            },
          );
          if (!info.ok)
            throw new CloudError(
              "Google sign-in could not be completed. Please try again.",
            );
          const data = await info.json();
          if (
            typeof data.sub !== "string" ||
            !data.sub ||
            typeof data.email !== "string"
          )
            throw new CloudError(
              "Google sign-in could not be completed. Please try again.",
            );
          const session: Session = {
            user: {
              account: "google:" + data.sub,
              provider: "google",
              label: data.email,
            },
            token,
            expires:
              Date.now() + Math.max(0, Number(response.expires_in) || 0) * 1000,
          };
          remember(session);
          resolve(new GoogleDrive(session));
        })().catch(reject);
      },
      error_callback: () =>
        reject(
          new CloudError(
            "Sign-in was closed. You can try again whenever you’re ready.",
          ),
        ),
    });
    client.requestAccessToken({ prompt: "select_account" });
  });
}
interface DriveFile {
  id: string;
  name: string;
  appProperties?: Record<string, string>;
}
function metadata(file: DriveFile): CloudBackup {
  if (
    !/^[\w-]+$/.test(file.id) ||
    typeof file.name !== "string" ||
    !file.appProperties?.walletId ||
    !Number.isFinite(Number(file.appProperties.created))
  )
    throw new CloudError("Google Drive returned an unreadable backup.");
  return {
    id: file.id,
    name: file.name,
    walletId: file.appProperties.walletId,
    updated: Number(file.appProperties.created),
    encrypted: file.appProperties.encrypted === "true",
    ...(file.appProperties.writer ? { writer: file.appProperties.writer } : {}),
  };
}
export class GoogleDrive implements CloudClient {
  readonly user: CloudUser;
  constructor(
    private session: Session,
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.user = session.user;
  }
  private async request(url: string, init: RequestInit = {}) {
    if (this.session.expires <= Date.now())
      throw new CloudError(
        "Reconnect Google to keep your wallet backed up.",
        true,
      );
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        Authorization: `Bearer ${this.session.token}`,
      },
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 401) {
      remember(null);
      throw new CloudError(
        "Reconnect Google to keep your wallet backed up.",
        true,
      );
    }
    if (response.status === 403)
      throw new CloudError(
        "Google Drive could not save this backup. Check your Drive permission and available storage.",
        true,
      );
    if (!response.ok)
      throw new CloudError(
        "Your backup couldn’t reach Google Drive. We’ll try again when you’re online.",
      );
    return response;
  }
  private async files(extra = ""): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({
        spaces: "appDataFolder",
        q: `trashed = false and appProperties has { key='application' and value='${APP}' }${extra}`,
        fields: "nextPageToken,files(id,name,appProperties)",
        pageSize: "100",
        orderBy: "createdTime desc",
        ...(pageToken ? { pageToken } : {}),
      });
      const data = await (await this.request(`${API}?${query}`)).json();
      if (!Array.isArray(data.files))
        throw new CloudError(
          "Your saved wallets couldn’t be loaded. Please try again.",
        );
      files.push(...data.files);
      pageToken =
        typeof data.nextPageToken === "string" ? data.nextPageToken : "";
    } while (pageToken && files.length < 1000);
    if (pageToken)
      throw new CloudError(
        "Too many backup files to synchronize safely. No recovery records were discarded.",
      );
    return files;
  }
  async list() {
    return (await this.files())
      .map(metadata)
      .sort((a, b) => b.updated - a.updated);
  }
  async download(id: string) {
    if (!/^[\w-]+$/.test(id))
      throw new CloudError("This backup could not be found.");
    return responseText(await this.request(`${API}/${id}?alt=media`));
  }
  async upload(
    walletId: string,
    uploadId: string,
    created: number,
    payload: string,
    name: string,
    writer?: string,
  ) {
    if (!/^[\w-]+$/.test(walletId) || !/^[\w-]+$/.test(uploadId))
      throw new CloudError("This backup could not be saved.");
    if (new TextEncoder().encode(payload).byteLength > MAX_BACKUP_LENGTH)
      throw new CloudError("This backup is too large to save.");
    // Every snapshot is immutable. A delayed request can never overwrite a
    // newer backup. A saved upload ID lets retries find an accepted request.
    const previous = await this.files(
      ` and appProperties has { key='uploadId' and value='${uploadId}' }`,
    );
    if (previous.length) return metadata(previous[0]);
    const appProperties = {
      application: APP,
      walletId,
      uploadId,
      created: String(created),
      encrypted: String(isEncryptedBackup(payload)),
      ...(writer ? { writer } : {}),
    };
    const boundary = "tmpcash_" + crypto.randomUUID();
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify({ name, parents: ["appDataFolder"], appProperties }),
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      payload,
      `\r\n--${boundary}--`,
    ]);
    const result = await (
      await this.request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,appProperties",
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body,
        },
      )
    ).json();
    return metadata(result);
  }
  async remove(id: string) {
    if (!/^[\w-]+$/.test(id))
      throw new CloudError("This backup could not be found.");
    await this.request(`${API}/${id}`, { method: "DELETE" });
  }
  async disconnect() {
    remember(null);
  }
}
