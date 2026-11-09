import type {
  TmpCashRepository,
  TmpCashState,
  TmpCashFunding,
  TmpCashOperation,
  TmpCashProofRecord,
  TmpCashActivity,
  TmpCashProofState,
} from "coco-cashu-core/tmp-cash";
import { validateTmpCashState } from "coco-cashu-indexeddb/tmp-cash";
import { type RecoveryCodec } from "./backup";
import { FirestoreWallet, type WalletDocument } from "./firestore-wallet";
import { emptyWallet, SharedState } from "./shared-state";

/** Reservations and exact requests are committed remotely before manager execution. */
export class SharedRepository implements TmpCashRepository {
  private cache = emptyWallet();
  private revision = 0;
  constructor(
    readonly store: FirestoreWallet,
    readonly codec: RecoveryCodec,
    readonly mint: string,
    private readonly active: () => boolean = () => true,
  ) {}
  private authorized() {
    if (!this.active())
      throw new Error("Unlock your Google wallet before spending");
  }
  private async accept(value: WalletDocument) {
    if (
      JSON.stringify(value.protection) !== JSON.stringify(this.codec.protection)
    )
      throw new Error("Shared wallet protection changed");
    const decoded = await this.codec.decode(value.backup);
    // A slower request must never replace a later commit in this instance's cache.
    if (value.revision >= this.revision) {
      this.cache = decoded.state;
      this.revision = value.revision;
    }
  }
  async create() {
    this.authorized();
    const backup = await this.codec.encode(emptyWallet(), this.mint);
    const value = await this.store.update(async (saved) => {
      if (saved)
        throw new Error("A shared wallet already exists; open it instead");
      return { protection: this.codec.protection, backup };
    });
    await this.accept(value);
  }
  async synchronize() {
    this.authorized();
    const value = await this.store.read();
    if (!value) throw new Error("Shared wallet has not been created");
    await this.accept(value);
  }
  async read(): Promise<TmpCashState> {
    this.authorized();
    return structuredClone(this.cache);
  }
  private async mutate(change: (draft: SharedState) => void) {
    this.authorized();
    const value = await this.store.update(async (saved) => {
      this.authorized();
      if (!saved) throw new Error("Shared wallet has not been created");
      if (
        JSON.stringify(saved.protection) !==
        JSON.stringify(this.codec.protection)
      )
        throw new Error("Shared wallet protection changed");
      const decoded = await this.codec.decode(saved.backup);
      const before = JSON.stringify(decoded.state);
      const draft = new SharedState(decoded.state);
      change(draft);
      const state = validateTmpCashState(draft.state);
      if (JSON.stringify(state) === before) return null;
      return {
        protection: this.codec.protection,
        backup: await this.codec.encode(state, this.mint),
      };
    });
    await this.accept(value);
  }
  saveFunding(funding: TmpCashFunding) {
    return this.mutate((draft) => draft.saveFunding(funding));
  }
  updateFunding(funding: TmpCashFunding) {
    return this.mutate((draft) => draft.updateFunding(funding));
  }
  reserve(op: TmpCashOperation, proofs: TmpCashProofRecord[]) {
    return this.mutate((draft) => draft.reserve(op, proofs));
  }
  reserveMany(
    entries: { operation: TmpCashOperation; inputs: TmpCashProofRecord[] }[],
  ) {
    return this.mutate((draft) => {
      for (const row of entries) draft.reserve(row.operation, row.inputs);
    });
  }
  complete(
    op: TmpCashOperation,
    proofs: TmpCashProofRecord[],
    activity: TmpCashActivity,
  ) {
    return this.mutate((draft) => draft.complete(op, proofs, activity));
  }
  release(op: TmpCashOperation) {
    return this.mutate((draft) => draft.release(op));
  }
  expire(op: TmpCashOperation) {
    return this.mutate((draft) => draft.release(op, true));
  }
  setError(id: string, message: string) {
    return this.mutate((draft) => draft.setError(id, message));
  }
  updateProofStates(changes: { id: string; state: TmpCashProofState }[]) {
    if (!changes.length) return Promise.resolve();
    const expected = new Map(
      this.cache.proofs.map((row) => [row.id, JSON.stringify(row)]),
    );
    return this.mutate((draft) => draft.updateProofStates(changes, expected));
  }
  attachPreimage(mint: string, hash: string, preimage: string) {
    return this.mutate((draft) => draft.attachPreimage(mint, hash, preimage));
  }
  importState(state: TmpCashState) {
    return this.mutate((draft) => draft.importState(state));
  }
}
