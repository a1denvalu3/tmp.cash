import {
  doc,
  runTransaction,
  serverTimestamp,
  type Firestore,
  type Transaction,
} from "firebase/firestore";
import type { RecoveryProtection } from "./backup";

const CHUNK_SIZE = 500_000;
const MAX_CHUNKS = 16;
export interface WalletDocument {
  revision: number;
  protection: RecoveryProtection;
  backup: string;
}
export class FirestoreWallet {
  constructor(
    readonly db: Firestore,
    readonly uid: string,
  ) {
    if (!uid || uid.includes("/")) throw new Error("Invalid Google account");
  }
  private async load(
    tx: Transaction,
  ): Promise<(WalletDocument & { count: number }) | null> {
    const manifest = await tx.get(doc(this.db, "wallets", this.uid));
    if (!manifest.exists()) return null;
    const value = manifest.data();
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !Number.isInteger(value.count) ||
      value.count < 1 ||
      value.count > MAX_CHUNKS ||
      !["plaintext", "passphrase"].includes(value.protection?.mode)
    )
      throw new Error("Unsupported shared wallet format");
    const chunks = await Promise.all(
      Array.from({ length: value.count }, (_, index) =>
        tx.get(doc(this.db, "wallets", this.uid, "chunks", String(index))),
      ),
    );
    const backup = chunks
      .map((chunk) => {
        const row = chunk.data();
        if (
          !row ||
          row.revision !== value.revision ||
          typeof row.data !== "string" ||
          row.data.length > CHUNK_SIZE
        )
          throw new Error(
            "Shared wallet data is incomplete; reconnect before spending",
          );
        return row.data;
      })
      .join("");
    return {
      revision: value.revision,
      protection: value.protection,
      backup,
      count: value.count,
    };
  }
  async read(): Promise<WalletDocument | null> {
    return runTransaction(this.db, (tx) => this.load(tx));
  }
  /** A retry only recomputes encrypted state. Mint calls never run in this callback. */
  async update(
    change: (
      saved: WalletDocument | null,
    ) => Promise<Omit<WalletDocument, "revision"> | null>,
  ): Promise<WalletDocument> {
    for (let attempt = 0; ; attempt++) {
      let observedRevision = -1;
      try {
        return await runTransaction(this.db, async (tx) => {
          const previous = await this.load(tx);
          observedRevision = previous?.revision ?? 0;
          const next = await change(previous);
          if (!next) {
            if (!previous)
              throw new Error("Shared wallet has not been created");
            return previous;
          }
          // ASCII keeps document and transaction byte limits independent of user language.
          const backup = next.backup.replace(
            /[\u007f-\uffff]/g,
            (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
          );
          if (backup.length > CHUNK_SIZE * MAX_CHUNKS)
            throw new Error(
              "Shared wallet exceeds the cloud storage limit; export a backup",
            );
          if (
            previous &&
            JSON.stringify(next.protection) !==
              JSON.stringify(previous.protection)
          )
            throw new Error("Shared wallet protection changed");
          const revision = (previous?.revision ?? 0) + 1;
          const count = Math.max(1, Math.ceil(backup.length / CHUNK_SIZE));
          tx.set(doc(this.db, "wallets", this.uid), {
            version: 1,
            revision,
            protection: next.protection,
            count,
            updatedAt: serverTimestamp(),
          });
          for (let index = 0; index < count; index++)
            tx.set(doc(this.db, "wallets", this.uid, "chunks", String(index)), {
              revision,
              data: backup.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
            });
          for (let index = count; index < (previous?.count ?? 0); index++)
            tx.delete(
              doc(this.db, "wallets", this.uid, "chunks", String(index)),
            );
          return { ...next, backup, revision };
        });
      } catch (error) {
        // Revision rules may reject an optimistic edit before its commit precondition.
        // Retry only when a fresh, authorized read proves another edit won.
        const code = (error as { code?: string }).code ?? "";
        if (
          !code.endsWith("permission-denied") ||
          attempt >= 4 ||
          observedRevision < 0
        )
          throw error;
        const current = await this.read();
        if (!current || current.revision <= observedRevision) throw error;
      }
    }
  }
}
