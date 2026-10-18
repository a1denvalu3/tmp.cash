import { expect, it } from "vitest";
import {
  activityDetails,
  paymentProofVerified,
  type WalletActivity,
} from "../src/activity";
import type { TmpCashActivity, TmpCashView } from "coco-cashu-core/tmp-cash";
import { psPreimageHash, type PSBacking } from "@cashu/cashu-ts/tmp-cash";

const mint = "https://mint.example";
const row: TmpCashActivity = {
  id: "01".repeat(32),
  mint,
  purpose: "mint",
  amount: 32,
  createdAt: 1,
  state: "complete",
  token: null,
  receipt: null,
};

it("keeps old activity readable without inventing its invoice, token, backing, or completion time", () => {
  expect(activityDetails(row, null)).toEqual({
    completedAt: null,
    invoice: null,
    quoteId: null,
    token: null,
    backings: [],
  });
  expect(paymentProofVerified(row)).toBe(false);
});

it("uses the matching mint's saved backing snapshot after expiry, even when the deposit had no snapshot", () => {
  const hash = "02".repeat(32);
  const backing: PSBacking = {
    payment_hash: hash,
    amount: 100,
    invoice_expires_at: 1,
    htlc_expiry_height: null,
    expiry_height: null,
    blocks_remaining: null,
    expires_at: 100,
    melt_deadline_height: null,
    melt_deadline: 90,
  };
  const withBacking = (
    sourceMint: string,
    snapshot: PSBacking | null,
  ): TmpCashActivity => ({
    ...row,
    mint: sourceMint,
    details: {
      completedAt: 2,
      invoice: null,
      quoteId: null,
      token: null,
      backings: [
        { paymentHash: hash, backingAmount: 100, amount: 32, snapshot },
      ],
    },
  });
  const view: TmpCashView = {
    proofs: [],
    operations: [],
    fundings: [],
    activity: [
      withBacking("https://other.example", { ...backing, melt_deadline: 500 }),
      withBacking(mint, null),
      withBacking(mint, backing),
    ],
    mint,
    balance: 0,
    redeemable: 0,
    reserved: 0,
    sent: 0,
    expired: 32,
    snapshot: null,
    verified: false,
  };
  const expiry: WalletActivity = {
    id: `expired-${hash}`,
    purpose: "expire",
    hash,
    amount: 32,
    sharedAmount: 0,
    observedAt: 5,
    createdAt: 5,
  };
  expect(activityDetails(expiry, view).backings).toEqual([
    { paymentHash: hash, backingAmount: 100, amount: 32, snapshot: backing },
  ]);
});

it("verifies a legacy payment proof against its recorded hash and rejects an incorrect preimage", () => {
  const preimage = "03".repeat(32);
  const paid: TmpCashActivity = {
    ...row,
    purpose: "melt",
    receipt: {
      state: "PAID",
      amount: 32,
      fee: 0,
      fee_msat: 0,
      payout_hash: psPreimageHash(preimage),
      payout_preimage: preimage,
      change: [],
      expired_change: 0,
    },
  };
  expect(paymentProofVerified(paid)).toBe(true);
  paid.receipt!.payout_preimage = "00".repeat(32);
  expect(paymentProofVerified(paid)).toBe(false);
});
