import {
  decodePSToken,
  psPreimageHash,
  psInvoiceDetails,
} from "@cashu/cashu-ts/tmp-cash";
import type {
  TmpCashActivity,
  TmpCashActivityBacking,
  TmpCashView,
} from "coco-cashu-core/tmp-cash";
import type { ExpiredBacking } from "./backings";

export const purposeNames = {
  mint: "Added ecash",
  send: "Sent ecash",
  receive: "Received ecash",
  melt: "Lightning payment",
  expire: "Backing expired",
};
export type ExpiryActivity = ExpiredBacking & {
  id: string;
  purpose: "expire";
  createdAt: number | null;
};
export type WalletActivity = TmpCashActivity | ExpiryActivity;

export function activityDetails(row: WalletActivity, view: TmpCashView | null) {
  const saved = row.purpose === "expire" ? undefined : row.details;
  const token =
    row.purpose === "expire" ? null : (row.token ?? saved?.token ?? null);
  let backings: TmpCashActivityBacking[] = saved?.backings ?? [];
  // Older outgoing tokens still contain an exact backing/value association.
  if (!backings.length && token) {
    const groups = new Map<string, TmpCashActivityBacking>();
    for (const proof of decodePSToken(token).proofs) {
      const group = groups.get(proof.payment_hash) ?? {
        paymentHash: proof.payment_hash,
        backingAmount: proof.backing_amount,
        amount: 0,
        snapshot: null,
      };
      group.amount += proof.amount;
      groups.set(proof.payment_hash, group);
    }
    backings = [...groups.values()];
  }
  if (row.purpose === "expire") {
    const proof = view?.proofs.find(
      (p) => p.mint === view.mint && p.proof.payment_hash === row.hash,
    );
    const recorded = view?.activity
      .filter((a) => a.mint === view.mint)
      .flatMap((a) => a.details?.backings ?? [])
      .find((b) => b.paymentHash === row.hash && b.snapshot !== null);
    backings = [
      {
        paymentHash: row.hash,
        backingAmount:
          recorded?.backingAmount ??
          proof?.proof.backing_amount ??
          row.amount + row.sharedAmount,
        amount: row.amount + row.sharedAmount,
        snapshot: recorded?.snapshot ?? null,
      },
    ];
  }
  return {
    completedAt: saved?.completedAt ?? null,
    invoice: saved?.invoice ?? null,
    quoteId: saved?.quoteId ?? null,
    token,
    backings: backings.map((b) => ({
      ...b,
      snapshot:
        b.snapshot ??
        view?.snapshot?.htlcs.find((h) => h.payment_hash === b.paymentHash) ??
        null,
    })),
  };
}

export function paymentProofVerified(row: WalletActivity): boolean {
  if (row.purpose !== "melt" || !row.receipt) return false;
  try {
    return (
      psPreimageHash(row.receipt.payout_preimage) === row.receipt.payout_hash &&
      (!row.details?.invoice ||
        psInvoiceDetails(row.details.invoice).paymentHash ===
          row.receipt.payout_hash)
    );
  } catch {
    return false;
  }
}
