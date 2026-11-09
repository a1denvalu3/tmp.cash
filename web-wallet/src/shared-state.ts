import type {
  TmpCashState,
  TmpCashFunding,
  TmpCashOperation,
  TmpCashProofRecord,
  TmpCashActivity,
  TmpCashProofState,
} from "coco-cashu-core/tmp-cash";
import { psPreimageHash } from "@cashu/cashu-ts/tmp-cash";
import { validateTmpCashState } from "coco-cashu-indexeddb/tmp-cash";

export const emptyWallet = (): TmpCashState => ({
  proofs: [],
  operations: [],
  fundings: [],
  activity: [],
});
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Pure draft mutations. Only the enclosing Firestore transaction publishes a draft. */
export class SharedState {
  constructor(readonly state: TmpCashState) {}
  saveFunding(f: TmpCashFunding) {
    if (this.state.fundings.some((row) => row.id === f.id))
      throw new Error("Funding already exists");
    this.state.fundings.push(f);
  }
  updateFunding(f: TmpCashFunding) {
    const index = this.state.fundings.findIndex((row) => row.id === f.id);
    const saved = this.state.fundings[index];
    if (
      !saved ||
      saved.mint !== f.mint ||
      saved.preimage !== f.preimage ||
      saved.amount !== f.amount
    )
      throw new Error("Funding request changed");
    if (saved.state === "waiting") this.state.fundings[index] = f;
  }
  reserve(op: TmpCashOperation, inputs: TmpCashProofRecord[]) {
    if (this.state.operations.some((row) => row.id === op.id))
      throw new Error("Operation already exists");
    if (op.payload.kind === "mint") {
      const quote = op.payload.quote;
      if (
        this.state.fundings.some(
          (row) => row.id === quote.payment_hash && row.state === "minted",
        ) ||
        this.state.operations.some(
          (row) =>
            row.payload.kind === "mint" &&
            row.payload.quote.quote === quote.quote,
        )
      )
        throw new Error(
          "Quote already has a saved mint request; refresh or retry it",
        );
    }
    if (op.payload.kind === "melt") {
      const quote = op.payload.quote;
      if (
        this.state.operations.some(
          (row) =>
            row.mint === op.mint &&
            row.payload.kind === "melt" &&
            (row.payload.quote.quote === quote.quote ||
              row.payload.quote.payment_hash === quote.payment_hash),
        )
      )
        throw new Error("Quote already has a saved melt request; retry it");
    }
    for (const p of inputs) {
      const index = this.state.proofs.findIndex((row) => row.id === p.id);
      const saved = this.state.proofs[index];
      if (
        (!saved && op.purpose !== "receive") ||
        (saved &&
          (saved.mint !== p.mint ||
            saved.operationId !== null ||
            (saved.state !== "ready" &&
              !(op.purpose === "receive" && saved.state === "sent"))))
      )
        throw new Error(
          "Proof is already reserved, sent or spent; refresh your wallet",
        );
      const reserved = { ...p, state: "reserved" as const, operationId: op.id };
      if (index < 0) this.state.proofs.push(reserved);
      else this.state.proofs[index] = reserved;
    }
    this.state.operations.push(op);
  }
  private saved(op: TmpCashOperation) {
    const saved = this.state.operations.find((row) => row.id === op.id);
    if (
      saved &&
      (saved.mint !== op.mint ||
        JSON.stringify(canonical(saved.payload)) !==
          JSON.stringify(canonical(op.payload)))
    )
      throw new Error("Saved operation changed");
    return saved;
  }
  complete(
    op: TmpCashOperation,
    outputs: TmpCashProofRecord[],
    activity: TmpCashActivity,
  ) {
    if (!this.saved(op)) {
      if (
        this.state.activity.some(
          (row) =>
            row.id === op.id &&
            row.mint === op.mint &&
            row.purpose === op.purpose,
        )
      )
        return;
      throw new Error("Unknown saved operation");
    }
    const inputs = this.state.proofs.filter((row) => row.operationId === op.id);
    if (inputs.some((row) => row.state !== "reserved"))
      throw new Error("Input reservation changed");
    for (const output of outputs) {
      if (this.state.proofs.some((row) => row.id === output.id))
        throw new Error("Mint reused an existing proof");
      this.state.proofs.push(output);
    }
    for (const row of inputs) {
      row.state = "spent";
      row.operationId = null;
    }
    if (op.payload.kind === "mint") {
      const hash = op.payload.quote.payment_hash;
      const funding = this.state.fundings.find((row) => row.id === hash);
      if (funding) funding.state = "minted";
    }
    this.state.activity.push(activity);
    this.state.operations = this.state.operations.filter(
      (row) => row.id !== op.id,
    );
  }
  release(op: TmpCashOperation, expired = false) {
    const saved = this.saved(op);
    if (!saved) return;
    // Shared attempts can still be executing. Only terminal outcomes release inputs.
    if (
      !expired &&
      op.payload.kind === "melt" &&
      ![
        "melt payment failed; tokens are unspent",
        "melt quote has expired",
        "backing HTLC is closed; its tokens have expired",
        "melt quote already belongs to another request",
        "payout invoice is already paid",
      ].includes(saved.error ?? "")
    )
      throw new Error(
        "Retry this saved operation to resolve its shared reservation",
      );
    for (const row of this.state.proofs.filter(
      (row) => row.operationId === op.id,
    )) {
      if (row.state !== "reserved")
        throw new Error("Input reservation changed");
      row.state = expired ? "expired" : "ready";
      row.operationId = null;
      if (expired) row.expiredAt ??= Date.now();
    }
    this.state.operations = this.state.operations.filter(
      (row) => row.id !== op.id,
    );
  }
  setError(id: string, message: string) {
    const op = this.state.operations.find((row) => row.id === id);
    if (op) op.error = message.slice(0, 500);
  }
  updateProofStates(
    changes: { id: string; state: TmpCashProofState }[],
    expected: Map<string, string>,
  ) {
    for (const { id, state } of changes) {
      const p = this.state.proofs.find((row) => row.id === id);
      // A remote refresh is an observation, not permission to overwrite newer state.
      if (
        !p ||
        JSON.stringify(p) !== expected.get(id) ||
        p.operationId !== null ||
        !["ready", "sent", "pending", "expired"].includes(p.state)
      )
        continue;
      p.state = state;
      if (state === "expired") p.expiredAt ??= Date.now();
      else delete p.expiredAt;
    }
  }
  attachPreimage(mint: string, hash: string, preimage: string) {
    if (psPreimageHash(preimage) !== hash)
      throw new Error("Preimage does not match backing HTLC");
    const proofs = this.state.proofs.filter(
      (row) => row.mint === mint && row.proof.payment_hash === hash,
    );
    if (!proofs.length || proofs.some((row) => row.state === "reserved"))
      throw new Error("Backing is unknown or has a pending operation");
    for (const p of proofs) p.proof.preimage = preimage;
  }
  importState(state: TmpCashState) {
    if (Object.values(this.state).some((table) => table.length))
      throw new Error("Restore requires an empty wallet");
    Object.assign(this.state, validateTmpCashState(state));
  }
}
