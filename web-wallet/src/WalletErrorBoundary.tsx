import { Component, type ReactNode } from "react";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { diagnosticError, walletDiagnostics } from "./diagnostics";

export class WalletErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    walletDiagnostics.record("wallet.crashed", diagnosticError(error));
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-shell">
        <h1>The wallet could not open.</h1>
        <p>Copy the debug logs to help investigate, then reload the wallet.</p>
        <button
          className="button secondary"
          onClick={() => window.location.reload()}
        >
          Reload wallet
        </button>
        <DiagnosticsPanel />
      </main>
    );
  }
}
