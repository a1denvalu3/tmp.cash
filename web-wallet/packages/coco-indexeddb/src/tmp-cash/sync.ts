import { z } from "zod";
import { psNullifier, decodePSToken } from "@cashu/cashu-ts/tmp-cash";
import type {
  TmpCashState,
  TmpCashProofRecord,
  TmpCashOperation,
} from "coco-cashu-core/tmp-cash";
import { validateTmpCashState } from "./validation";

/** Immutable transaction fragments. Observation caches (pending/expiry) stay local. */
export interface WalletSyncFact {
  id: string;
  state: TmpCashState;
  terminal?: { id: string; state: "released" | "expired" };
  consumed?: { id: string; inputs: string[]; quote: string | null };
}
export const emptyWalletState = (): TmpCashState => ({
  proofs: [],
  operations: [],
  fundings: [],
  activity: [],
});
const envelope = z
  .object({
    id: z.string().uuid(),
    state: z.unknown(),
    consumed: z
      .object({
        id: z.string().regex(/^[0-9a-f]{64}$/),
        inputs: z.array(z.string().regex(/^[0-9a-f]{96}$/)).max(256),
        quote: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
      })
      .strict()
      .optional(),
    terminal: z
      .object({
        id: z.string().regex(/^[0-9a-f]{64}$/),
        state: z.enum(["released", "expired"]),
      })
      .strict()
      .optional(),
  })
  .strict();
export function validateSyncFact(value: unknown): WalletSyncFact {
  const fact = envelope.parse(value);
  const state = validateTmpCashState(fact.state);
  if (
    fact.consumed &&
    (!state.activity.some((a) => a.id === fact.consumed!.id) ||
      fact.consumed.inputs.some(
        (id) => !state.proofs.some((p) => p.id === id && p.state === "spent"),
      ))
  )
    throw new Error("Sync completion has inconsistent inputs");
  return { ...fact, state };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const operationIdentity = (op: TmpCashOperation) =>
  canonical({ ...op, error: null });
const proofIdentity = (p: TmpCashProofRecord) =>
  canonical({ mint: p.mint, proof: { ...p.proof, preimage: null } });

/** Derive wallet state from facts; the mint, rather than CRDT property ordering, selects spend winners. */
export function projectSyncFacts(
  local: TmpCashState,
  facts: WalletSyncFact[],
): TmpCashState {
  const proofs = new Map<string, TmpCashProofRecord>();
  const operations = new Map<string, TmpCashOperation>();
  const fundings = new Map<string, TmpCashState["fundings"][number]>();
  const activity = new Map<string, TmpCashState["activity"][number]>();
  const spent = new Set<string>(),
    sent = new Set<string>(),
    terminal = new Set<string>();
  const winners: {
    id: string;
    inputs: Set<string>;
    quote: string | null;
    mint: string;
  }[] = [];
  for (const fact of facts) {
    if (fact.terminal) terminal.add(fact.terminal.id);
    if (fact.consumed)
      winners.push({
        ...fact.consumed,
        mint: fact.state.activity.find((row) => row.id === fact.consumed!.id)!
          .mint,
        inputs: new Set(fact.consumed.inputs),
      });
  }
  // Local observations take precedence over remote observations, but never over ownership or spent facts.
  const states = [
    ...facts
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((f) => f.state),
    local,
  ];
  for (const state of states) {
    for (const p of state.proofs) {
      const previous = proofs.get(p.id);
      if (previous && proofIdentity(previous) !== proofIdentity(p))
        throw new Error("Sync contains inconsistent proof identities");
      if (p.state === "spent") spent.add(p.id);
      if (p.state === "sent") sent.add(p.id);
      proofs.set(p.id, {
        ...p,
        proof: {
          ...p.proof,
          preimage: p.proof.preimage ?? previous?.proof.preimage ?? null,
        },
        operationId: null,
        state: p.state === "reserved" ? "ready" : p.state,
      });
    }
    for (const op of state.operations) {
      const previous = operations.get(op.id);
      if (previous && operationIdentity(previous) !== operationIdentity(op))
        throw new Error("Sync contains inconsistent operation identities");
      operations.set(op.id, op);
    }
    for (const f of state.fundings) {
      const previous = fundings.get(f.id);
      if (
        previous &&
        (previous.mint !== f.mint ||
          previous.amount !== f.amount ||
          previous.preimage !== f.preimage)
      )
        throw new Error("Sync contains inconsistent funding identities");
      const rank = (s: string) =>
        ({ UNPAID: 0, ACCEPTED: 1, SETTLED: 2, CANCELED: 2 })[s] ?? 0;
      const quotes = [previous?.quote, f.quote]
        .filter((q) => q != null)
        .sort(
          (a, b) =>
            rank(b.state) - rank(a.state) ||
            canonical(a).localeCompare(canonical(b)),
        );
      fundings.set(f.id, {
        ...f,
        quote: quotes[0] ?? null,
        state:
          previous?.state === "minted" || f.state === "minted"
            ? "minted"
            : previous?.state === "closed" || f.state === "closed"
              ? "closed"
              : "waiting",
      });
    }
    for (const row of state.activity) {
      const previous = activity.get(row.id);
      if (
        previous &&
        canonical({ ...previous, details: undefined }) !==
          canonical({ ...row, details: undefined })
      )
        throw new Error("Sync contains inconsistent completed operations");
      activity.set(
        row.id,
        previous && canonical(previous) < canonical(row) ? previous : row,
      );
      terminal.add(row.id);
    }
  }
  for (const row of activity.values())
    if (row.purpose === "send" && row.token) {
      for (const proof of decodePSToken(row.token).proofs)
        sent.add(psNullifier(proof));
    }
  for (const op of operations.values()) {
    const payload = op.payload;
    if (
      winners.some(
        (w) =>
          w.mint === op.mint &&
          w.id !== op.id &&
          (payload.kind === "mint"
            ? w.quote === payload.quote.quote
            : payload.token.proofs.some((p) => w.inputs.has(psNullifier(p)))),
      )
    )
      terminal.add(op.id);
  }
  for (const id of terminal) operations.delete(id);
  for (const p of proofs.values()) {
    if (spent.has(p.id)) p.state = "spent";
    else if (sent.has(p.id)) p.state = "sent";
    else if (p.state === "reserved") p.state = "ready";
  }
  for (const op of [...operations.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (op.payload.kind === "mint") continue;
    for (const input of op.payload.token.proofs) {
      const p = proofs.get(psNullifier(input));
      if (!p) continue;
      p.state = "reserved";
      p.operationId ??= op.id;
    }
  }
  return validateTmpCashState({
    proofs: [...proofs.values()].sort((a, b) => a.id.localeCompare(b.id)),
    operations: [...operations.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    fundings: [...fundings.values()].sort((a, b) => a.id.localeCompare(b.id)),
    activity: [...activity.values()].sort((a, b) => a.id.localeCompare(b.id)),
  });
}
