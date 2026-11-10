import type { Table, Transaction } from "dexie";
import { IdbDb } from "../lib/db";
import type {
  TmpCashRepository,
  TmpCashState,
  TmpCashFunding,
  TmpCashProofRecord,
  TmpCashOperation,
  TmpCashActivity,
  TmpCashProofState,
} from "coco-cashu-core/tmp-cash";
import { validateTmpCashState } from "./validation";
import { psNullifier, psPreimageHash } from "@cashu/cashu-ts/tmp-cash";

import {
  emptyWalletState,
  canonical,
  projectSyncFacts,
  validateSyncFact,
  type WalletSyncFact,
} from "./sync";

/** Separate PS schema: standard Coco secp256k1 proof tables are never reinterpreted. */
export class TmpCashIndexedDbRepository
  extends IdbDb
  implements TmpCashRepository
{
  proofs!: Table<TmpCashProofRecord, string>;
  operations!: Table<TmpCashOperation, string>;
  fundings!: Table<TmpCashFunding, string>;
  activity!: Table<TmpCashActivity, string>;
  syncFacts!: Table<WalletSyncFact, string>;
  syncData!: Table<{ id: string; value: unknown }, string>;
  // Keep the existing database identity so upgrades retain funds and operations.
  constructor(name = "cashu_layer3_wallet_v3") {
    super({ name });
    this.version(1).stores({
      proofs: "id,mint,state,operationId",
      operations: "id,mint",
      fundings: "id,mint,state",
      activity: "id,mint,createdAt",
    });
    this.version(2).stores({ syncFacts: "id", syncData: "id" });
  }
  override runTransaction<T>(
    mode: "r" | "rw",
    stores: string[],
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return super.runTransaction(
      mode,
      mode === "rw"
        ? [
            ...new Set([
              ...stores,
              "proofs",
              "operations",
              "fundings",
              "activity",
              "syncFacts",
              "syncData",
            ]),
          ]
        : stores,
      fn,
    );
  }
  private async journal(
    state: TmpCashState,
    terminal?: WalletSyncFact["terminal"],
    consumed?: WalletSyncFact["consumed"],
  ) {
    if (await this.syncData.get("journal"))
      await this.syncFacts.add({
        id: crypto.randomUUID(),
        state: structuredClone(state),
        ...(terminal ? { terminal } : {}),
        ...(consumed ? { consumed } : {}),
      });
  }
  async enableSyncJournal(): Promise<void> {
    await this.runTransaction(
      "rw",
      ["proofs", "operations", "fundings", "activity"],
      async () => {
        if (await this.syncData.get("journal")) return;
        await this.syncData.put({ id: "journal", value: true });
        await this.journal(await this.read());
      },
    );
  }
  async readSyncFacts(): Promise<WalletSyncFact[]> {
    return this.syncFacts.toArray();
  }
  async mergeSyncFacts(input: WalletSyncFact[]): Promise<void> {
    const facts = input.map(validateSyncFact);
    await this.runTransaction(
      "rw",
      ["proofs", "operations", "fundings", "activity"],
      async () => {
        for (const fact of facts) {
          const previous = await this.syncFacts.get(fact.id);
          if (previous && canonical(previous) !== canonical(fact))
            throw new Error("Sync fact identity was reused");
          if (!previous) await this.syncFacts.add(fact);
        }
        await this.projectJournal();
      },
    );
  }
  private async projectJournal() {
    const state = projectSyncFacts(
      await this.read(),
      await this.syncFacts.toArray(),
    );
    await this.proofs.clear();
    await this.operations.clear();
    await this.fundings.clear();
    await this.activity.clear();
    await this.proofs.bulkPut(state.proofs);
    await this.operations.bulkPut(state.operations);
    await this.fundings.bulkPut(state.fundings);
    await this.activity.bulkPut(state.activity);
  }
  async read(): Promise<TmpCashState> {
    return this.runTransaction(
      "r",
      ["proofs", "operations", "fundings", "activity"],
      async () => ({
        proofs: await this.proofs.toArray(),
        operations: await this.operations.toArray(),
        fundings: await this.fundings.toArray(),
        activity: await this.activity.toArray(),
      }),
    );
  }
  async saveFunding(f: TmpCashFunding): Promise<void> {
    await this.runTransaction("rw", ["fundings"], async () => {
      await this.fundings.add(f);
      await this.journal({ ...emptyWalletState(), fundings: [f] });
    });
  }
  async updateFunding(f: TmpCashFunding): Promise<void> {
    await this.runTransaction("rw", ["fundings"], async () => {
      const previous = await this.fundings.get(f.id);
      await this.fundings.put(f);
      if (canonical(previous) !== canonical(f))
        await this.journal({ ...emptyWalletState(), fundings: [f] });
    });
  }
  async reserve(
    op: TmpCashOperation,
    inputs: TmpCashProofRecord[],
  ): Promise<void> {
    await this.runTransaction("rw", ["operations", "proofs"], async () => {
      if (await this.operations.get(op.id))
        throw new Error("Operation already exists");
      const mintQuoteId =
        op.payload.kind === "mint" ? op.payload.quote.quote : null;
      if (
        mintQuoteId &&
        (await this.operations.toArray()).some(
          (o) =>
            o.payload.kind === "mint" && o.payload.quote.quote === mintQuoteId,
        )
      )
        throw new Error("Quote already has a saved mint request");
      const meltQuoteId =
        op.payload.kind === "melt" ? op.payload.quote.quote : null;
      const payoutHash =
        op.payload.kind === "melt" ? op.payload.quote.payment_hash : null;
      if (
        meltQuoteId &&
        (await this.operations.toArray()).some(
          (existing) =>
            existing.mint === op.mint &&
            existing.payload.kind === "melt" &&
            (existing.payload.quote.quote === meltQuoteId ||
              existing.payload.quote.payment_hash === payoutHash),
        )
      )
        throw new Error("Quote already has a saved melt request; retry it");
      for (const p of inputs) {
        const existing = await this.proofs.get(p.id);
        if (
          existing &&
          (existing.mint !== p.mint ||
            (existing.state !== "ready" &&
              !(op.purpose === "receive" && existing.state === "sent")))
        )
          throw new Error("Proof is already reserved, sent or spent");
        await this.proofs.put({ ...p, state: "reserved", operationId: op.id });
      }
      await this.operations.add(op);
      await this.journal({
        ...emptyWalletState(),
        operations: [op],
        proofs: inputs.map((p) => ({
          ...p,
          state: "reserved",
          operationId: op.id,
        })),
      });
    });
  }
  async reserveMany(
    entries: {
      operation: TmpCashOperation;
      inputs: TmpCashProofRecord[];
    }[],
  ): Promise<void> {
    await this.runTransaction("rw", ["operations", "proofs"], async () => {
      for (const entry of entries)
        await this.reserve(entry.operation, entry.inputs);
    });
  }
  async complete(
    op: TmpCashOperation,
    proofs: TmpCashProofRecord[],
    activity: TmpCashActivity,
  ): Promise<void> {
    await this.runTransaction(
      "rw",
      ["operations", "proofs", "activity", "fundings"],
      async () => {
        if (!(await this.operations.get(op.id)))
          throw new Error("Unknown saved operation");
        const inputs =
          op.payload.kind === "mint"
            ? []
            : (
                await this.proofs.bulkGet(
                  op.payload.token.proofs.map(psNullifier),
                )
              ).filter((p): p is TmpCashProofRecord => !!p);
        for (const p of inputs)
          await this.proofs.put({ ...p, state: "spent", operationId: null });
        for (const p of proofs) {
          if (await this.proofs.get(p.id))
            throw new Error("Mint reused an existing proof");
          await this.proofs.add(p);
        }
        if (op.payload.kind === "mint") {
          const f = await this.fundings.get(op.payload.quote.payment_hash);
          if (f) await this.fundings.put({ ...f, state: "minted" });
        }
        await this.activity.add(activity);
        await this.operations.delete(op.id);
        const funding =
          op.payload.kind === "mint"
            ? await this.fundings.get(op.payload.quote.payment_hash)
            : null;
        await this.journal(
          {
            ...emptyWalletState(),
            fundings: funding ? [funding] : [],
            proofs: [
              ...inputs.map((p) => ({
                ...p,
                state: "spent" as const,
                operationId: null,
              })),
              ...proofs,
            ],
            activity: [activity],
          },
          undefined,
          {
            id: op.id,
            inputs: inputs.map((p) => p.id),
            quote: op.payload.kind === "mint" ? op.payload.quote.quote : null,
          },
        );
        if (await this.syncData.get("journal")) await this.projectJournal();
      },
    );
  }
  async release(op: TmpCashOperation): Promise<void> {
    await this.runTransaction("rw", ["operations", "proofs"], async () => {
      const saved = await this.operations.get(op.id);
      if (!saved) return;
      if (
        saved.mint !== op.mint ||
        JSON.stringify(saved.payload) !== JSON.stringify(op.payload)
      )
        throw new Error("Saved operation changed");
      const inputs = await this.proofs
        .where("operationId")
        .equals(op.id)
        .toArray();
      for (const proof of inputs) {
        if (proof.state !== "reserved")
          throw new Error("Input reservation changed");
        await this.proofs.update(proof.id, {
          state: "ready",
          operationId: null,
        });
      }
      await this.operations.delete(op.id);
      await this.journal(
        {
          ...emptyWalletState(),
          proofs: (await this.proofs.bulkGet(inputs.map((p) => p.id))).filter(
            (p): p is TmpCashProofRecord => !!p,
          ),
        },
        { id: op.id, state: "released" },
      );
      if (await this.syncData.get("journal")) await this.projectJournal();
    });
  }
  async expire(op: TmpCashOperation): Promise<void> {
    await this.runTransaction("rw", ["operations", "proofs"], async () => {
      const saved = await this.operations.get(op.id);
      if (!saved) return;
      if (
        saved.mint !== op.mint ||
        JSON.stringify(saved.payload) !== JSON.stringify(op.payload)
      )
        throw new Error("Saved operation changed");
      const inputs = await this.proofs
        .where("operationId")
        .equals(op.id)
        .toArray();
      // Terminal melt failure: the mint released its reservation, but the
      // backing is closed, so these inputs must never become ready again.
      const observedAt = Date.now();
      for (const proof of inputs) {
        if (proof.state !== "reserved")
          throw new Error("Input reservation changed");
        const { expiredAt, ...record } = proof;
        await this.proofs.put({
          ...record,
          state: "expired",
          operationId: null,
          expiredAt: expiredAt ?? observedAt,
        });
      }
      await this.operations.delete(op.id);
      await this.journal(
        {
          ...emptyWalletState(),
          proofs: (await this.proofs.bulkGet(inputs.map((p) => p.id))).filter(
            (p): p is TmpCashProofRecord => !!p,
          ),
        },
        { id: op.id, state: "expired" },
      );
      if (await this.syncData.get("journal")) await this.projectJournal();
    });
  }
  async setError(id: string, error: string): Promise<void> {
    await this.operations.update(id, { error: error.slice(0, 500) });
  }
  async updateProofStates(
    changes: { id: string; state: TmpCashProofState }[],
  ): Promise<void> {
    await this.runTransaction("rw", ["proofs"], async () => {
      const observedAt = Date.now();
      for (const { id, state } of changes) {
        const p = await this.proofs.get(id);
        if (
          p &&
          p.operationId === null &&
          ["ready", "sent", "pending", "expired"].includes(p.state)
        ) {
          const { expiredAt, ...record } = p;
          await this.proofs.put({
            ...record,
            state,
            ...(state === "expired"
              ? { expiredAt: expiredAt ?? observedAt }
              : {}),
          });
          if (state === "spent")
            await this.journal({
              ...emptyWalletState(),
              proofs: [{ ...record, state, operationId: null }],
            });
        }
      }
    });
  }
  async attachPreimage(
    mint: string,
    paymentHash: string,
    preimage: string,
  ): Promise<void> {
    if (psPreimageHash(preimage) !== paymentHash)
      throw new Error("Preimage does not match backing HTLC");
    await this.runTransaction("rw", ["proofs"], async () => {
      const proofs = (
        await this.proofs.where("mint").equals(mint).toArray()
      ).filter((p) => p.proof.payment_hash === paymentHash);
      if (!proofs.length || proofs.some((p) => p.state === "reserved"))
        throw new Error("Backing is unknown or has a pending operation");
      for (const p of proofs)
        await this.proofs.put({ ...p, proof: { ...p.proof, preimage } });
      await this.journal({
        ...emptyWalletState(),
        proofs: proofs.map((p) => ({ ...p, proof: { ...p.proof, preimage } })),
      });
    });
  }
  async importState(input: TmpCashState): Promise<void> {
    const state = validateTmpCashState(input);
    await this.runTransaction(
      "rw",
      ["proofs", "operations", "fundings", "activity"],
      async () => {
        // Restore into an empty wallet to avoid resurrecting locally spent or reserved proofs.
        if (
          (await this.proofs.count()) ||
          (await this.operations.count()) ||
          (await this.fundings.count()) ||
          (await this.activity.count())
        )
          throw new Error(
            "Restore requires an empty wallet in a new browser profile",
          );
        await this.proofs.bulkAdd(state.proofs);
        await this.operations.bulkAdd(state.operations);
        await this.fundings.bulkAdd(state.fundings);
        await this.activity.bulkAdd(state.activity);
        await this.journal(state);
      },
    );
  }
}
