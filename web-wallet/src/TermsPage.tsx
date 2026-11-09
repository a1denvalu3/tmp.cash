import { LegalPage } from "./LegalPage";

export function TermsPage() {
  return (
    <LegalPage
      page="terms"
      title="Terms of service"
      eyebrow="USING TMP.CASH"
      description="tmp.cash is experimental software for temporary ecash. Using it involves a risk of losing funds. Understand the redemption deadlines, protect your wallet, and choose a mint you trust."
    >
      <section aria-labelledby="terms-scope-title">
        <h2 id="terms-scope-title">Using the service</h2>
        <p>
          These terms govern the tmp.cash website, browser wallet, and mint
          operated at tmp.cash. Use these services only if you understand and
          accept these terms and can lawfully enter into this agreement. You are
          responsible for using the service in accordance with the laws that
          apply to you.
        </p>
        <p>
          If you connect the wallet to another mint, that operator’s terms also
          apply to its service. The tmp.cash project does not control
          independently operated mints.
        </p>
      </section>
      <section aria-labelledby="terms-experiment-title">
        <h2 id="terms-experiment-title">
          Experimental software and mint trust
        </h2>
        <p>
          tmp.cash is an experimental protocol and implementation. Software
          errors, compromised devices, service interruptions, payment failures,
          or a mint’s actions can cause permanent loss of funds. Successful use
          in the past does not guarantee future availability or successful
          redemption.
        </p>
        <p>
          Your browser holds the wallet secrets. The mint handles Lightning
          backing payments and redemption, so the protocol also depends on the
          mint’s availability, liquidity, and behavior. The wallet does not
          eliminate the need to trust the mint. See{" "}
          <a href="/how-it-works/?view=cryptography#trust">
            the explanation of expiry, privacy, and trust
          </a>
          .
        </p>
      </section>
      <section aria-labelledby="terms-expiry-title">
        <h2 id="terms-expiry-title">Ecash expires with its backing</h2>
        <p>
          tmp.cash tokens are temporary. Redeem them before the deadline shown
          in the wallet. Settlement, cancellation, or timeout of the underlying
          Lightning backing ends the protocol’s redemption claim. Sending tokens
          to another person or restoring a backup does not extend that deadline.
          The protocol provides no remaining balance to redeem after the backing
          closes.
        </p>
        <p>
          Redemption reveals the secret that allows the mint to collect the
          entire backing payment, even if other people still hold tokens from
          it. Delaying settlement of a partly used backing until the published
          cutoff is mint policy; it is not cryptographically enforced. The mint
          can technically settle earlier once that secret has been revealed.
        </p>
      </section>
      <section aria-labelledby="terms-wallet-title">
        <h2 id="terms-wallet-title">Your wallet and payment instructions</h2>
        <p>
          You are responsible for protecting your device, browser profile,
          wallet secrets, backup files, and backup passwords. Anyone who obtains
          the necessary secrets can spend the corresponding funds. Clearing
          browser storage without a usable backup can permanently remove access
          to your wallet. The project cannot recreate lost wallet secrets or
          reset an encrypted backup’s password.
        </p>
        <p>
          Check the recipient, invoice, amount, fees, and redemption deadline
          before confirming a payment or sharing a token. Completed Lightning
          payments and tokens already spent by a recipient generally cannot be
          reversed through the wallet. An uncertain payment result is not proof
          of failure; follow the wallet’s pending-payment recovery instructions
          before attempting another payment.
        </p>
      </section>
      <section aria-labelledby="terms-backup-title">
        <h2 id="terms-backup-title">Optional sign-in and cloud backups</h2>
        <p>
          Google and Apple sign-in are optional wallet backup features. Account
          details, sign-in tokens, and backup files go directly between your
          browser and the chosen provider, and are not sent to or stored by the
          mint. The provider’s own terms, availability, account restrictions,
          and storage limits also apply.
        </p>
        <p>
          Signing in finds existing saved wallets; restoring one requires
          selecting it and confirming restoration into an empty local wallet.
          Password-protected backups also require the backup password. If you
          explicitly choose account-only recovery, anyone able to read the
          backup can read wallet secrets and spend funds.
        </p>
        <p>
          Automatic saves run while the wallet is open and connected, with valid
          provider access. A backup can recover only the state that was
          successfully saved. It cannot recover later changes or make expired or
          spent tokens usable. Use one active copy of a restored wallet to avoid
          competing payments from the same funds.
        </p>
      </section>
      <section aria-labelledby="terms-fees-title">
        <h2 id="terms-fees-title">Fees and other services</h2>
        <p>
          Lightning routing fees may apply. Review the quoted amount and fee
          reserve shown before confirming a payment. The mint charges actual
          routing fees rounded up to whole satoshis and returns unused fee
          reserve as ecash when the payment completes under the protocol.
          Returned ecash keeps its backing’s original deadline.
        </p>
        <p>
          Lightning networks, address providers, independently operated mints,
          Google Drive, and Apple iCloud are separate services. Their operators
          control their own terms and operations. tmp.cash cannot guarantee
          their availability or resolve every failure in those services.
        </p>
      </section>
      <section aria-labelledby="terms-use-title">
        <h2 id="terms-use-title">Acceptable use</h2>
        <p>
          Do not use the hosted service for unlawful activity, to steal funds or
          credentials, to gain unauthorized access, or to disrupt other users or
          infrastructure. Respect reasonable service limits. These terms do not
          prohibit lawful security research or use of the source code under its
          applicable licenses.
        </p>
      </section>
      <section aria-labelledby="terms-availability-title">
        <h2 id="terms-availability-title">Availability and changes</h2>
        <p>
          Features may change, and maintenance, failures, or security incidents
          may interrupt access. Continuous hosting, cloud access, and
          uninterrupted mint operation are not guaranteed. Keep a current backup
          and allow time for redemption before your tokens expire.
        </p>
        <p>
          Changes to these terms will be published on this page with a revised
          date and apply to future use. Material changes will be identified on
          the site. Nothing in these terms permits changes to the protocol
          rights of an existing token retroactively or removes rights that
          applicable law protects.
        </p>
      </section>
      <section aria-labelledby="terms-responsibility-title">
        <h2 id="terms-responsibility-title">Warranties and responsibility</h2>
        <p>
          To the extent permitted by applicable law, the service is provided “as
          is” and “as available,” without warranties of uninterrupted operation,
          fitness for a particular purpose, or error-free recovery. Technical
          explanations describe the intended protocol; they are not a guarantee
          against software bugs or a dishonest mint.
        </p>
        <p>
          Nothing in these terms excludes or limits liability that cannot
          lawfully be excluded or limited, including liability for fraud, or
          takes away mandatory consumer rights. Applicable law governs the
          responsibility of the operator and contributors for any claim.
        </p>
      </section>
      <section aria-labelledby="terms-privacy-title">
        <h2 id="terms-privacy-title">Privacy, source code, and contact</h2>
        <p>
          The <a href="/privacy/">privacy policy</a> explains local wallet
          storage, direct cloud backups, and the mint’s necessary payment and
          spent-token records. The mint does not maintain Google or Apple
          account profiles or store wallet backups.
        </p>
        <p>
          Source code remains subject to its published open source licenses;
          these service terms do not replace those licenses. For questions,
          contact the maintainer through the{" "}
          <a href="https://github.com/a1denvalu3/tmp.cash">
            tmp.cash project on GitHub
          </a>
          . Issues and discussions may be public. Do not post wallet secrets,
          sign-in tokens, backup passwords, or private payment information.
        </p>
      </section>
    </LegalPage>
  );
}
