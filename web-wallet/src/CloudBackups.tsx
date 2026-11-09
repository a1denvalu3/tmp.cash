import { useEffect, useRef, useState } from "react";
import type { TmpCashRepository, TmpCashState } from "coco-cashu-core/tmp-cash";
import { createBackupKey, isEncryptedBackup, restoreBackup } from "./backup";
import {
  cloudRequest,
  CloudSaver,
  enableCloud,
  pauseCloud,
  readCloudSettings,
  type CloudBackup,
  type CloudProgress,
  type CloudUser,
} from "./cloud";

export const UNENCRYPTED_WARNING =
  "Anyone who can access this backup, including the backup server operator or someone who gets into your account, can read your wallet secrets and spend your funds. There is no passphrase protecting this copy.";

export function useCloudBackups(
  repo: TmpCashRepository,
  mint: string,
  onRestored: (data: { mint: string; state: TmpCashState }) => Promise<void>,
) {
  const [providers, setProviders] = useState<string[]>([]);
  const [user, setUser] = useState<CloudUser | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [backups, setBackups] = useState<CloudBackup[]>([]);
  const [progress, setProgress] = useState<CloudProgress | null>(null);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [mode, setMode] = useState("encrypted");
  const [acknowledged, setAcknowledged] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [name, setName] = useState("My wallet");
  const [selected, setSelected] = useState<CloudBackup | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const saver = useRef<CloudSaver | null>(null);
  const currentMint = useRef(mint);
  currentMint.current = mint;

  useEffect(() => {
    let active = true;
    const load = () =>
      cloudRequest<{ providers: string[]; user: CloudUser | null }>("/status")
        .then((result) => {
          if (active) {
            setProviders(result.providers);
            setUser((current) =>
              current?.account === result.user?.account ? current : result.user,
            );
            setAvailable(true);
          }
        })
        .catch(() => {
          if (active) setAvailable(false);
        });
    void load();
    window.addEventListener("online", load);
    window.addEventListener("focus", load);
    const query = new URLSearchParams(location.search);
    if (query.has("cloud")) {
      if (query.get("cloud") === "error")
        setMessage(
          "Sign-in was canceled or could not be verified. Please try again.",
        );
      query.delete("cloud");
      history.replaceState(
        null,
        "",
        location.pathname + (query.size ? "?" + query : "") + location.hash,
      );
    }
    return () => {
      active = false;
      window.removeEventListener("online", load);
      window.removeEventListener("focus", load);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    const worker = new CloudSaver(
      repo,
      () => currentMint.current,
      user.account,
      setProgress,
    );
    saver.current = worker;
    const save = () => {
      void worker.save().catch(() => {});
    };
    save();
    const interval = setInterval(save, 5000);
    window.addEventListener("online", save);
    window.addEventListener("focus", save);
    return () => {
      worker.stop();
      clearInterval(interval);
      window.removeEventListener("online", save);
      window.removeEventListener("focus", save);
      saver.current = null;
    };
  }, [repo, user]);

  useEffect(() => {
    if (!user) {
      setBackups([]);
      return;
    }
    let active = true;
    cloudRequest<{ backups: CloudBackup[] }>("/backups", {}, user.account)
      .then((result) => {
        if (active) setBackups(result.backups);
      })
      .catch((error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, [user, progress?.updated]);

  async function action(fn: () => Promise<void>) {
    setWorking(true);
    setMessage("");
    try {
      await fn();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Cloud backup failed",
      );
    } finally {
      setWorking(false);
    }
  }
  async function refreshBackups() {
    if (user)
      setBackups(
        (
          await cloudRequest<{ backups: CloudBackup[] }>(
            "/backups",
            {},
            user.account,
          )
        ).backups,
      );
  }

  return (
    <section className="settings-card cloud-card">
      <h2>Cloud backups</h2>
      <p className="muted">
        Save this wallet automatically and find it again by signing in with the
        same account. Copies are stored on this wallet service’s server.
      </p>
      {message && (
        <p role="alert" className="error">
          {message}
        </p>
      )}
      {available === null && <p role="status">Checking cloud backups…</p>}
      {available === false && (
        <p className="small muted">
          Cloud sign-in is unavailable on this deployment. You can still export
          a backup file below.
        </p>
      )}
      {available && !user && (
        <div className="cloud-actions">
          {providers.map((provider) => (
            <a
              className="button secondary"
              key={provider}
              href={"/api/cloud/login/" + provider}
            >
              Continue with {provider === "google" ? "Google" : "Apple"}
            </a>
          ))}
          <p className="small muted">
            Sign-in does not upload your wallet until you enable backups. Google
            and Apple accounts keep separate backups, even if they use the same
            email address.
          </p>
        </div>
      )}
      {user && (
        <>
          <p>
            Signed in with {user.provider === "google" ? "Google" : "Apple"}:{" "}
            <strong className="cloud-label">{user.label}</strong>
          </p>
          <p className="small" role="status">
            {progress?.message ?? "Loading backup settings…"}
          </p>
          {progress?.updated ? (
            <p className="small muted">
              Last saved: {new Date(progress.updated * 1000).toLocaleString()} ·{" "}
              {progress.encrypted ? "Passphrase encrypted" : "No encryption"}
            </p>
          ) : null}
          {progress?.enabled && (
            <>
              {!progress.encrypted && (
                <p className="cloud-warning">{UNENCRYPTED_WARNING}</p>
              )}
              <div className="cloud-actions">
                <button
                  className="button dark"
                  disabled={working || progress.saving}
                  onClick={() =>
                    action(async () => {
                      await saver.current?.save(true);
                      await refreshBackups();
                    })
                  }
                >
                  Back up now
                </button>
                <button
                  className="button secondary"
                  disabled={working}
                  onClick={() =>
                    action(async () => {
                      await pauseCloud();
                      setProgress(null);
                      await saver.current?.save();
                    })
                  }
                >
                  Pause automatic backups
                </button>
              </div>
            </>
          )}
          {!progress?.enabled && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  if (mode === "encrypted" && password !== confirmation)
                    throw new Error("Backup passphrases do not match");
                  if (mode === "plaintext" && !acknowledged)
                    throw new Error(
                      "Acknowledge the risk of an unencrypted backup first",
                    );
                  const encryption =
                    mode === "encrypted"
                      ? await createBackupKey(password)
                      : null;
                  await enableCloud({
                    account: user.account,
                    id: crypto.randomUUID(),
                    name: name.trim(),
                    encryption,
                    revision: 0,
                    updated: 0,
                    fingerprint: "",
                  });
                  setPassword("");
                  setConfirmation("");
                  setAcknowledged(false);
                  await saver.current?.save();
                  await refreshBackups();
                });
              }}
            >
              <label htmlFor="cloud-name">Backup name</label>
              <input
                id="cloud-name"
                value={name}
                maxLength={80}
                required
                onChange={(event) => setName(event.target.value)}
              />
              <label htmlFor="cloud-protection">Backup protection</label>
              <select
                id="cloud-protection"
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value);
                  setAcknowledged(false);
                  setPassword("");
                  setConfirmation("");
                }}
              >
                <option value="encrypted">
                  Encrypt with a passphrase (recommended)
                </option>
                <option value="plaintext">No encryption — no passphrase</option>
              </select>
              {mode === "encrypted" ? (
                <>
                  <p className="small muted">
                    Keep this passphrase: Google or Apple sign-in cannot recover
                    it. It is needed when restoring on a new device. This
                    browser remembers an encryption key for automatic saves.
                  </p>
                  <label htmlFor="cloud-password">
                    Cloud backup passphrase
                  </label>
                  <input
                    id="cloud-password"
                    type="password"
                    minLength={12}
                    required
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <label htmlFor="cloud-confirm">Confirm passphrase</label>
                  <input
                    id="cloud-confirm"
                    type="password"
                    minLength={12}
                    required
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </>
              ) : (
                <div className="cloud-warning">
                  <p>{UNENCRYPTED_WARNING}</p>
                  <label className="backup-ack">
                    <input
                      type="checkbox"
                      required
                      checked={acknowledged}
                      onChange={(event) =>
                        setAcknowledged(event.target.checked)
                      }
                    />
                    I understand that anyone with access to this backup can
                    spend my funds.
                  </label>
                </div>
              )}
              {backups.length > 0 && (
                <p className="small muted">
                  Saved backups already exist. Restore one below if this is a
                  new browser. Enabling backups creates a separate copy of this
                  browser’s wallet.
                </p>
              )}
              <button
                className="button dark"
                disabled={working || (mode === "plaintext" && !acknowledged)}
              >
                Enable automatic backups
              </button>
            </form>
          )}
          <p className="small muted">
            Changes are checked every 5 seconds while the wallet is open, with
            retries when connectivity returns. Closing the wallet stops saves.
            Backups do not extend token deadlines.
          </p>
          <h3>Saved wallets</h3>
          {backups.length === 0 && (
            <p className="small muted">No cloud backup saved yet.</p>
          )}
          <ul className="cloud-backups">
            {backups.map((backup) => (
              <li key={backup.id}>
                <div>
                  <strong>{backup.name}</strong>
                  <p className="small muted">
                    {new Date(backup.updated * 1000).toLocaleString()} ·{" "}
                    {backup.encrypted ? "Encrypted" : "No encryption"}
                  </p>
                </div>
                <div className="cloud-actions">
                  <button
                    className="button secondary"
                    disabled={working}
                    onClick={() => {
                      setSelected(backup);
                      setRestorePassword("");
                      setMessage("");
                    }}
                  >
                    Restore {backup.name}
                  </button>
                  <button
                    className="button secondary"
                    disabled={working}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Delete the cloud backup “${backup.name}”? This cannot be undone. Your local wallet will remain.`,
                        )
                      )
                        return;
                      void action(async () => {
                        const settings = await readCloudSettings();
                        if (
                          settings?.id === backup.id &&
                          settings.account === user.account
                        ) {
                          await pauseCloud();
                          setProgress(null);
                        }
                        await cloudRequest(
                          "/backups/" + backup.id,
                          { method: "DELETE" },
                          user.account,
                        );
                        await saver.current?.save();
                        await refreshBackups();
                      });
                    }}
                  >
                    Delete {backup.name}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {selected && (
            <form
              className="cloud-restore"
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  const backup = await cloudRequest<
                    CloudBackup & { payload: string }
                  >("/backups/" + selected.id, {}, user.account);
                  if (isEncryptedBackup(backup.payload) !== selected.encrypted)
                    throw new Error(
                      "Backup protection changed. Select this backup again.",
                    );
                  const data = await restoreBackup(
                    backup.payload,
                    restorePassword,
                  );
                  const current = await repo.read();
                  if (
                    Object.values(current).some((records) => records.length > 0)
                  )
                    throw new Error(
                      "Restore requires an empty wallet in a new browser profile",
                    );
                  await pauseCloud();
                  await onRestored(data);
                  setSelected(null);
                  setRestorePassword("");
                  setMessage(
                    "Cloud backup restored. Verifying tokens and their backings…",
                  );
                  await saver.current?.save();
                });
              }}
            >
              <h3>Restore {selected.name}</h3>
              <p className="small muted">
                Restore requires an empty wallet. Use a new browser profile if
                this browser already holds wallet records. Use one active copy
                of a restored wallet to avoid competing spends.
              </p>
              {selected.encrypted ? (
                <>
                  <label htmlFor="cloud-restore-password">
                    Saved backup passphrase
                  </label>
                  <input
                    id="cloud-restore-password"
                    type="password"
                    required
                    minLength={12}
                    autoComplete="current-password"
                    value={restorePassword}
                    onChange={(event) => setRestorePassword(event.target.value)}
                  />
                </>
              ) : (
                <p className="cloud-warning">
                  This backup contains readable wallet secrets.{" "}
                  {UNENCRYPTED_WARNING}
                </p>
              )}
              <div className="cloud-actions">
                <button className="button dark" disabled={working}>
                  Restore saved wallet
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={working}
                  onClick={() => {
                    setSelected(null);
                    setRestorePassword("");
                  }}
                >
                  Cancel restore
                </button>
              </div>
            </form>
          )}
          <button
            className="button secondary"
            disabled={working}
            onClick={() =>
              action(async () => {
                await pauseCloud();
                await cloudRequest("/logout", { method: "POST" });
                setUser(null);
                setProgress(null);
                setSelected(null);
                setRestorePassword("");
                setPassword("");
                setConfirmation("");
              })
            }
          >
            Sign out
          </button>
          <a
            className="button secondary"
            href={"/api/cloud/login/" + user.provider}
          >
            Sign in again
          </a>
          <p className="small muted">
            Signing out pauses saves and removes this browser’s saved backup
            key. Cloud copies remain until you delete them.
          </p>
        </>
      )}
    </section>
  );
}
