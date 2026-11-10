import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cloud,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import type { TmpCashRepository, TmpCashState } from "coco-cashu-core/tmp-cash";
import {
  createBackupKey,
  recoverBackupKey,
  isEncryptedBackup,
  restoreBackup,
} from "./backup";
import {
  CloudSaver,
  enableCloud,
  pauseCloud,
  readCloudSettings,
  type CloudBackup,
  type CloudClient,
  type CloudProgress,
  type CloudProvider,
} from "./cloud";
import {
  connectGoogle,
  googleClientId,
  prepareGoogle,
  restoreGoogleSession,
} from "./google-drive";
import {
  appleConfigured,
  mountAppleSignIn,
  restoreAppleSession,
} from "./apple-cloud";
import { assertWalletSyncGroup, mergeWalletSyncBackup } from "./sync-document";
import type { TmpCashIndexedDbRepository } from "coco-cashu-indexeddb/tmp-cash";
import { Modal } from "./Modal";
import { diagnoseAction } from "./diagnostics";

export const UNENCRYPTED_WARNING =
  "Anyone who can read this backup, including your cloud storage provider or someone who gets into your account, can read your wallet secrets and spend your funds. A backup password adds protection that your account alone cannot provide.";
export const BACKUP_PROMPT_DISMISSED = "tmpcash-backup-prompt-dismissed";
type Step =
  | "intro"
  | "loading"
  | "choose"
  | "protection"
  | "password"
  | "unencrypted"
  | "saving"
  | "success"
  | "restore";
const configured = !!googleClientId || appleConfigured;
function dismissed() {
  try {
    return localStorage.getItem(BACKUP_PROMPT_DISMISSED) === "1";
  } catch {
    return false;
  }
}
function providerName(provider?: CloudProvider) {
  return provider === "apple" ? "Apple" : "Google";
}
function storageName(provider?: CloudProvider) {
  return provider === "apple" ? "iCloud" : "Google Drive";
}
function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

