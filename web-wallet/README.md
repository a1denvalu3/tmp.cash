# tmp.cash web wallet

A responsive browser wallet for the PS/BLS12-381 mint in this repository. Modified
cashu-ts handles credentials and wire requests; modified Coco manages proofs,
funding preimages, saved operations, activity, and IndexedDB persistence. The app
does all wallet cryptography in the browser. It works with the mint's fake, LND,
and Spark backends through the same HTTP API.

## Run

Start your configured mint from the repository root, for example:

```sh
poetry run tmp.cash-mint --backend lnd --data data/lnd-v3
```

Use the [root README's Spark configuration](../README.md#spark-with-the-breez-python-sdk) for a
Spark mint. The web wallet needs the mint URL; it does not need Spark operator
configuration, a mint mnemonic, or Lightning node credentials.

In another terminal:

```sh
cd web-wallet
npm ci
npm run dev
```

Open **http://127.0.0.1:5173** for the explainer, then choose **Open wallet**.
The wallet is also available directly at **http://127.0.0.1:5173/wallet/**.
The cryptography explainer is at **http://127.0.0.1:5173/how-it-works/**,
linked from the landing page navigation, diagram, and footer.
The default mint is
**http://127.0.0.1:3338**. Change it in Settings, or set `VITE_DEFAULT_MINT` before
starting/building. Node 22.4+ is required. Fonts and scripts are bundled locally.

The root mint API enables CORS for its public GET/POST endpoints. No private
wallet data is served by the frontend. For a remote deployment, serve `dist/`
over HTTPS and use an HTTPS mint; browsers block mixed-content requests.

## Use

- **Landing page:** explains frozen Lightning deposits and private ecash
  transfers, with an animated Alice–mint–Carol diagram showing what the mint sees
  and what stays hidden. Its alternative deadline scenario expires Alice’s full
  balance before a transfer, or both holders’ balances after a transfer, and
  reverts the deposit to Alice after the Lightning hold times out.
  Expiry is explained above the diagram. Further questions cover redemption and
  mint trust. It opens without connecting to a mint or initializing wallet
  storage. **Open wallet** takes you to the
  wallet; **How tmp.cash works** in the wallet footer returns to the explainer.
- **Cryptography:** a separate article explains the v3 backing attribute,
  denomination signatures, owner proofs and nullifiers, private swaps, Lightning
  melts, expiry, and mint trust. A split/combine example illustrates value and
  backing conservation. Equations and expandable proof details follow the
  implementation, including the difference between initial issuance and blind
  reissuance. It opens without a mint connection or wallet storage.
- **Add sats:** generates and durably saves a backing preimage, requests a HODL
  invoice with its hash, and displays the invoice/QR. Pay from a Lightning wallet.
  Once the payment is held (`ACCEPTED`), the wallet mints denomination proofs.
  The payer's wallet can continue to show a pending payment until settlement.
  The wallet shows only the newest invoice still awaiting payment. **Deposit
  invoice history** opens all invoices for the selected mint, newest first,
  including funded and closed invoices. Select an entry to reopen it. Older
  waiting invoices continue to be checked for payment in the background.
- **Send:** picks one backing with enough value, privately splits its proofs,
  retains change, and saves the outgoing `cashuPS` token in Activity. Its preimage
  travels with the token. Sent proofs are excluded from the balance.
- **Receive:** recognizes pasted tokens immediately, previews their amount, and
  enables **Receive token** for a correctly encoded token from the selected mint.
  Empty or malformed input keeps receiving disabled. Tokens from another mint
  show which mint to select. Receiving checks the signature, mint, backing,
  deadline, and nullifiers, then swaps into fresh owner secrets. If any backing
  has less than 20 minutes until its redemption deadline, the wallet asks for confirmation before saving
  or swapping the token. Block-based deadlines use an estimate of 10 minutes per
  remaining block, with a reminder that actual block times vary. Canceling leaves
  the token untouched. Mixed bundles are refreshed with a
  separate swap per backing. All backing proofs and prepared requests are saved
  together before the first swap, so every part remains recoverable if a response
  is lost or the tab closes. Tokens from another mint require explicitly
  connecting to that mint first. A backing without a preimage offers an
  **Add backing preimage** action.
- **Pay with Lightning:** paste an invoice, Lightning address (`name@example.com`),
  or LNURL-pay link, scan its QR code with your camera,
  or upload a QR image. Camera scanning requires HTTPS or localhost and camera
  permission. Plain invoices and `lightning:` QR payloads are supported, including
  uppercase invoices and LNURLs. Addresses automatically look up their
  [LNURL-pay endpoint](https://github.com/lnurl/luds/blob/luds/16.md); encoded
  `LNURL1…`, HTTPS payment links, and `lnurlp://` links are also supported.
  Choose an amount within the service's limits (fixed amounts are filled in),
  then **Review payment** fetches and validates the invoice before requesting
  the mint's fee quote. The invoice must match the chosen amount and any
  description-hash commitment to the service's metadata, and must not be expired.
  LNURL services must allow browser requests through CORS; lookup and invoice
  errors can be retried without spending ecash. Services requiring payer identity
  are not supported. Scanning fills the payment field; choose **Review payment**
  to check the amount and fees before confirming. The wallet verifies the signed
  BOLT11 invoice, requests the mint's fee quote, and shows its amount and the
  mint's fee reserve. The wallet reserves
  enough ecash for that quote and combines eligible backings when necessary. Each melt
  reveals the complete preimage of every backing used. Change stays tied to its
  original backing; expired change is shown in the payment receipt.
  An explicit pending response triggers bounded automatic checks of the exact
  saved request. If completion takes longer, the payment stays in Pending
  operations with its inputs reserved and a Retry action; it is shown as pending.
- **Appearance:** use the header’s sun/moon button to switch modes, or choose
  Light, Night, or System in Settings. The preference is saved in this browser;
  System follows your device’s color scheme.
- **Activity details:** click an entry in recent activity or the Activity tab,
  or focus it and press Enter, to open its receipt. It shows the amount, status,
  full start/completion times, mint, invoice and quote ID when applicable,
  backing hashes and amounts, recorded redemption deadlines, and the associated
  ecash token. Outgoing Lightning payments include fees, change, the payout hash,
  and the mint-returned payment preimage; the wallet verifies that the preimage
  hashes to the invoice's payment hash. Invoices, tokens, IDs, hashes, and the
  preimage have individual copy controls.
  New history details survive reloads, offline use, saved-request retries, and
  encrypted backups. Historical tokens may already be spent or expired; incoming
  tokens were exchanged for fresh proofs. Older entries remain readable and
  clearly indicate details that were not recorded.
- **Wallet backup:** the wallet offers a guided sign-in and backup pop-up.
  Sign in with Google or Apple, then choose your backup protection. The wallet checks for changes every five seconds while
  open and saves proofs, backing preimages, pending request secrets, and outgoing
  token history directly to your Google Drive or private iCloud storage. It retries failed saves, shows
  the last successful save, and resumes after reload. Uploads are saved locally
  before sending, so a lost response can be retried after reload without
  blocking newer backups or replacing a newer server copy. Signing in alone does not
  upload funds or overwrite a saved wallet. Sign in with the same provider and
  account on a new browser to find and restore saved wallets.
- **Backup protection:** passphrase encryption is recommended. Keep the
  passphrase for recovery on a new device; social sign-in cannot reset it. The
  browser saves a non-extractable encryption key locally for automatic backups,
  not the passphrase. Alternatively, explicitly choose **No encryption** and
  acknowledge that anyone who can access the backup—including the cloud
  storage provider or someone who gets into the account—can read wallet secrets and
  spend funds. This option permits recovery with social sign-in alone.
- **Backup files:** exports and restores encrypted or explicitly acknowledged
  unencrypted files. Existing encrypted backups remain compatible. Restore
  requires an empty wallet in a new browser profile. A snapshot cannot recover
  changes made after its last successful save, and no backups extend token
  deadlines. Without device sync, use one active copy of a restored wallet to avoid competing spends.
- **Debug logs:** in Settings, choose **Copy debug logs** and paste the report
  into your support chat, or choose **Download logs** to share a JSON file.
  A selectable report appears if clipboard access is unavailable. Logs also
  remain accessible from the recovery screen if the wallet UI crashes.

Diagnostics run locally with no automatic upload or analytics service. The
report includes the wallet version, Git revision, build time, browser family
and major version, browser capabilities, action outcomes, HTTP status codes,
request timings, error categories, Lightning invoices, quote IDs, and balance
changes (including reserved, redeemable, sent, and expired amounts, plus whether
the balance is verified). It keeps up to 200 events from the past 24 hours,
bounded to 150 KB, across reloads, with an in-memory fallback when browser storage
is blocked or full. **Clear logs** removes the diagnostic history; it does not
change wallet data. Export logs soon after a problem, before newer events
replace it.

Diagnostic fields and error messages use explicit allowlists. Reports omit
tokens, proofs, preimages, credentials, passwords, operation IDs, mint URLs,
full request/response bodies, and arbitrary error text. Invoice and quote fields
are selected explicitly; no proof or request object is copied into the logs.
Quote lookup paths replace their ID with `:id` and record the quote ID in its
own field; stack locations retain only bundle labels and numeric positions. Browser session IDs
are randomly generated for diagnostics and have no connection to wallet funds.
Logs are separate from encrypted wallet backups and cannot restore funds.

The wallet verifies credentials and refreshes backing and nullifier status.
Expired, settled, canceled, sent, reserved, or remotely pending proofs are
excluded from the available balance. An unavailable mint produces an unverified
balance. Nothing becomes a claim against a mint balance after HTLC settlement.
Backups do not extend deadlines.

Expired backings remain visible below active backings and in Activity, with the
amount held separately from tokens already shared. Their observation time is
saved on the proofs and included in encrypted backups; it records when this
wallet detected expiry, not the exact settlement or deadline time. These local
records remain visible offline. Existing expired records acquire an observation
time on the next successful status check. If verification later recovers a live
claim, its expired entry disappears along with the incorrect expired status.

Background status checks use the same wallet lock as minting and spending, so
a snapshot taken before issuance cannot expire the newly stored outputs. Reloading
also rechecks proofs previously marked expired: a live backing, valid credential,
and an unspent nullifier are required before restoring spendable value. Outgoing
tokens stay excluded from the balance, and closed backing stays unusable.
Slow background refreshes share one pending request instead of filling the
operation queue. Funding polling continues with other deposits if one quote
cannot be checked. Unpaid invoices past their saved expiry appear as **Expired**
in deposit history and are never polled, including after reload or while offline.
Accepted payments keep their separate backing deadline, and saved issuance
requests replay even after backing closes.
That replay recovers records; it does not make genuinely expired tokens spendable.

Operations save secrets and the **exact request before any spending POST**.
Retries after a timeout or reload replay that request. Paying the same invoice
again while an operation is pending reuses its saved request. A timeout or
uncertain failure keeps its input reservations. A definite payout failure or
duplicate-request rejection releases them only after the mint confirms every
input is unspent. Pending operations appear with a
Retry button. Browser Web Locks coordinate tabs; IndexedDB transactions also
prevent duplicate reservations. Clearing browser data without a current backup
loses the wallet. Serve this origin only with code you trust: live wallet data
is stored in IndexedDB, and backup encryption does not encrypt that database.

These are experimental `cashuPS` tokens, incompatible with standard Cashu token
formats. Backing status depends on the mint/backend's reported snapshot; see the
root README for the Breez SDK's cached-status limitation.

The wallet checks only its known backing hashes through `POST /v1/htlcs/check`,
including tokens being received. Requests contain at most 100 distinct hashes;
larger wallets use multiple batches. Checks disclose those hashes to the mint,
and a batch can associate several backings with one wallet. No preimages are
sent for a backing check. Update the frontend together with the mint: the old
unfiltered `/v1/htlcs/pending` endpoint is no longer available.

## Build and verify

```sh
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run test:e2e:production
npm run test:e2e:cloud:production
```

Build produces a static `dist/` with separate `index.html`,
`how-it-works/index.html`, `privacy/index.html`, `terms/index.html`, and
`wallet/index.html`
entries, each with a Content Security Policy. Serve the complete directory from
the same origin so the landing page and wallet share browser preferences and
existing IndexedDB funds. The `/wallet/`, `/how-it-works/`, `/privacy/`, and `/terms/` entries support direct visits and reloads
without requiring a server-side SPA fallback. `npm test` runs
cross-language integration tests against a disposable Python mint, including
private swaps, combined melts, fee change, deadlines, double-spend reservations,
lost quote/issuance/swap/melt responses, and authenticated backup encryption.
Playwright tests the actual desktop/mobile app, cross-origin mint requests,
two wallets, reload/retry, payout, expiry, and offline behavior. Browser tests
start their own disposable mint on port 3339 and frontend on port 5173. They use
fake sats and do not touch `~/cashu-regtest` or an existing mint database.

The modified libraries are source workspaces under `packages/`; no globally
installed packages or sibling checkouts are required. See
[PROVENANCE.md](PROVENANCE.md) for exact upstream revisions and changes.

## Public policy pages

The privacy policy at `/privacy/` and terms of service at `/terms/` are public
pages linked from the website and wallet footer. They share the site's theme
and work on direct visits and reloads. Serve the full `dist/` directory so both
entries and their assets are published.

The production policy URLs are `https://tmp.cash/privacy/` and
`https://tmp.cash/terms/`.

## Cloud backup setup

Account sign-in and backup storage run entirely in the browser. The mint has no
account endpoints, cookies, OAuth configuration, identity database, or backup
storage. Google backups go directly to the user's Drive app-data folder; Apple
backups go directly to that user's private iCloud CloudKit database. Account
identifiers, cloud access tokens, and backup payloads are never sent to the mint.
The mint receives only the existing ecash protocol requests.

On first opening the wallet, a short pop-up explains recovery and invites the
user to sign in. **Not now** dismisses it without blocking the wallet. The header
keeps a **Back up wallet** button for returning to setup. After sign-in, the
wallet offers an existing saved wallet to restore, or guides the user through
adding a backup password or explicitly choosing account-only recovery. Setup is
complete only after the first upload succeeds. Settings contains backup status
and management rather than the initial setup form.

### Google

1. In Google Cloud Console, use an OAuth client of type **Web application**.
   Configure Branding and Audience; add your test users while the app is in
   Testing. Enable the **Google Drive API** in that same project.
2. Add the wallet origin under **Authorized JavaScript origins**:
   `http://127.0.0.1:5173` locally, or `https://tmp.cash` in production. This uses
   Google's token popup flow, so `/api/cloud/callback/google` is no longer used.
   Only `openid`, `email`, and `https://www.googleapis.com/auth/drive.appdata`
   are requested. The app-data scope does not grant access to other Drive files.
3. Put the public client ID in `web-wallet/.env.local`:

   ```dotenv
   VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   VITE_DEFAULT_MINT=http://127.0.0.1:3338
   ```

   There is no OAuth client secret in the frontend or mint. Do not copy a client
   secret or service-account key into any `VITE_` variable.

4. Restart Vite after changing frontend environment values. Production builds
   need rebuilding to pick up the public client ID. If the host sets a
   Cross-Origin-Opener-Policy, use `same-origin-allow-popups` so Google's sign-in
   popup can complete. Keep the generated Content Security Policy, which allows
   the official Google and Apple SDKs and authentication frames.

Google access tokens stay in this browser tab's session storage and expire.
A reload in the same session can resume automatic saves. After token expiry or
opening a new browser session, the wallet offers **Reconnect Google**. Google
requires a user interaction to issue a new token; the wallet does not claim to
save unattended while signed out. Tokens and identity details are excluded from
mint requests and wallet diagnostics.

### Apple

Configure an iCloud container in Apple CloudKit Console and create a **web API
token** restricted to the wallet's allowed origins. Set these public frontend
values; do not use a server-to-server key:

```dotenv
VITE_APPLE_CLOUDKIT_CONTAINER=iCloud.your.container
VITE_APPLE_CLOUDKIT_API_TOKEN=your-web-api-token
VITE_APPLE_CLOUDKIT_ENVIRONMENT=development
```

CloudKit JS supplies Apple's sign-in button and manages its account session.
All reads and writes use `privateCloudDatabase`. Set up these record types in
CloudKit development, then deploy the schema before using `production`:

- `TmpCashBackup`: `walletId` and `name` (String), `created`, `encrypted`, and
  `chunks` (Int64). Enable querying this record type.
- `TmpCashBackupChunk`: `data` (String).

Backup contents are split into small chunk records; the manifest is written
last. Partial uploads never appear in the restore picker. The Google and Apple
choices appear only when the respective frontend configuration exists. Google
and Apple keep separate recovery copies even when their accounts share an email.

### Protection and recovery

Password protection is recommended. The browser saves a non-extractable key in
IndexedDB so automatic encryption continues without retyping the password.
Recovery on a new device still requires the password; the cloud account cannot
reset it. Account-only recovery requires an explicit warning and checkbox:
anyone able to read the backup, including the storage provider or someone who
gets into the cloud account, can read wallet secrets and spend funds. Empty
passwords never silently select account-only recovery.

Changes are checked every five seconds while the wallet is open. Each upload
creates an immutable recovery copy in the user's cloud storage. Upload IDs and
the pending payload are persisted before sending, so retrying a lost response
can find an already accepted snapshot. Delayed uploads cannot overwrite newer
copies. Recovery lists the latest copy for each saved wallet. Copies consume the
user's cloud quota and remain until deleted; there is no automatic pruning.
Google listings are bounded to the newest 1,000 files and Apple to 200 manifests.

Restore requires an empty local wallet and validates the complete wallet state.
Recovery rechecks the newest saved copy for the chosen wallet before downloading
it. Users can also explicitly choose an earlier saved copy; that selection is
preserved instead of silently substituting the newest one. Empty copies report
an error, confirm successful password decryption when applicable, and expose the
saved history. Known empty copies are marked and disabled in the picker. All
discovered wallets remain available rather than truncating the picker to ten.
Recovery never reports success or creates another restored wallet from an empty
copy.
It includes proofs, backing preimages, pending requests, funding recovery data,
and activity. A successful restore enables continued automatic backups using the
same protection choice. Use one active copy to avoid competing spends. Backups
do not extend token deadlines and cannot recover changes made after the most
recent successful save. Browser wallet data remains locally unencrypted.

### Local testing

Use Python 3.12 for the existing mint dependencies:

```sh
poetry env use python3.12
poetry install
poetry run tmp.cash-mint --backend fake --data data/local-google --fake-auto-accept
```

In another terminal, run `npm run dev` from `web-wallet` and open
`http://127.0.0.1:5173/wallet/`. Only frontend configuration is needed for Google;
there is no cloud route to proxy and no mint account configuration.

The dedicated browser tests simulate only the provider SDKs and cloud APIs;
the wallet UI, encryption, IndexedDB, mint protocol, and recovery run normally.
They assert that no account or backup request goes to the mint. Real-provider
acceptance needs the configured JavaScript origins, enabled APIs, and consent
in the user's browser.

References: [Google token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model),
[Drive app data](https://developers.google.com/workspace/drive/api/guides/appdata),
[CloudKit JS](https://developer.apple.com/documentation/cloudkitjs).

## Device synchronization

Google Drive backups now contain a Yjs document alongside the recoverable wallet state.
After the user enables Google backups, the wallet merges unseen documents from the same
wallet's backup files before saving. Restoring the current CRDT backup preserves its wallet identity,
password-derived key/salt, and sync group, so two active installations can synchronize
through the same Google account. Sign-in alone still does not enable uploads. Deliberately restoring an earlier copy or
an older snapshot format creates a separate Drive backup lineage.
An expired/revoked Google token requires reconnection; a Drive error does not silently
switch providers. When Google is disconnected, configured device sync uses Nostr.
iCloud remains a snapshot-backup provider rather than a synchronization provider.

Without a Google session, Settings → **Sync your devices** offers encrypted Nostr sync,
using `wss://buzz.cashu.space` by default. The relay requires NIP-42 authentication;
the wallet signs challenges with a dedicated sync key and retries rejected reads/writes
after authentication. Other `wss://` relays can be selected; insecure `ws://` is accepted
only for localhost testing. Authentication does not override a relay's access policy.
Create a private sync code on the original device and enter it in an empty wallet on
another device under **Connect to an existing wallet**. If you accidentally enabled
sync on the empty receiving wallet first, choose **Back to sync setup**, then enter
the original wallet's code. Returning to setup clears only unused sync configuration;
wallets with funds, history, or recovery records keep their current membership.
Anyone with this code can decrypt and spend the wallet. The code is not
put in a URL, sent to the mint, or included in diagnostic reports.

The wallet keeps its existing prepare/reserve/execute/finalize operation manager.
Financial state changes and immutable recovery fragments commit in the same IndexedDB
transaction. Yjs merges these fragments; mint-confirmed completions determine which
competing attempts succeeded. Remote CRDT updates never automatically execute a new
payment. Unresolved operations remain available through Pending operations → Retry,
including exact-request recovery on another device. Outgoing tokens remain excluded
while unclaimed, and old checkpoints cannot restore confirmed spent inputs.

When synchronization is enabled, the complete prepared operation must reach the active
storage provider before a spending POST. A provider failure retains the local request
and reservations for an explicit retry. Pausing Nostr sync allows operations without
remote confirmation; it does not revoke other devices or erase existing copies.
Each independent installation gets a fresh checkpoint-writer identity. Token output
secrets remain random; no shared derivation counter is introduced.

Nostr checkpoints use NIP-44 encrypted chunks and manifests, all kind 30078 and signed
with the sync key. Each chunk gets a unique `d` address so that later uploads do not
replace data referenced by earlier checkpoints. Each device replaces only its own
manifest; devices query manifests separately from chunks and merge every writer's
checkpoint. One relay must acknowledge every chunk before its manifest.
Lost acknowledgments retry the persisted packet. Older kind 78 checkpoints remain
readable, and queued legacy uploads are converted locally before retrying. Update all
devices: older wallet versions cannot read the new version 2 manifests.
Incomplete or invalid checkpoints never replace local wallet state. When every relay
fails, the wallet includes each relay's rejection reason in the sync error.
Relay acceptance is subject to the relay's retention policy; it is not an independent
durability guarantee.

Drive retains the current and previous CRDT backup per writer, deleting older copies
only after a successor upload succeeds. Older legacy snapshots stay available for
explicit restore. The CRDT retains recovery facts and spent/completion markers;
encoding a checkpoint does not discard logical history. Checkpoints/backups have
explicit size limits and stop further synchronized operations rather than silently
truncate data. Garbage collection of those markers and relay-side deletion are not
implemented. Keep an independent backup.

Synchronization is eventual: devices may briefly show different balances and a
competing operation can be rejected by the mint. This does not provide Firestore-style
linearizable reads. Backing settlement and token deadlines still apply.
