import { useEffect, useRef, useState } from "react";
import { getAuth, type User } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { googleApp, connectGoogle, observeGoogleUser } from "./google";
import { newProtection, recoveryCodec } from "./backup";
import { RecoveryProtection } from "./RecoveryProtection";
import { FirestoreWallet, type WalletDocument } from "./firestore-wallet";
import { SharedRepository } from "./shared-repository";

const SELECTION = "tmp.cash-shared-wallet";
export function sharedWalletSelected() {
  try {
    return localStorage.getItem(SELECTION) === "true";
  } catch {
    return false;
  }
}
export function SharedWallet({
  mint,
  onSelect,
  disabled = false,
}: {
  mint: string;
  onSelect(repo: SharedRepository | null | "local", mint?: string): void;
  disabled?: boolean;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [selected, setSelected] = useState(sharedWalletSelected);
  const [opened, setOpened] = useState(false);
  const [profile, setProfile] = useState<WalletDocument | null | undefined>();
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"passphrase" | "plaintext">("passphrase");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const selectedRef = useRef(selected);
  function remember(value: boolean) {
    selectedRef.current = value;
    setSelected(value);
    try {
      localStorage.setItem(SELECTION, String(value));
    } catch {
      /* session selection still works */
    }
  }
  function store(next: User) {
    return new FirestoreWallet(getFirestore(googleApp()), next.uid);
  }
  async function activate(
    next: User,
    value: WalletDocument,
    passphrase: string,
    epoch: number,
  ) {
    const codec = await recoveryCodec(value.protection, passphrase);
    const contents = await codec.decode(value.backup);
    const repo = new SharedRepository(
      store(next),
      codec,
      contents.mint,
      () =>
        generation.current === epoch &&
        getAuth(googleApp()).currentUser?.uid === next.uid,
    );
    await repo.synchronize();
    if (generation.current !== epoch) return;
    setPassword("");
    setOpened(true);
    onSelect(repo, contents.mint);
  }
  useEffect(() => {
    const unsubscribe = observeGoogleUser((next) => {
      const epoch = ++generation.current;
      setUser(next);
      setOpened(false);
      setProfile(undefined);
      setPassword("");
      if (selectedRef.current) {
        onSelect(null);
        if (next) {
          setBusy(true);
          void store(next)
            .read()
            .then(async (value) => {
              if (generation.current !== epoch) return;
              setProfile(value);
              if (value?.protection.mode === "plaintext")
                await activate(next, value, "", epoch);
            })
            .catch(() => {
              if (generation.current === epoch)
                setError(
                  "Could not open the shared wallet. Check your connection and Firestore configuration.",
                );
            })
            .finally(() => {
              if (generation.current === epoch) setBusy(false);
            });
        }
      }
    });
    return () => {
      generation.current++;
      unsubscribe();
    };
  }, [onSelect]);
  async function action(fn: () => Promise<void>) {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not open the shared wallet",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <h2>Shared Google wallet</h2>
      <p className="muted">
        Use the same wallet across your devices. Spending needs an internet
        connection to synchronize reservations.
      </p>
      <p className="small">
        Your local wallet stays separate. Transfer funds between wallets using
        Send and Receive.
      </p>
      {selected && opened && (
        <p role="status">
          Google wallet open for {user?.email ?? "your account"}.
        </p>
      )}
      {(!selected || profile === undefined) && (
        <button
          className="button dark"
          disabled={busy || disabled}
          onClick={() =>
            void action(async () => {
              const next = user ?? (await connectGoogle()).user;
              const epoch = ++generation.current;
              remember(true);
              onSelect(null);
              const value = await store(next).read();
              if (generation.current !== epoch) return;
              setProfile(value);
              if (value?.protection.mode === "plaintext")
                await activate(next, value, "", epoch);
            })
          }
        >
          Use Google wallet
        </button>
      )}
      {selected && !opened && profile !== undefined && user && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              const epoch = generation.current;
              const target = store(user);
              let value = profile;
              if (!value) {
                const codec = await recoveryCodec(
                  newProtection(mode),
                  password,
                );
                const repo = new SharedRepository(target, codec, mint);
                await repo.create();
                value = await target.read();
                if (!value) throw new Error("Shared wallet was not created");
                if (generation.current === epoch) setProfile(value);
              }
              await activate(user, value, password, epoch);
            });
          }}
        >
          {!profile && (
            <RecoveryProtection
              mode={mode}
              onChange={(value) => {
                setMode(value);
                setPassword("");
              }}
            />
          )}
          {(profile
            ? profile.protection.mode === "passphrase"
            : mode === "passphrase") && (
            <>
              <label htmlFor="shared-passphrase">
                Shared wallet passphrase
              </label>
              <input
                id="shared-passphrase"
                type="password"
                minLength={12}
                required
                autoComplete={profile ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </>
          )}
          <button className="button dark" disabled={busy || disabled}>
            {profile ? "Unlock Google wallet" : "Create shared wallet"}
          </button>
        </form>
      )}
      {selected && (
        <button
          className="button secondary"
          disabled={busy || disabled}
          onClick={() => {
            generation.current++;
            remember(false);
            setOpened(false);
            setProfile(undefined);
            setPassword("");
            onSelect("local");
          }}
        >
          Use local wallet
        </button>
      )}
      {error && (
        <p role="alert" className="small">
          {error}
        </p>
      )}
    </section>
  );
}
