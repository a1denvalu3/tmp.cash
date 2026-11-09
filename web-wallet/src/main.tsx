import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/dm-mono/400.css";
import "./style.css";
import "./theme";
import { startWalletDiagnostics } from "./diagnostics";
import { WalletErrorBoundary } from "./WalletErrorBoundary";

const Wallet = lazy(() =>
  import("./App").then(({ App }) => ({ default: App })),
);
const Landing = lazy(() =>
  import("./LandingPage").then(({ LandingPage }) => ({ default: LandingPage })),
);
const Cryptography = lazy(() =>
  import("./CryptographyPage").then(({ CryptographyPage }) => ({
    default: CryptographyPage,
  })),
);
const Privacy = lazy(() =>
  import("./PrivacyPage").then(({ PrivacyPage }) => ({
    default: PrivacyPage,
  })),
);
const Terms = lazy(() =>
  import("./TermsPage").then(({ TermsPage }) => ({ default: TermsPage })),
);
const root = document.getElementById("root")!;
const isWallet = root.dataset.page === "wallet";
const isCryptography = root.dataset.page === "cryptography";
const isPrivacy = root.dataset.page === "privacy";
const isTerms = root.dataset.page === "terms";
if (isWallet) startWalletDiagnostics();

// Some static hosts serve the landing entry before normalizing a directory URL.
if (
  ["/wallet", "/how-it-works", "/privacy", "/terms"].includes(
    window.location.pathname,
  )
) {
  window.location.replace(
    `${window.location.pathname}/${window.location.search}${window.location.hash}`,
  );
} else {
  createRoot(root).render(
    <React.StrictMode>
      <Suspense
        fallback={
          <p className="page-loading" role="status">
            Opening tmp.cash…
          </p>
        }
      >
        {isWallet ? (
          <WalletErrorBoundary>
            <Wallet />
          </WalletErrorBoundary>
        ) : isCryptography ? (
          <Cryptography />
        ) : isPrivacy ? (
          <Privacy />
        ) : isTerms ? (
          <Terms />
        ) : (
          <Landing />
        )}
      </Suspense>
    </React.StrictMode>,
  );
}
