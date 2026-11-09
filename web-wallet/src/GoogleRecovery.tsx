import { useEffect, useRef, useState } from "react";
import type { TmpCashState } from "coco-cashu-core/tmp-cash";
import type { User } from "firebase/auth";
import { observeGoogleUser, connectGoogle, disconnectGoogle } from "./google";
import { DriveRecovery, type DriveBackup } from "./drive";
import {
  backupProtection,
  newProtection,
  recoveryCodec,
  type RecoveryCodec,
} from "./backup";
import { RecoveryProtection } from "./RecoveryProtection";

export function GoogleRecovery({
  state,
  mint,
  onRestore,
}: {
  state: TmpCashState | null;
  mint: string;
  onRestore(raw: string, password: string): Promise<void>;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [drive, setDrive] = useState<DriveRecovery | null>(null);
  const [codec, setCodec] = useState<RecoveryCodec | null>(null);
  const [mode, setMode] = useState<"passphrase" | "plaintext">("passphrase");
  const [password, setPassword] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [files, setFiles] = useState<DriveBackup[]>([]);
  const [selected, setSelected] = useState("");
  const [restoreRaw, setRestoreRaw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const session = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const uploaded = useRef("");
  const currentUser = useRef<string | null>(null);
  useEffect(() => {
    const unsubscribe = observeGoogleUser((next) => {
      if (next?.uid !== currentUser.current) {
        session.current++;
        currentUser.current = next?.uid ?? null;
        setDrive(null);
        setCodec(null);
        setFiles([]);
        setRestoreRaw(null);
        setPassword("");
        setRestorePassword("");
        uploaded.current = "";
        setMessage("");
      }
      setUser(next);
    });
    return () => {
      session.current++;
      unsubscribe();
    };
  }, []);
  // Only durable wallet fields belong in a backup, not changing balance snapshots.
  const snapshot = state
    ? JSON.stringify({
        proofs: state.proofs,
        operations: state.operations,
        fundings: state.fundings,
        activity: state.activity,
      })
    : null;
  useEffect(() => {
    if (!drive || !codec || snapshot === null) return;
    const identity = mint + snapshot;
    if (identity === uploaded.current) return;
    const generation = session.current;
    const timer = setTimeout(() => {
      queue.current = queue.current
        .catch(() => undefined)
        .then(async () => {
          if (generation !== session.current || identity === uploaded.current)
            return;
          try {
            const raw = await codec.encode(JSON.parse(snapshot), mint);
            if (generation !== session.current) return;
            await drive.upload(raw);
            if (generation !== session.current) return;
            uploaded.current = identity;
            setError("");
            setMessage(
              `Backed up to Google Drive at ${new Date().toLocaleTimeString()}`,
            );
          } catch (cause) {
            if (generation === session.current) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Google Drive backup failed",
              );
              setMessage(
                "Changes are saved in this browser. Google Drive backup needs attention.",
              );
            }
          }
        });
    }, 750);
    return () => clearTimeout(timer);
  }, [drive, codec, snapshot, mint, retry]);
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Google recovery is unavailable",
      );
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    session.current++;
    setCodec(null);
    setPassword("");
    setRestorePassword("");
    setMode("passphrase");
    uploaded.current = "";
    const connected = await connectGoogle();
    setUser(connected.user);
    currentUser.current = connected.user.uid;
    setDrive(new DriveRecovery(connected.token));
    setFiles([]);
    setRestoreRaw(null);
    setMessage("Google Drive connected. Choose how to protect your backups.");
  }
  return (
    <section className="settings-card google-recovery">
      <h2>Google recovery</h2>
      <p className="muted">
        Save recovery copies in your Google Drive. These backups do not
        synchronize spending across devices.
      </p>
      {user && (
        <p className="small">
          Signed in as {user.email ?? user.displayName ?? "Google user"}
        </p>
      )}
      <button
        className="button dark"
        disabled={busy}
        onClick={() => void action(connect)}
      >
        {user ? "Reconnect Google Drive" : "Continue with Google"}
      </button>
      {user && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              session.current++;
              setCodec(null);
              setDrive(null);
              setPassword("");
              setRestorePassword("");
              await disconnectGoogle();
            })
          }
        >
          Sign out of Google
        </button>
      )}
      {drive && !codec && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              const next = await recoveryCodec(newProtection(mode), password);
              setPassword("");
              uploaded.current = "";
              setCodec(next);
              setMessage("Automatic backups enabled for this session.");
            });
          }}
        >
          <RecoveryProtection
            mode={mode}
            onChange={(value) => {
              setMode(value);
              setPassword("");
            }}
          />
          {mode === "passphrase" && (
            <>
              <label htmlFor="google-backup-password">
                Recovery passphrase
              </label>
              <input
                id="google-backup-password"
                type="password"
                minLength={12}
                required
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </>
          )}
          <button className="button dark" disabled={busy || !state}>
            Enable automatic backups
          </button>
        </form>
      )}
      {codec && (
        <>
          <p className="small">
            Automatic backups are{" "}
            {codec.protection.mode === "passphrase"
              ? "encrypted with your passphrase"
              : "saved without encryption"}
            .
          </p>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              uploaded.current = "";
              setRetry((value) => value + 1);
            }}
          >
            Back up now
          </button>
          <button
            className="text-button"
            onClick={() => {
              session.current++;
              setCodec(null);
              setMessage("Automatic backups paused.");
            }}
          >
            Pause backups
          </button>
        </>
      )}
      {drive && (
        <>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const next = await drive.list();
                setFiles(next);
                setSelected(next[0]?.id ?? "");
                setRestoreRaw(null);
                setMessage(
                  next.length
                    ? "Choose a recovery copy to restore into an empty wallet."
                    : "No Google Drive recovery copies found.",
                );
              })
            }
          >
            Find Google Drive backups
          </button>
          {files.length > 0 && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  const raw = restoreRaw ?? (await drive.download(selected));
                  setRestoreRaw(raw);
                  if (
                    backupProtection(raw).mode === "passphrase" &&
                    !restorePassword
                  )
                    return;
                  await onRestore(raw, restorePassword);
                  setRestorePassword("");
                  setRestoreRaw(null);
                  setFiles([]);
                  setMessage("Google Drive backup restored.");
                });
              }}
            >
              <label htmlFor="drive-backup">Recovery copy</label>
              <select
                id="drive-backup"
                value={selected}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setRestoreRaw(null);
                  setRestorePassword("");
                }}
              >
                {files.map((file) => (
                  <option key={file.id} value={file.id}>
                    {new Date(file.createdTime).toLocaleString()} — {file.name}
                  </option>
                ))}
              </select>
              {restoreRaw &&
                backupProtection(restoreRaw).mode === "passphrase" && (
                  <>
                    <label htmlFor="drive-restore-password">
                      Recovery passphrase
                    </label>
                    <input
                      id="drive-restore-password"
                      type="password"
                      minLength={12}
                      required
                      autoComplete="current-password"
                      value={restorePassword}
                      onChange={(event) =>
                        setRestorePassword(event.target.value)
                      }
                    />
                  </>
                )}
              <button className="button dark" disabled={busy}>
                Restore from Google Drive
              </button>
            </form>
          )}
        </>
      )}
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="small" role="alert">
          {error}
        </p>
      )}
      <p className="small muted">
        Unlock backups again when you reopen the wallet. Google Drive may
        occasionally ask you to reconnect.
      </p>
    </section>
  );
}
