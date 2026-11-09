import { describe, it, expect, vi } from "vitest";
import { DriveRecovery } from "../src/drive";
import { plaintextBackup } from "../src/backup";

const raw = plaintextBackup(
  { proofs: [], operations: [], fundings: [], activity: [] },
  "http://localhost:3338",
);
describe("Google Drive recovery", () => {
  it("uses only app data, authenticates requests, and creates independent recovery copies", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const drive = new DriveRecovery(
      "session-only-token",
      async (url, init = {}) => {
        requests.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            files: [
              {
                id: "file_1",
                name: "backup.json",
                createdTime: "2026-11-09T00:00:00Z",
              },
            ],
          }),
        );
      },
    );
    expect(await drive.list()).toHaveLength(1);
    const query = new URL(requests[0].url).searchParams;
    expect(query.get("spaces")).toBe("appDataFolder");
    expect(query.get("q")).toContain("tmp.cash-recovery-v1");
    await drive.upload(raw);
    await drive.upload(raw);
    for (const request of requests) {
      expect(new Headers(request.init.headers).get("Authorization")).toBe(
        "Bearer session-only-token",
      );
      expect(request.init.credentials).toBe("omit");
    }
    const body = await (requests[1].init.body as Blob).text();
    expect(body).toContain('"parents":["appDataFolder"]');
    expect(body).toContain(raw);
    expect(requests[1].init.method).toBe("POST");
    expect(requests[2].init.method).toBe("POST");
  });
  it("downloads validated backups and rejects expired authorization without exposing response details", async () => {
    const fetcher = vi.fn(async () => new Response(raw));
    const drive = new DriveRecovery("token", fetcher);
    expect(await drive.download("file_1")).toBe(raw);
    await expect(drive.download("../other")).rejects.toThrow("Invalid");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const denied = new DriveRecovery(
      "expired",
      async () => new Response("PRIVATE provider details", { status: 401 }),
    );
    await expect(denied.upload(raw)).rejects.toThrow("Reconnect Google Drive");
    const invalid = new DriveRecovery(
      "token",
      async () => new Response("PRIVATE invalid JSON"),
    );
    await expect(invalid.download("file_1")).rejects.toThrow(
      "Invalid backup file",
    );
  });
});
