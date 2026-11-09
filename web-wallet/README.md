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
- **Settings / Cloud backups:** sign in with Google or Apple, then enable
  automatic backups. The wallet checks for changes every five seconds while
  open and saves proofs, backing preimages, pending request secrets, and outgoing
  token history to this wallet service's server. It retries failed saves, shows
  the last successful save, and resumes after reload. Uploads are saved locally
  before sending, so a lost response can be retried after reload without
  blocking newer backups or replacing a newer server copy. Signing in alone does not
  upload funds or overwrite a saved wallet. Sign in with the same provider and
  account on a new browser to find and restore saved wallets.
- **Backup protection:** passphrase encryption is recommended. Keep the
  passphrase for recovery on a new device; social sign-in cannot reset it. The
  browser saves a non-extractable encryption key locally for automatic backups,
  not the passphrase. Alternatively, explicitly choose **No encryption** and
  acknowledge that anyone who can access the backup—including the server
  operator or someone who gets into the account—can read wallet secrets and
  spend funds. This option permits recovery with social sign-in alone.
- **Backup files:** exports and restores encrypted or explicitly acknowledged
  unencrypted files. Existing encrypted backups remain compatible. Restore
  requires an empty wallet in a new browser profile. A snapshot cannot recover
  changes made after its last successful save, and no backups extend token
  deadlines. Use one active copy of a restored wallet to avoid competing spends.
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
cannot be checked, and saved issuance requests replay even after backing closes.
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
```

Build produces a static `dist/` with separate `index.html`,
`how-it-works/index.html`, and `wallet/index.html`
entries, each with a Content Security Policy. Serve the complete directory from
the same origin so the landing page and wallet share browser preferences and
existing IndexedDB funds. The `/wallet/` and `/how-it-works/` entries support direct visits and reloads
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

## Cloud backup setup

Cloud login is opt-in server configuration. It uses Google's and Apple's
OpenID Connect authorization-code flows. Google uses PKCE; both providers use
one-time browser-bound state, a nonce, and verified ID-token signatures,
issuer, audience, and expiry. No identity SDK or third-party script runs in the
wallet. Provider tokens are discarded after sign-in. Sessions last 30 days and
use HTTP-only, Secure, SameSite=Lax cookies in production; Apple's short-lived
login binding cookie uses SameSite=None for its cross-site form POST.

Backups are stored by **this wallet service**, not in Google Drive or iCloud.
Google and Apple authenticate the user. Accounts are keyed by provider and
verified subject, never merged by email. Choosing another provider—even with
the same email—opens a separate backup account.

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a
   project. Open **Google Auth Platform**, complete **Branding** with the wallet
   name, support/contact emails, homepage, and authorized domain, and set
   **Audience** to External for public users. Add your test account while the
   app is in Testing. In **Clients → Create client**, choose **Web application**
   and register `https://YOUR-WALLET/api/cloud/callback/google` as an authorized
   redirect URI. Copy the generated client ID and client secret into the server
   environment. Only `openid email` is requested; no Drive permission is needed.
2. For Apple, configure a primary App ID with Sign in with Apple, a **Services
   ID** for the website, its domain and return URL
   `https://YOUR-WALLET/api/cloud/callback/apple`, and a Sign in with Apple `.p8`
   key. Use an Account Holder or Admin login in
   [Apple Developer](https://developer.apple.com/account/resources/identifiers/list).
   Under **Identifiers**, enable Sign in with Apple on the primary App ID, then
   register a Services ID such as `cash.tmp.wallet.web`. Edit that Services ID,
   enable Sign in with Apple, select the primary App ID, and enter the wallet
   domain and return URL. Under **Keys**, create a Sign in with Apple key linked
   to the same primary App ID and download its `.p8` file. The key page provides
   the Key ID; **Membership details** provides the Team ID. The server generates
   short-lived ES256 client secrets from that key automatically.

   Apple's documentation describes web sign-in as accompanying an existing App
   Store app using Sign in with Apple. If this project is web-only, resolve that
   prerequisite with Apple before the Apple rollout. See
   [Apple's environment requirements](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple).

3. Set the root environment values from [.env.example](../.env.example):
   `TMP_CASH_CLOUD_ORIGIN`, Google client ID/secret, and Apple's Services ID,
   team ID, key ID, and private key file. The origin must exactly match the
   wallet's scheme, hostname, and port, without a path. Either provider can be
   configured on its own. Keep the private key file readable only by the service
   user and retain it outside the repository. Never put secrets in frontend
   build variables. Restart the server after configuration changes.
4. Reverse-proxy **all methods** under `/api/cloud/` from the wallet origin to
   the mint process. Do not expose it as a credentialed cross-origin API. For
   Nginx, add a location to the wallet's HTTPS virtual host (no URI rewrite):

   ```nginx
   location /api/cloud/ {
       proxy_pass http://127.0.0.1:3338;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto $scheme;
       client_max_body_size 32m;
       proxy_read_timeout 60s;
       access_log off;
       add_header Cache-Control no-store always;
       add_header Referrer-Policy no-referrer always;
   }
   ```

   Apply normal per-IP rate limiting to this route and avoid logging callback
   query strings or request/response bodies in proxies or application tracing.
   Allow Apple's `application/x-www-form-urlencoded` callback POST. Keep the
   rest of the existing TLS/security headers on this location. Uvicorn callback
   logs have their authorization-code query removed by the application.

5. Preserve `cloud.sqlite3` alongside the server data, or use
   `TMP_CASH_DATABASE_URL` for the separate `tmp_cash_cloud` PostgreSQL schema.
   SQLite cloud files use mode 0600. Protect database access and server snapshots:
   unencrypted backups contain spendable wallet secrets. Back up this store
   regularly to durable storage off the server as part of the deployment's
   recovery procedure. Each account can save up to ten named wallet copies,
   each limited to 16 MB; saves atomically replace that copy with a revision
   check. A new browser creates a separate copy only after explicit enablement.
   There is no historical version archive. Deleting a cloud copy cannot erase
   snapshots already retained by the operator.

For local Google testing, set `TMP_CASH_CLOUD_ORIGIN=http://127.0.0.1:5173`,
register that exact callback URL, and run the mint on port 3338. Vite development
and preview proxy `/api/cloud` there; override the shell variable
`WALLET_CLOUD_PROXY_TARGET` if using a different local port. Production static
hosting requires the reverse proxy above. Apple requires a registered HTTPS
domain and cannot use this loopback HTTP setup.

Automatic saves require Web Crypto, IndexedDB, and Web Locks. Pausing or signing
out removes this browser's automatic-backup configuration and saved encryption
key; server copies remain until deleted. Browser wallet records themselves are
still stored locally without encryption. With passphrase protection, loss of
both browser data and passphrase makes that cloud copy unrecoverable. With no
passphrase, account compromise or server access can expose funds. Closing the
wallet, an expired sign-in, or a network failure can leave recent changes
unsaved; check the last-save status before relying on a backup.

The disposable browser fixture simulates Google's authorization/token/JWKS
endpoints but uses the production sign-in service, real signed ID tokens,
HTTP-only session cookies, durable backup API, browser key storage, and wallet
cryptography. Python tests cover Google's and Apple's flows, invalid claims,
state replay/expiry, CSRF, account separation, revision conflicts, deletion,
and session revocation. Real-provider acceptance still requires configured
credentials and a manual login with each provider on the target domain.

Provider references: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect),
[Apple Sign in with Apple REST API](https://developer.apple.com/documentation/signinwithapplerestapi).