export function useCloudBackups(
  repo: TmpCashRepository,
  mint: string,
  onRestored: (value: { mint: string; state: TmpCashState }) => Promise<void>,
  suspended = false,
  synchronize: (fn: () => Promise<void>) => Promise<void> = (fn) => fn(),
) {
  const synchronizeRef = useRef(synchronize);
  synchronizeRef.current = synchronize;
  const [client, setClient] = useState<CloudClient | null>(() =>
    restoreGoogleSession(),
  );
  const [progress, setProgress] = useState<CloudProgress | null>(null);
  const [backups, setBackups] = useState<CloudBackup[]>([]);
  const [ready, setReady] = useState(false),
    [hasWallet, setHasWallet] = useState(false);
  const [open, setOpen] = useState(false),
    [step, setStep] = useState<Step>("intro");
  const [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [settingsError, setSettingsError] = useState("");
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [acknowledged, setAcknowledged] = useState(false);
  const [selected, setSelected] = useState<CloudBackup | null>(null),
    [googleReady, setGoogleReady] = useState(false),
    [loadVersion, setLoadVersion] = useState(0);
  const [exactCopy, setExactCopy] = useState(false),
    [showHistory, setShowHistory] = useState(false),
    [emptyCopies, setEmptyCopies] = useState<Set<string>>(() => new Set());
  const [wasDismissed, setWasDismissed] = useState(dismissed),
    [rememberedBackup, setRememberedBackup] = useState(false);
  const [protection, setProtection] = useState<"encrypted" | "plaintext">(
      "encrypted",
    ),
    [name, setName] = useState("My wallet");
  const saver = useRef<CloudSaver | null>(null),
    currentMint = useRef(mint);
  currentMint.current = mint;
  useEffect(() => {
    let active = true;
    void readCloudSettings()
      .then((value) => {
        if (active) setRememberedBackup(!!value);
      })
      .catch(() => {});
    let apple = false;
    try {
      apple = localStorage.getItem("tmpcash-backup-provider") === "apple";
    } catch {
      /* Optional preference. */
    }
    if (apple && appleConfigured)
      void restoreAppleSession()
        .then((value) => {
          if (active && value) setClient(value);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!configured || wasDismissed || suspended || open) return;
    if (!client) {
      setStep("intro");
      setOpen(true);
    } else if (ready && progress) {
      setStep(
        progress.enabled
          ? progress.updated && !progress.error
            ? "success"
            : "saving"
          : !hasWallet && backups.length
            ? "choose"
            : "protection",
      );
      setOpen(true);
    }
  }, [
    client,
    wasDismissed,
    suspended,
    open,
    ready,
    progress,
    hasWallet,
    backups.length,
  ]);
  useEffect(() => {
    if (!open || step !== "intro" || !googleClientId) return;
    let active = true;
    void prepareGoogle()
      .then(() => {
        if (active) setGoogleReady(true);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [open, step, loadVersion]);
  useEffect(() => {
    if (!open || step !== "intro" || !appleConfigured) return;
    let active = true;
    void mountAppleSignIn((value) => {
      if (active) connected(value);
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    });
    return () => {
      active = false;
    };
  }, [open, step, loadVersion]);
  useEffect(() => {
    if (!client) {
      setProgress(null);
      setBackups([]);
      setReady(false);
      return;
    }
    const worker = new CloudSaver(
      repo,
      () => currentMint.current,
      client,
      setProgress,
    );
    saver.current = worker;
    const save = () => {
      void synchronizeRef.current(() => worker.save()).catch(() => {});
    };
    save();
    const timer = setInterval(save, 5000);
    window.addEventListener("online", save);
    window.addEventListener("focus", save);
    return () => {
      worker.stop();
      saver.current = null;
      clearInterval(timer);
      window.removeEventListener("online", save);
      window.removeEventListener("focus", save);
    };
  }, [repo, client]);
  useEffect(() => {
    if (!client) return;
    let active = true;
    setReady(false);
    void Promise.all([client.list(), repo.read(), readCloudSettings()])
      .then(([files, state, settings]) => {
        if (!active) return;
        const full = Object.values(state).some((records) => records.length > 0);
        setBackups(files);
        setHasWallet(full);
        setReady(true);
        setStep((current) =>
          current === "loading"
            ? settings?.account === client.user.account
              ? "saving"
              : !full && files.length
                ? "choose"
                : "protection"
            : current,
        );
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [repo, client, loadVersion]);
  useEffect(() => {
    if (!client || !progress?.updated) return;
    let active = true;
    void client
      .list()
      .then((files) => {
        if (active) setBackups(files);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client, progress?.updated]);
  useEffect(() => {
    if (
      step === "saving" &&
      progress?.enabled &&
      progress.updated &&
      !progress.saving &&
      !progress.error
    ) {
      setStep("success");
      setError("");
    }
  }, [step, progress]);
  function close() {
    if (working && step !== "saving") return;
    setOpen(false);
    setWasDismissed(true);
    setError("");
    setPassword("");
    setConfirmation("");
    setAcknowledged(false);
    try {
      localStorage.setItem(BACKUP_PROMPT_DISMISSED, "1");
    } catch {
      /* Closing still works. */
    }
  }
  function start() {
    setError("");
    setSettingsError("");
    setOpen(true);
    setStep(
      !client || progress?.reconnect
        ? "intro"
        : progress?.enabled
          ? progress.updated && !progress.saving && !progress.error
            ? "success"
            : "saving"
          : ready
            ? !hasWallet && backups.length
              ? "choose"
              : "protection"
            : "loading",
    );
  }
  function connected(value: CloudClient) {
    setExactCopy(false);
    setShowHistory(false);
    setEmptyCopies(new Set());
    try {
      localStorage.setItem("tmpcash-backup-provider", value.user.provider);
    } catch {
      /* Optional preference. */
    }
    setError("");
    setSettingsError("");
    setReady(false);
    setStep("loading");
    setClient(value);
  }
  async function action(fn: () => Promise<void>, settings = false) {
    if (working) return;
    setWorking(true);
    settings ? setSettingsError("") : setError("");
    try {
      await fn();
    } catch (cause) {
      settings
        ? setSettingsError(errorMessage(cause))
        : setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }
  async function setup() {
    if (!client) return;
    if (protection === "encrypted" && password !== confirmation)
      throw new Error("Those passwords don’t match. Please try again.");
    if (protection === "plaintext" && !acknowledged)
      throw new Error(
        "Please confirm that you understand who can access this backup.",
      );
    const encryption =
      protection === "encrypted" ? await createBackupKey(password) : null;
    await enableCloud({
      storage: "provider-v1",
      account: client.user.account,
      id: crypto.randomUUID(),
      name: name.trim() || "My wallet",
      encryption,
      fingerprint: "",
      updated: 0,
    });
    setPassword("");
    setConfirmation("");
    setAcknowledged(false);
    setProgress(null);
    setStep("saving");
    setRememberedBackup(true);
    await synchronizeRef.current(
      () => saver.current?.save() ?? Promise.resolve(),
    );
  }
  async function restore() {
    if (!client || !selected) return;
    const state = await repo.read();
    if (Object.values(state).some((records) => records.length))
      throw new Error(
        "This browser already has a wallet. Restore on a different device or browser.",
      );
    if (!selected.encrypted && !acknowledged)
      throw new Error(
        "Please confirm that you understand who can access this backup.",
      );
    // Refresh the latest copy unless the user explicitly chose an earlier one.
    const files = await client.list();
    setBackups(files);
    const backup = exactCopy
      ? files.find(
          (value) =>
            value.id === selected.id && value.walletId === selected.walletId,
        )
      : files
          .filter((value) => value.walletId === selected.walletId)
          .sort((a, b) => b.updated - a.updated)[0];
    if (!backup)
      throw new Error(
        "This saved wallet is no longer available. Choose another saved wallet.",
      );
    setSelected(backup);
    if (backup.encrypted !== selected.encrypted) {
      setPassword("");
      setAcknowledged(false);
      throw new Error(
        "The backup protection changed. Review it before restoring.",
      );
    }
    const raw = await client.download(backup.id);
    if (isEncryptedBackup(raw) !== backup.encrypted)
      throw new Error("This saved wallet changed. Please select it again.");
    const data = await restoreBackup(raw, password);
    if (!Object.values(data.state).some((records) => records.length > 0)) {
      setEmptyCopies((value) => new Set([...value, backup.id]));
      setShowHistory(true);
      throw new Error(
        "This saved copy is empty. Choose another saved wallet or save a new backup from the original wallet.",
      );
    }
    const encryption = backup.encrypted
      ? await recoverBackupKey(raw, password)
      : null;
    if ("mergeSyncFacts" in repo)
      await assertWalletSyncGroup(
        repo as TmpCashIndexedDbRepository,
        data.sync,
      );
    await pauseCloud();
    await onRestored(data);
    if (data.sync && "mergeSyncFacts" in repo)
      await mergeWalletSyncBackup(
        repo as TmpCashIndexedDbRepository,
        data.sync,
      );
    currentMint.current = data.mint;
    setHasWallet(true);
    await enableCloud({
      storage: "provider-v1",
      account: client.user.account,
      id: data.sync && !exactCopy ? backup.walletId : crypto.randomUUID(),
      name: backup.name,
      encryption,
      fingerprint: "",
      updated: 0,
    });
    setPassword("");
    setAcknowledged(false);
    setProgress(null);
    setStep("saving");
    await synchronizeRef.current(
      () => saver.current?.save() ?? Promise.resolve(),
    );
  }
  const latest = backups.filter(
    (backup, index, all) =>
      all.findIndex((value) => value.walletId === backup.walletId) === index,
  );
  const titles: Record<Step, string> = {
    intro: rememberedBackup ? "Welcome back." : "Keep your wallet safe.",
    loading: "Finding your wallet…",
    choose: "Welcome back.",
    protection: "How would you like to protect it?",
    password: "Add a backup password.",
    unencrypted: "Use your account only?",
    saving: "Saving your wallet…",
    success: "Your wallet is backed up.",
    restore: "Let’s restore your wallet.",
  };
  const subtitles: Partial<Record<Step, string>> = {
    intro:
      "Sign in to save automatic backups and find your wallet again if you lose this device.",
    choose:
      "We found saved wallets in your account. Pick up where you left off.",
    protection:
      "Choose what you’ll need to restore your wallet on a new device.",
    password:
      "You’ll need this password when restoring on a new device. Your cloud account cannot reset it.",
    unencrypted:
      "You won’t need a separate password to restore. Anyone who can read this backup can also spend your funds.",
    success: `New changes will be saved to ${storageName(client?.user.provider)} while your wallet is open.`,
    restore:
      "Your saved wallet will open here, and automatic backups will continue.",
  };
  const prompt =
    open && !suspended ? (
      <Modal
        title={titles[step]}
        subtitle={subtitles[step]}
        close={close}
        className="backup-setup"
        eyebrow={`tmp.cash / ${["intro", "loading", "choose"].includes(step) ? "1 · SIGN IN" : step === "success" ? "3 · READY" : "2 · PROTECT YOUR WALLET"}`}
      >
        {step === "intro" && (
          <>
            <div className="backup-hero">
              <Cloud size={38} strokeWidth={1.4} />
              <span>
                <ShieldCheck size={18} />
              </span>
            </div>
            <ul className="backup-benefits">
              <li>
                <Smartphone size={21} />
                <div>
                  <strong>Find your wallet on a new device</strong>
                  <p>
                    Sign in with the same account to recover your saved wallet.
                  </p>
                </div>
              </li>
              <li>
                <Cloud size={21} />
                <div>
                  <strong>No backup files to keep track of</strong>
                  <p>
                    Copies are saved in your own{" "}
                    {googleClientId && appleConfigured
                      ? "Google Drive or iCloud"
                      : googleClientId
                        ? "Google Drive"
                        : "iCloud"}
                    .
                  </p>
                </div>
              </li>
              <li>
                <ShieldCheck size={21} />
                <div>
                  <strong>Your mint stays separate</strong>
                  <p>
                    Your mint never receives your account details or backups.
                  </p>
                </div>
              </li>
            </ul>
            {googleClientId && (
              <button
                className="button dark full provider-signin"
                disabled={working || (!googleReady && !error)}
                onClick={() => {
                  if (!googleReady) {
                    setError("");
                    setLoadVersion((value) => value + 1);
                    return;
                  }
                  void action(async () => connected(await connectGoogle()));
                }}
              >
                {!googleReady && !error ? (
                  <>
                    <LoaderCircle size={18} className="spinning" />
                    Loading Google…
                  </>
                ) : (
                  <>
                    Continue with Google
                    <ArrowRight size={17} />
                  </>
                )}
              </button>
            )}
            {appleConfigured && (
              <div className="apple-backup-signin">
                <div id="apple-sign-in-button" />
                <div id="apple-sign-out-button" hidden />
              </div>
            )}
            <button
              className="text-button centered backup-later"
              onClick={close}
            >
              Not now
            </button>
            <p className="small muted backup-note">
              Nothing is uploaded until you choose your backup protection.
              Sign-in is optional.
            </p>
          </>
        )}
        {step === "loading" && (
          <div className="backup-wait" role="status">
            <LoaderCircle className="spinning" size={30} />
            <p>
              Checking {storageName(client?.user.provider)} for your saved
              wallets…
            </p>
          </div>
        )}
        {step === "choose" && (
          <>
            <div className="backup-wallet-picker">
              {(showHistory ? backups : latest).map((backup) => (
                <button
                  key={backup.id}
                  className="backup-choice"
                  disabled={emptyCopies.has(backup.id)}
                  onClick={() => {
                    setSelected(backup);
                    setExactCopy(
                      !latest.some((value) => value.id === backup.id),
                    );
                    setPassword("");
                    setAcknowledged(false);
                    setError("");
                    setStep("restore");
                  }}
                >
                  <Cloud size={22} />
                  <span>
                    <strong>{backup.name}</strong>
                    <small>
                      Saved {new Date(backup.updated).toLocaleString()} ·{" "}
                      {backup.encrypted ? "Password protected" : "Account only"}
                      {showHistory &&
                        (latest.some((value) => value.id === backup.id)
                          ? " · Latest copy"
                          : " · Earlier copy")}
                      {emptyCopies.has(backup.id) && " · Empty copy"}
                    </small>
                  </span>
                  <ArrowRight size={18} />
                </button>
              ))}
            </div>
            {showHistory && (
              <p className="small muted backup-note">
                Earlier copies may miss recent activity. The wallet checks
                restored tokens with the mint before showing a spendable
                balance.
              </p>
            )}
            {backups.length > latest.length && (
              <button
                className="text-button centered"
                onClick={() => setShowHistory((value) => !value)}
              >
                {showHistory
                  ? "Show latest copies only"
                  : "Show earlier saved copies"}
              </button>
            )}
            <button
              className="text-button centered"
              onClick={() => setStep("protection")}
            >
              Start a separate wallet instead
            </button>
          </>
        )}
        {step === "protection" && (
          <>
            <div className="backup-choices">
              <button
                className="backup-choice recommended"
                onClick={() => {
                  setProtection("encrypted");
                  setError("");
                  setStep("password");
                }}
              >
                <KeyRound size={23} />
                <span>
                  <strong>
                    Add a backup password <em>Recommended</em>
                  </strong>
                  <small>
                    Extra protection if your account is accessed by someone
                    else. Keep the password for recovery.
                  </small>
                </span>
                <ArrowRight size={18} />
              </button>
              <button
                className="backup-choice"
                onClick={() => {
                  setProtection("plaintext");
                  setAcknowledged(false);
                  setError("");
                  setStep("unencrypted");
                }}
              >
                <Cloud size={23} />
                <span>
                  <strong>Use my account only</strong>
                  <small>
                    No separate password. Anyone with access to the backup can
                    spend your funds.
                  </small>
                </span>
                <ArrowRight size={18} />
              </button>
            </div>
            <p className="small muted backup-note">
              Connected with {providerName(client?.user.provider)} as{" "}
              <span className="cloud-label">{client?.user.label}</span>.
            </p>
            <button
              className="text-button centered backup-later"
              onClick={close}
            >
              Finish later
            </button>
          </>
        )}
        {(step === "password" || step === "unencrypted") && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void action(setup);
            }}
          >
            {step === "password" ? (
              <>
                <label htmlFor="cloud-password">Backup password</label>
                <input
                  id="cloud-password"
                  autoFocus
                  type="password"
                  minLength={12}
                  required
                  autoComplete="new-password"
                  placeholder="At least 12 characters"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <label htmlFor="cloud-confirm">Confirm password</label>
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
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  I understand that anyone with access to this backup can spend
                  my funds.
                </label>
              </div>
            )}
            <details className="backup-options">
              <summary>Wallet name (optional)</summary>
              <label htmlFor="cloud-name">Wallet name</label>
              <input
                id="cloud-name"
                type="text"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </details>
            <button
              className="button dark full"
              disabled={working || (step === "unencrypted" && !acknowledged)}
            >
              {working ? (
                <LoaderCircle className="spinning" size={18} />
              ) : (
                <ShieldCheck size={18} />
              )}
              Turn on automatic backup
            </button>
            <button
              className="text-button centered"
              type="button"
              disabled={working}
              onClick={() => {
                setError("");
                setPassword("");
                setConfirmation("");
                setStep("protection");
              }}
            >
              <ArrowLeft size={15} />
              Back
            </button>
          </form>
        )}
        {step === "restore" && selected && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void action(() => diagnoseAction("restore", restore));
            }}
          >
            <div className="backup-account">
              <Cloud size={22} />
              <div>
                <strong>{selected.name}</strong>
                <span>
                  {exactCopy && "Earlier copy · "}
                  Saved {new Date(selected.updated).toLocaleString()}
                </span>
              </div>
            </div>
            {emptyCopies.has(selected.id) && selected.encrypted && (
              <p className="small muted backup-note">
                Your backup password unlocked this copy successfully. Choose
                another saved copy to look for your wallet data.
              </p>
            )}
            {selected.encrypted ? (
              <>
                <label htmlFor="cloud-restore-password">Backup password</label>
                <input
                  id="cloud-restore-password"
                  autoFocus
                  type="password"
                  required
                  minLength={12}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </>
            ) : (
              <div className="cloud-warning">
                <p>This wallet uses your account only. {UNENCRYPTED_WARNING}</p>
                <label className="backup-ack">
                  <input
                    type="checkbox"
                    required
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  I understand that this backup has no password protection.
                </label>
              </div>
            )}
            <button
              className="button dark full"
              disabled={working || (!selected.encrypted && !acknowledged)}
            >
              {working ? (
                <LoaderCircle className="spinning" size={18} />
              ) : (
                <ArrowRight size={18} />
              )}
              Restore my wallet
            </button>
            <button
              type="button"
              className="text-button centered"
              disabled={working}
              onClick={() => {
                setSelected(null);
                setPassword("");
                setAcknowledged(false);
                setError("");
                setStep("choose");
              }}
            >
              <ArrowLeft size={15} />
              Choose another saved copy
            </button>
            <p className="small muted backup-note">
              {client?.user.provider === "google"
                ? "Google Drive keeps connected copies synchronized. Competing payments can still be rejected by the mint."
                : "Use one active copy of a restored wallet to avoid competing payments."}{" "}
              Backups do not extend token deadlines.
            </p>
          </form>
        )}
        {step === "saving" && (
          <div className="backup-wait" role="status">
            <LoaderCircle size={34} className="spinning" />
            <p>
              {progress?.error
                ? progress.message
                : "Making your first safe copy…"}
            </p>
            <p className="small muted">
              Your wallet stays saved on this device if you lose connection.
              We’ll retry automatically.
            </p>
            {progress?.error && (
              <button
                className="button dark full"
                disabled={working}
                onClick={() =>
                  void action(async () => {
                    await synchronizeRef.current(
                      () => saver.current?.save() ?? Promise.resolve(),
                    );
                  })
                }
              >
                Try again
              </button>
            )}
            <button className="text-button centered" onClick={close}>
              Keep using my wallet
            </button>
          </div>
        )}
        {step === "success" && (
          <>
            <div className="backup-success">
              <CheckCircle2 size={54} strokeWidth={1.4} />
              <p>Automatic backup is on</p>
            </div>
            <div className="backup-account">
              <Cloud size={23} />
              <div>
                <strong>{storageName(client?.user.provider)}</strong>
                <span className="cloud-label">{client?.user.label}</span>
              </div>
            </div>
            <p className="small muted backup-note">
              {progress?.encrypted
                ? "Keep your backup password. You’ll need it with this account when restoring on a new device."
                : "Recovery uses your account only. Anyone who can read the backup can spend your funds."}
            </p>
            <button className="button dark full" onClick={close}>
              Back to my wallet
              <ArrowRight size={18} />
            </button>
          </>
        )}
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        {error &&
          (step === "loading" || (step === "intro" && !googleReady)) && (
            <button
              className="button secondary full"
              disabled={working}
              onClick={() => {
                setError("");
                setLoadVersion((value) => value + 1);
              }}
            >
              Try again
            </button>
          )}
      </Modal>
    ) : null;
  const settings = (
    <section className="settings-card cloud-card">
      <h2>Wallet backup</h2>
      {!configured ? (
        <p className="muted">
          Cloud backup isn’t available here yet. You can still download a backup
          file below.
        </p>
      ) : (
        <>
          <p className="muted">
            {progress?.enabled
              ? "Your wallet saves recovery copies directly to your own cloud account."
              : "Keep a copy you can find again. Sign in and we’ll guide you through it."}
          </p>
          {client && (
            <p className="small cloud-label">
              {providerName(client.user.provider)} · {client.user.label}
            </p>
          )}
          {progress?.enabled ? (
            <>
              <p
                className={progress.error ? "cloud-warning" : "small"}
                role="status"
              >
                {progress.message}
              </p>
              {progress.updated > 0 && (
                <p className="small muted">
                  Last saved: {new Date(progress.updated).toLocaleString()} ·{" "}
                  {progress.encrypted ? "Password protected" : "Account only"}
                </p>
              )}
              <div className="cloud-actions">
                <button
                  className="button dark"
                  disabled={working || progress.saving}
                  onClick={() =>
                    void action(async () => {
                      await synchronizeRef.current(
                        () => saver.current?.save(true) ?? Promise.resolve(),
                      );
                    }, true)
                  }
                >
                  Back up now
                </button>
                {progress.reconnect && (
                  <button
                    className="button secondary"
                    onClick={() => {
                      setStep("intro");
                      setOpen(true);
                    }}
                  >
                    Reconnect {providerName(client?.user.provider)}
                  </button>
                )}
                <button
                  className="button secondary"
                  disabled={working}
                  onClick={() =>
                    void action(async () => {
                      await pauseCloud();
                      await synchronizeRef.current(
                        () => saver.current?.save() ?? Promise.resolve(),
                      );
                    }, true)
                  }
                >
                  Pause automatic backup
                </button>
              </div>
            </>
          ) : (
            <button className="button dark" onClick={start}>
              Set up automatic backup
              <ArrowRight size={17} />
            </button>
          )}
          {settingsError && (
            <p className="banner error" role="alert">
              {settingsError}
            </p>
          )}
          {client && (
            <details className="backup-manage">
              <summary>Manage saved wallets</summary>
              {!latest.length && (
                <p className="small muted">
                  Your saved wallets will appear here after the first backup.
                </p>
              )}
              <ul className="cloud-backups">
                {latest.map((backup) => (
                  <li key={backup.id}>
                    <strong>{backup.name}</strong>
                    <p className="small muted">
                      {new Date(backup.updated).toLocaleString()} ·{" "}
                      {backup.encrypted ? "Password protected" : "Account only"}
                    </p>
                    <div className="cloud-actions">
                      <button
                        className="button secondary"
                        disabled={working}
                        onClick={() => {
                          setSelected(backup);
                          setExactCopy(false);
                          setPassword("");
                          setAcknowledged(false);
                          setError("");
                          setStep("restore");
                          setOpen(true);
                        }}
                      >
                        Restore {backup.name}
                      </button>
                      <button
                        className="button secondary"
                        disabled={working}
                        onClick={() => {
                          if (
                            !confirm(
                              `Delete this saved copy of “${backup.name}”? Your wallet on this device will stay here.`,
                            )
                          )
                            return;
                          void action(async () => {
                            await client.remove(backup.id);
                            setBackups(await client.list());
                          }, true);
                        }}
                      >
                        Delete saved copy
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <button
                className="button secondary"
                disabled={working}
                onClick={() =>
                  void action(async () => {
                    await pauseCloud();
                    await client.disconnect();
                    setClient(null);
                    setProgress(null);
                    setWasDismissed(true);
                    try {
                      localStorage.setItem(BACKUP_PROMPT_DISMISSED, "1");
                    } catch {
                      /* Session still closes. */
                    }
                  }, true)
                }
              >
                Sign out
              </button>
            </details>
          )}
          <p className="small muted">
            Backups save while the wallet is open. Your mint never receives your
            account details or backup files.
          </p>
        </>
      )}
    </section>
  );
  const entry = configured ? (
    <button
      className="backup-entry"
      onClick={start}
      aria-label={
        progress?.enabled &&
        progress.updated > 0 &&
        !progress.saving &&
        !progress.error
          ? "Wallet backup is on"
          : "Set up wallet backup"
      }
    >
      <Cloud size={16} />
      <span>
        {progress?.enabled
          ? progress.error
            ? "Backup needs attention"
            : progress.saving || !progress.updated
              ? "Saving backup…"
              : "Backup on"
          : "Back up wallet"}
      </span>
    </button>
  ) : null;
  return {
    settings,
    prompt,
    entry,
    client,
    saveNow: async () => {
      const settings = await readCloudSettings();
      if (!client || settings?.account !== client.user.account)
        throw new Error("Enable Google Drive backups before synchronizing.");
      if (!saver.current)
        return Promise.reject(
          new Error(
            "Reconnect Google and enable wallet backups before synchronizing.",
          ),
        );
      return saver.current.flush();
    },
  };
}
