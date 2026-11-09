# Shared Google wallet coordination

This optional integration builds on [Google login and recovery](google-recovery.md).
It uses Firebase Authentication and Cloud Firestore on the Spark plan. No custom
backend, Cloud Run service, or billing account is required.

## Setup

1. Complete the Google login configuration in `google-recovery.md`.
2. In the same Firebase project, create the **default Cloud Firestore database**
   using **Standard edition**, Native mode, and production rules. Choose its
   region before storing live data. The default database is the one eligible for
   Firestore's no-cost quota.
3. From `web-wallet`, sign in to the Firebase CLI and deploy the provided rules:

   ```sh
   npx firebase-tools@15.35.0 login
   npx firebase-tools@15.35.0 deploy --only firestore:rules --project YOUR_PROJECT_ID
   ```

   Review `web-wallet/firestore.rules` before deployment. These rules allow only
   the authenticated owner to access their wallet. They also require increasing
   revisions, immutable protection settings, and matching snapshot chunks.
   Other database paths remain denied; extend the rules deliberately if this
   project also serves another application.
4. Set `VITE_FIREBASE_SYNC_ENABLED=true` in `web-wallet/.env.local`, alongside
   the four public Firebase Web app values, and rebuild/publish the frontend.
5. In Settings, select **Use Google wallet**. Create the shared wallet with an
   explicit protection choice, or unlock an existing wallet with its passphrase.
   The same Google account and passphrase open it on another device.

The shared wallet starts empty. Existing local wallets remain separate; transfer
funds with Send and Receive. The app does not copy local bearer credentials into
a second active wallet. The balance labels identify Local wallet and Google
wallet. **Use local wallet** switches back without deleting the shared wallet.

## Coordination model

Each account has one wallet manifest and a bounded set of snapshot chunks.
Firestore transactions atomically read the current snapshot, apply one wallet
mutation, and commit the next revision. Concurrent edits retry against fresh
state. A reservation and its exact prepared request, output secrets, and backing
preimages are committed before the wallet sends a spending request to the mint.

Reservations do not expire on a timer. A suspended or closed device leaves a
recoverable operation, which another device can retry using the same request.
Concurrent successful retries finalize once. Uncertain results retain the
journal. Shared wallets conservatively retain reservations for nonterminal
rejections; definite terminal outcomes can release them after the mint's proof
checks. Stale backing/proof observations cannot overwrite newer proof records.

The mint remains responsible for atomically preventing double spending and
returning durable receipts for identical retries. Shared coordination assumes
participating clients use this repository; copying credentials into independent
wallet software does not create a global lock over those copies.

The passphrase mode encrypts the entire snapshot using the recovery format from
the first integration. Keys stay in memory. Plaintext mode is explicitly selected
and stores wallet secrets without application encryption. Google sign-in gates
database access in both modes. Changing a shared wallet's protection settings is
not implemented; existing settings are enforced across sessions.

The browser caches the decoded shared wallet in memory. Before each wallet
operation it synchronizes with Firestore; each mutation independently checks the
latest state in a transaction. After a reload or Google sign-out, the shared
wallet remains locked until the account is authenticated and any passphrase is
provided. Network or quota failures prevent new shared spending before submission;
they do not silently fall back to an independent local copy.

Snapshots are split into ASCII chunks of at most 500,000 characters, with at most
16 chunks per revision. This bounds Firestore document and transaction sizes.
The app rejects a larger cloud snapshot; export remains available. A saved pending
journal remains recoverable if finalization needs to be retried. Background
synchronization runs every 15 seconds while the wallet is open and uses reads;
unchanged proof observations do not write another snapshot. The actual quota
usage depends on wallet size, active devices, and operations.

Google Drive continues to hold secondary recovery copies. Drive uploads do not
replace the transactional Firestore reservation step. Importing a recovery copy
is allowed only into an empty destination wallet.

## Verification

Run in `web-wallet`:

```sh
npm test
npm run test:sync
npm run test:sync:browser
npm run build
```

`test:sync` downloads/runs the pinned Firebase CLI and starts the Firestore
emulator with a demo project, using the installed Java runtime. It does not
contact or mutate a live Firebase database. Tests connect independent client
instances to the actual emulator and a disposable Python mint. They cover
competing spends/receives, lost responses, concurrent recovery, failed commits,
batch rollback, stale observations, fee-change recovery, account isolation,
revision/protection rules, and snapshot chunking.

`test:sync:browser` also starts the Authentication emulator and runs independent
desktop/mobile browser profiles through the wallet UI. Google's OAuth popup is
replaced by an emulator sign-in; database authorization and transactions remain
real. The test verifies competing spends and locking after sign-out/reload.

Live Google authorization and production Firestore still need the project setup
above. Keep Spark initially; the same project can later upgrade to Blaze without
changing this wallet protocol.

References: [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions),
[quotas](https://firebase.google.com/docs/firestore/quotas),
[security rules](https://firebase.google.com/docs/firestore/security/get-started).
