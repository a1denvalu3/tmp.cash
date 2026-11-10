export type CloudProvider = "google" | "apple";
export interface CloudUser {
  account: string;
  provider: CloudProvider;
  label: string;
}
export interface CloudBackup {
  id: string;
  walletId: string;
  name: string;
  updated: number;
  encrypted: boolean;
  writer?: string;
}
export interface CloudClient {
  user: CloudUser;
  list(): Promise<CloudBackup[]>;
  download(id: string): Promise<string>;
  upload(
    walletId: string,
    uploadId: string,
    created: number,
    payload: string,
    name: string,
    writer?: string,
  ): Promise<CloudBackup>;
  remove(id: string): Promise<void>;
  disconnect(): Promise<void>;
}
export class CloudError extends Error {
  constructor(
    message: string,
    readonly reconnect = false,
  ) {
    super(message);
  }
}
export async function responseText(
  response: Response,
  limit = 16_000_000,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new CloudError("This backup could not be read. Please try again.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit)
        throw new CloudError("This backup is too large to restore.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks).text();
}
const loads = new Map<string, Promise<void>>();
export function loadCloudScript(src: string, ready: () => boolean) {
  if (ready()) return Promise.resolve();
  if (loads.has(src)) return loads.get(src)!;
  const result = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = setTimeout(() => {
      script.remove();
      reject(new CloudError("Sign-in took too long. Please try again."));
    }, 20000);
    script.src = src;
    script.async = true;
    script.onload = () => {
      clearTimeout(timeout);
      ready()
        ? resolve()
        : reject(new CloudError("Sign-in could not load. Please try again."));
    };
    script.onerror = () => {
      clearTimeout(timeout);
      script.remove();
      reject(
        new CloudError(
          "Sign-in could not load. Check your connection and try again.",
        ),
      );
    };
    document.head.append(script);
  }).catch((error) => {
    loads.delete(src);
    throw error;
  });
  loads.set(src, result);
  return result;
}
