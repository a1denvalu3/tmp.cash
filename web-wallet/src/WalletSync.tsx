import { useEffect, useRef, useState } from "react";
import type { TmpCashManager } from "coco-cashu-core/tmp-cash";
import type { TmpCashIndexedDbRepository } from "coco-cashu-indexeddb/tmp-cash";
import type { CloudClient } from "./CloudTypes";
import { DEFAULT_SYNC_RELAY } from "./nostr-sync";
import { readCloudSettings } from "./cloud";
import { CopyButton } from "./CopyButton";
import {
  NostrWalletSync,
  createSyncSettings,
  exportSyncCode,
  importSyncCode,
  readSyncSettings,
  saveSyncSettings,
  type NostrSyncSettings,
} from "./nostr-sync";

export function useWalletSync(
  repo: TmpCashIndexedDbRepository,
  manager: TmpCashManager | null,
  mint: string,
  selectMint: (mint: string) => void,
  cloudClient: CloudClient | null,
  saveCloud: () => Promise<void>,
) {
  const [config, setConfig] = useState<NostrSyncSettings | null>(null);
  const [relays, setRelays] = useState(DEFAULT_SYNC_RELAY);
  const [code, setCode] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [message, setMessage] = useState("Sync is off.");
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  const [restart, setRestart] = useState(0);
  const service = useRef<NostrWalletSync | null>(null);
  const pulling = useRef(false);
  const saveCloudRef = useRef(saveCloud);
  saveCloudRef.current = saveCloud;
  const googleAccount =
    cloudClient?.user.provider === "google" ? cloudClient.user.account : null;

  useEffect(() => {
    if (!manager) return;
    let active = true;
    const start = (async () => {
      const settings = await readSyncSettings(repo);
      const isPaused = !!(await repo.syncData.get("paused"))?.value;
      if (!active) return null;
      setConfig(settings);
      setPaused(isPaused);
      if (googleAccount) {
        setMessage(
          "Google Drive backups synchronize this wallet. No relay connection is used while Google is connected.",
        );
        return null;
      }
      if (!settings || isPaused) {
        setMessage(
          isPaused ? "Sync is paused on this device." : "Sync is off.",
        );
        return null;
      }
      const sync = new NostrWalletSync(repo, settings);
      service.current = sync;
      setMessage("Connecting to wallet relays…");
      return sync;
    })();
    // Install the barrier before asynchronous settings load, including page reloads.
    manager.setSyncBarrier(async () => {
      const sync = await start;
      if (googleAccount) {
        // The backup consent/pause control also governs Drive synchronization.
        if ((await readCloudSettings())?.account === googleAccount)
          await saveCloudRef.current();
        return;
      }
      if (sync) {
        try {
          await sync.flush();
          if (active) {
            setFailed(false);
            setMessage("Recovery data saved to a relay.");
          }
        } catch (error) {
          if (active) {
            setFailed(true);
            setMessage(
              error instanceof Error
                ? error.message
                : "Wallet sync is unavailable.",
            );
          }
          throw error;
        }
      }
    });
    const pull = async () => {
      if (pulling.current || !active) return;
      pulling.current = true;
      try {
        const sync = await start;
        if (!sync || !active) return;
        await manager.synchronize(() => sync.synchronize());
        if (active) {
          setFailed(false);
          setMessage(
            "Wallet synchronized. Devices may briefly show different balances.",
          );
        }
      } catch (error) {
        if (active) {
          setFailed(true);
          setMessage(
            error instanceof Error
              ? error.message
              : "Wallet sync is unavailable.",
          );
        }
      } finally {
        pulling.current = false;
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
      manager.setSyncBarrier(null);
      service.current?.stop();
      service.current = null;
    };
  }, [repo, manager, restart, googleAccount]);

  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try {
      await fn();
    } catch (error) {
      setFailed(true);
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not configure wallet sync.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function enable(join: boolean) {
    if (!manager) throw new Error("Connect to your mint first.");
    if (join && Object.values(await repo.read()).some((rows) => rows.length))
      throw new Error(
        "Connect another device using an empty wallet. Export any existing funds first.",
      );
    const settings = join
      ? importSyncCode(code.trim())
      : createSyncSettings(relays.split(/[\s,]+/).filter(Boolean), mint);
    // Persist membership before the first request so reloads cannot bypass its write-ahead barrier.
    await saveSyncSettings(repo, settings);
    await repo.syncData.delete("paused");
    const sync = new NostrWalletSync(repo, settings);
    service.current?.stop();
    service.current = sync;
    manager.setSyncBarrier(() => sync.flush());
    setConfig(settings);
    setPaused(false);
    try {
      await manager.synchronize(() => sync.synchronize(join));
      setCode("");
      setShowCode(!join);
      setMessage("Wallet synchronized.");
      if (join) selectMint(settings.mint);
    } catch (error) {
      if (join) {
        let cleared = false;
        await repo.runTransaction(
          "rw",
          ["proofs", "operations", "fundings", "activity"],
          async () => {
            if (!Object.values(await repo.read()).some((rows) => rows.length)) {
              await repo.syncFacts.clear();
              await repo.syncData.clear();
              cleared = true;
            }
          },
        );
        if (cleared) {
          sync.stop();
          service.current = null;
          manager.setSyncBarrier(null);
          setConfig(null);
        }
      }
      throw error;
    } finally {
      setRestart((n) => n + 1);
    }
  }
  const panel = (
    <section className="settings-card" aria-labelledby="nostr-sync-title">
      <h2 id="nostr-sync-title">Sync your devices</h2>
      <p className="muted">
        Google Drive backups synchronize your wallet when Google is connected.
        Otherwise, encrypted device sync uses buzz.cashu.space. Transfers
        require your mint; balances can briefly differ while devices catch up.
      </p>
      <p
        className={failed ? "error" : "small muted"}
        role="status"
        data-testid="nostr-sync-status"
      >
        {message}
      </p>
      {googleAccount ? (
        <>
          <p className="small muted">
            Your Google Drive backup contains the mergeable wallet document.
            Restore that backup on another device using the same Google account
            and backup password. After setup, both copies synchronize through
            Drive.
          </p>
          <button
            className="button secondary"
            disabled={busy || !manager}
            onClick={() =>
              void action(async () => {
                await manager!.synchronize(() => saveCloudRef.current());
                setMessage("Wallet synchronized through Google Drive.");
              })
            }
          >
            Sync now
          </button>
        </>
      ) : !config ? (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void action(() => enable(false));
            }}
          >
            <label htmlFor="sync-relays">Relay URLs</label>
            <textarea
              id="sync-relays"
              value={relays}
              onChange={(e) => setRelays(e.target.value)}
              placeholder="wss://your-relay.example"
              spellCheck={false}
              required
            />
            <p className="small muted">
              Choose relays you trust to retain your encrypted wallet. With sync
              enabled, a relay must accept recovery data before a new operation
              starts.
            </p>
            <button className="button dark" disabled={busy || !manager}>
              Enable device sync
            </button>
          </form>
          <details>
            <summary>Connect to an existing wallet</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(() => enable(true));
              }}
            >
              <label htmlFor="sync-code">Private sync code</label>
              <textarea
                id="sync-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                required
              />
              <button className="button secondary" disabled={busy || !manager}>
                Connect this device
              </button>
            </form>
          </details>
        </>
      ) : (
        <>
          <p className="small muted">{config.relays.join(", ")}</p>
          <button
            className="button secondary"
            disabled={busy || !manager}
            onClick={() =>
              void action(async () => {
                if (paused) {
                  await repo.syncData.delete("paused");
                  setRestart((n) => n + 1);
                } else if (manager && service.current) {
                  await manager.synchronize(() =>
                    service.current!.synchronize(),
                  );
                  setMessage("Wallet synchronized.");
                }
              })
            }
          >
            {paused ? "Resume sync" : "Sync now"}
          </button>
          {!paused && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await repo.syncData.put({ id: "paused", value: true });
                  setRestart((n) => n + 1);
                })
              }
            >
              Pause sync on this device
            </button>
          )}
          <button
            className="text-button"
            onClick={() => setShowCode((value) => !value)}
          >
            {showCode ? "Hide sync code" : "Show private sync code"}
          </button>
          {showCode && (
            <>
              <p className="small">
                Anyone with this code can access and spend this wallet. Enter it
                only on a device you trust.
              </p>
              <label htmlFor="private-sync-code">Your private sync code</label>
              <textarea
                id="private-sync-code"
                value={exportSyncCode(config)}
                readOnly
                spellCheck={false}
              />
              <CopyButton
                value={exportSyncCode(config)}
                label="Copy sync code"
              />
            </>
          )}
          <p className="small muted">
            Pausing stops this device’s uploads and allows operations without
            relay confirmation. It does not revoke another device or delete
            relay copies. Keep a separate backup; sync does not extend token
            deadlines.
          </p>
        </>
      )}
    </section>
  );
  return panel;
}
