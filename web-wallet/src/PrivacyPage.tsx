import { LegalPage } from "./LegalPage";

export function PrivacyPage() {
  return (
    <LegalPage
      page="privacy"
      title="Privacy policy"
      eyebrow="YOUR PRIVACY"
      description="Your wallet lives in your browser. Optional backups go directly to your own cloud account. The mint never receives or stores your Google or Apple account details, sign-in tokens, or wallet backup files."
    >
      <section aria-labelledby="scope-title">
        <h2 id="scope-title">What this policy covers</h2>
        <p>
          This policy describes the tmp.cash website, browser wallet, and mint
          operated at tmp.cash. Sign-in is optional. You can use the wallet
          without a Google or Apple account. If you connect to another mint,
          that operator controls its own service and data practices. See also
          the <a href="/terms/">terms of service</a>.
        </p>
      </section>
      <section aria-labelledby="device-title">
        <h2 id="device-title">Data on your device</h2>
        <p>
          The wallet stores ecash credentials, wallet secrets, invoices, payment
          history, pending operations, and preferences in your browser. Your
          live wallet data is not encrypted by the backup password. Protect
          access to your device and browser profile.
        </p>
        <p>
          Backup settings and a local encryption key are also kept in the
          browser when automatic backups are enabled. The wallet does not send
          your backup password to the mint, Google, or Apple.
        </p>
        <p>
          Diagnostics stay on your device and are not automatically uploaded. If
          you export and share a diagnostic report, its recipient receives the
          report, which can include amounts, invoices, payment hashes, and error
          information. The wallet does not use an analytics or advertising
          service.
        </p>
      </section>
      <section aria-labelledby="google-title">
        <h2 id="google-title">Optional Google Drive backups</h2>
        <p>
          When you choose Google, your browser connects directly to Google for
          sign-in and backup storage. The wallet uses your Google account
          identifier and email address to identify the connected account and
          show which account you are using. An access token and these account
          details are kept in this browser tab’s session storage while the
          sign-in is valid.
        </p>
        <p>
          The wallet requests basic sign-in permissions and access to its own
          hidden application data folder in Google Drive. It can list, save,
          restore, and delete its backup files there. This permission does not
          grant access to your other Drive files. Google account data is used
          only to provide the backup and recovery features you choose, and is
          not sold or used for advertising.
        </p>
        <p>
          Backup files and metadata, including the wallet name, backup
          identifiers, save times, and whether a backup is encrypted, are stored
          by Google in your account. Account details and access tokens are not
          sent to the mint. Google handles its services under the{" "}
          <a href="https://policies.google.com/privacy">
            Google Privacy Policy
          </a>
          .
        </p>
      </section>
      <section aria-labelledby="sync-title">
        <h2 id="sync-title">Optional device synchronization</h2>
        <p>
          Google Drive backups can contain a mergeable synchronization document,
          including saved payment requests and recovery secrets, protected by
          the backup option you choose. Devices connected to the same wallet
          merge these changes through Drive.
        </p>
        <p>
          Without a Google session, enabled device sync uses buzz.cashu.space or
          the relays you select. Wallet data is encrypted and signed in your
          browser. Relays can see your connection address, a dedicated sync
          public key, event sizes, and publication times. Authentication uses
          that sync key, not your Google or Apple credentials. Anyone with your
          private sync code can decrypt and spend the wallet. Pausing sync does
          not revoke that code or guarantee deletion of existing relay copies.
        </p>
      </section>
      <section aria-labelledby="apple-title">
        <h2 id="apple-title">Optional iCloud backups</h2>
        <p>
          Where Apple backup is available, your browser connects directly to
          Apple’s CloudKit service. Apple manages the sign-in session. The
          wallet uses the account identifier and any name Apple provides to
          identify the connected account. Backup files and metadata are stored
          in your private iCloud database. Your Apple account details and
          backups are not sent to the mint. Apple handles its services under the{" "}
          <a href="https://www.apple.com/legal/privacy/">
            Apple Privacy Policy
          </a>
          .
        </p>
      </section>
      <section aria-labelledby="protection-title">
        <h2 id="protection-title">How backups are protected</h2>
        <p>
          With password protection, the wallet encrypts the backup contents in
          your browser before uploading them. The cloud provider still receives
          backup metadata, including the wallet name and save time. Keep your
          backup password safe: your cloud account cannot reset it.
        </p>
        <p>
          If you explicitly choose account-only recovery, the uploaded backup is
          not encrypted by the wallet. Anyone who can read it, including your
          cloud provider or someone with access to your account, can read wallet
          secrets and spend your funds.
        </p>
      </section>
      <section aria-labelledby="mint-title">
        <h2 id="mint-title">What the mint and other services receive</h2>
        <p>
          The mint stores the protocol records needed to issue and redeem ecash
          and prevent double spending. These include Lightning invoices and
          payment hashes, amounts, expiry times, payment states, spent-token
          identifiers, and operation results. Redeeming ecash also reveals the
          secret that unlocks its Lightning backing. These records are separate
          from Google or Apple sign-in; the mint has no cloud account directory
          or wallet backup storage.
        </p>
        <p>
          Website hosting, the mint, and cloud providers receive normal
          connection information such as your IP address, request time, and
          browser information. Hosting and mint infrastructure may retain access
          or error logs. This policy does not promise anonymous network access
          or zero server records.
        </p>
        <p>
          Lightning payment providers process the payment information needed to
          complete deposits and withdrawals. When you pay a Lightning address,
          the address provider also receives the requests needed to obtain an
          invoice. Those services have their own privacy practices.
        </p>
      </section>
      <section aria-labelledby="controls-title">
        <h2 id="controls-title">Your choices and data retention</h2>
        <p>
          You can pause automatic backups, sign out, or delete a saved copy in
          the wallet’s backup settings. Signing out or revoking access does not
          delete existing cloud backups. Deleting one copy does not delete older
          snapshots. You can manage the app’s stored data through your cloud
          provider and revoke Google access through your{" "}
          <a href="https://myaccount.google.com/connections">
            Google Account connections
          </a>
          . Provider retention and deletion policies also apply.
        </p>
        <p>
          Local wallet data stays in your browser until you remove it or your
          browser clears it. Export a backup before clearing site data; clearing
          it can permanently lose access to funds. Downloaded backup and
          diagnostic files remain wherever you save or share them. Clearing
          browser data or deleting a cloud backup does not remove mint payment
          and spent-token records, which can remain necessary to operate the
          protocol.
        </p>
      </section>
      <section aria-labelledby="contact-title">
        <h2 id="contact-title">Questions and changes</h2>
        <p>
          For privacy questions, contact the maintainer through the{" "}
          <a href="https://github.com/a1denvalu3/tmp.cash">
            tmp.cash project on GitHub
          </a>
          . GitHub discussions and issues may be public; do not post wallet
          secrets, account tokens, or private payment details. Updates to this
          policy will appear on this page with a revised date. Changes to how
          Google account data is used will be disclosed before requesting any
          additional access.
        </p>
      </section>
    </LegalPage>
  );
}
