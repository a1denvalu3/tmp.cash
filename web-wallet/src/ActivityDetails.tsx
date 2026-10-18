import { useId } from "react";
import type { TmpCashView } from "coco-cashu-core/tmp-cash";
import {
  activityDetails,
  paymentProofVerified,
  type WalletActivity,
} from "./activity";
import { CopyButton } from "./CopyButton";

const sats = (value: number) => `${value.toLocaleString("en-US")} sats`;
function When({ time }: { time: number | null }) {
  return time === null ? (
    <>Not recorded</>
  ) : (
    <time
      dateTime={new Date(time).toISOString()}
      title={new Date(time).toISOString()}
    >
      {new Date(time).toLocaleString(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      })}
    </time>
  );
}
function Payload({ label, value }: { label: string; value: string }) {
  const id = useId();
  return (
    <div className="activity-payload">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="payload"
        readOnly
        spellCheck={false}
        rows={value.length > 100 ? 4 : 2}
        value={value}
      />
      <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}

export function ActivityDetails({
  row,
  view,
}: {
  row: WalletActivity;
  view: TmpCashView | null;
}) {
  const details = activityDetails(row, view);
  const receipt = row.purpose === "melt" ? row.receipt : null;
  const mint = row.purpose === "expire" ? view?.mint : row.mint;
  return (
    <div className="activity-details">
      <dl className="activity-facts">
        <div>
          <dt>Amount</dt>
          <dd>{sats(row.amount)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            {row.purpose === "expire"
              ? "Expired"
              : row.state === "sent"
                ? "Shared token"
                : "Completed"}
          </dd>
        </div>
        <div>
          <dt>{row.purpose === "expire" ? "Expiry observed" : "Started"}</dt>
          <dd>
            <When time={row.createdAt} />
          </dd>
        </div>
        {row.purpose !== "expire" && (
          <div>
            <dt>Completed</dt>
            <dd>
              <When time={details.completedAt} />
            </dd>
          </div>
        )}
        <div>
          <dt>Mint</dt>
          <dd className="mono">{mint}</dd>
        </div>
        {row.purpose === "expire" && row.sharedAmount > 0 && (
          <div>
            <dt>Also in shared tokens</dt>
            <dd>{sats(row.sharedAmount)}</dd>
          </div>
        )}
        {receipt && (
          <>
            <div>
              <dt>Fee</dt>
              <dd>
                {sats(receipt.fee)} ({receipt.fee_msat.toLocaleString("en-US")}{" "}
                msat)
              </dd>
            </div>
            <div>
              <dt>Total paid</dt>
              <dd>{sats(receipt.amount + receipt.fee)}</dd>
            </div>
            <div>
              <dt>Change returned</dt>
              <dd>
                {sats(receipt.change.reduce((sum, p) => sum + p.amount, 0))}
              </dd>
            </div>
            <div>
              <dt>Expired change</dt>
              <dd>{sats(receipt.expired_change)}</dd>
            </div>
          </>
        )}
      </dl>
      {row.purpose !== "expire" && (
        <Payload label="Activity ID" value={row.id} />
      )}
      {details.invoice ? (
        <Payload
          label={
            row.purpose === "mint" ? "Funding invoice" : "Lightning invoice"
          }
          value={details.invoice}
        />
      ) : (
        (row.purpose === "mint" || row.purpose === "melt") && (
          <p className="small muted">
            Invoice not recorded for this older activity.
          </p>
        )
      )}
      {details.quoteId && <Payload label="Quote ID" value={details.quoteId} />}
      {receipt && (
        <section className="activity-detail-section" aria-label="Payment proof">
          <h3>Payment proof</h3>
          <p className="small muted">
            {paymentProofVerified(row)
              ? details.invoice
                ? "The mint returned this preimage. It matches the invoice payment hash."
                : "The mint returned this preimage. It matches the recorded payment hash."
              : "This saved payment proof could not be verified."}
          </p>
          <Payload label="Payment hash" value={receipt.payout_hash} />
          <Payload label="Payment preimage" value={receipt.payout_preimage} />
        </section>
      )}
      <section
        className="activity-detail-section"
        aria-label="Activity backings"
      >
        <h3>Backing{details.backings.length === 1 ? "" : "s"}</h3>
        {!details.backings.length && (
          <p className="small muted">
            Backing details not recorded for this older activity.
          </p>
        )}
        {details.backings.map((backing, index) => {
          const funding = view?.fundings.find(
            (f) => f.mint === mint && f.id === backing.paymentHash,
          );
          return (
            <div className="activity-backing" key={backing.paymentHash}>
              <Payload
                label={`Backing hash${details.backings.length > 1 ? ` ${index + 1}` : ""}`}
                value={backing.paymentHash}
              />
              <dl className="activity-facts">
                <div>
                  <dt>Backing amount</dt>
                  <dd>{sats(backing.backingAmount)}</dd>
                </div>
                <div>
                  <dt>
                    {row.purpose === "melt"
                      ? "Ecash used"
                      : "Ecash in this activity"}
                  </dt>
                  <dd>{sats(backing.amount)}</dd>
                </div>
                {backing.snapshot?.melt_deadline != null && (
                  <div>
                    <dt>Redemption deadline</dt>
                    <dd>
                      <When time={backing.snapshot.melt_deadline * 1000} />
                    </dd>
                  </div>
                )}
                {backing.snapshot?.melt_deadline_height != null && (
                  <div>
                    <dt>Redemption deadline block</dt>
                    <dd>
                      {backing.snapshot.melt_deadline_height.toLocaleString(
                        "en-US",
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {funding?.quote && funding.quote.request !== details.invoice && (
                <Payload
                  label="Backing funding invoice"
                  value={funding.quote.request}
                />
              )}
            </div>
          );
        })}
      </section>
      {details.token ? (
        <section
          className="activity-detail-section"
          aria-label="Ecash token details"
        >
          <h3>Ecash token</h3>
          <p className="small muted">
            {row.purpose === "send"
              ? "The token shared with the recipient. Its current availability depends on whether it was received and its backing is still active."
              : row.purpose === "receive"
                ? "The incoming token was exchanged for fresh proofs when it was received."
                : row.purpose === "melt"
                  ? "These ecash inputs were spent to pay the invoice."
                  : "The token issued for this deposit. Later activity may have spent or expired it."}
          </p>
          <Payload
            label={
              row.purpose === "send"
                ? "Outgoing token"
                : row.purpose === "receive"
                  ? "Received token"
                  : row.purpose === "melt"
                    ? "Spent token"
                    : "Issued token"
            }
            value={details.token}
          />
        </section>
      ) : (
        row.purpose !== "expire" && (
          <p className="small muted">
            Ecash token not recorded for this older activity.
          </p>
        )
      )}
      {row.purpose === "expire" && (
        <p className="small muted">
          This time records when the wallet observed expiry, not the exact time
          the backing closed.
        </p>
      )}
    </div>
  );
}
