import type { TmpCashFunding, TmpCashOperation } from "./types";

/** Invoice expiry only ends unpaid deposits; accepted HTLCs have their own deadline. */
export function tmpCashFundingStatus(
  funding: TmpCashFunding,
  operations: readonly TmpCashOperation[] = [],
  now = Date.now(),
): TmpCashFunding["state"] | "expired" {
  if (
    funding.state === "waiting" &&
    funding.quote?.state === "OPEN" &&
    funding.quote.expiry * 1000 <= now &&
    !operations.some(
      (op) =>
        op.mint === funding.mint &&
        op.payload.kind === "mint" &&
        op.payload.quote.payment_hash === funding.id,
    )
  )
    return "expired";
  return funding.state;
}
