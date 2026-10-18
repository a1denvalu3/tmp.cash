import { useState } from "react";
import { Copy, Download, Trash2 } from "lucide-react";
import { walletDiagnostics } from "./diagnostics";

export function DiagnosticsPanel() {
  const [report, setReport] = useState("");
  const [status, setStatus] = useState("");
  function snapshot() {
    const text = walletDiagnostics.report();
    setReport(text);
    return text;
  }
  return (
    <section className="settings-card diagnostics-card">
      <h2>Debug logs</h2>
      <p className="muted">
        Having trouble? Copy these logs and paste them into your support chat.
        Recent actions and errors stay in this browser for up to 24 hours, with
        a limit of 200 entries. Nothing is uploaded automatically.
      </p>
      <p className="muted">
        Logs include invoices, balances, and quote IDs. Tokens, preimages,
        passwords, and wallet backups are excluded.
      </p>
      <button
        type="button"
        className="button dark"
        onClick={async () => {
          const text = snapshot();
          try {
            await navigator.clipboard.writeText(text);
            setStatus("Debug logs copied. Paste them into your support chat.");
          } catch {
            setStatus("Select and copy the debug logs below.");
          }
        }}
      >
        <Copy size={17} /> Copy debug logs
      </button>
      <button
        type="button"
        className="button secondary"
        onClick={() => {
          const text = snapshot();
          try {
            const url = URL.createObjectURL(
              new Blob([text], { type: "application/json" }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = `tmp.cash-debug-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setStatus("Debug logs downloaded.");
          } catch {
            setStatus("Select and copy the debug logs below.");
          }
        }}
      >
        <Download size={17} /> Download logs
      </button>
      <button
        type="button"
        className="button secondary"
        onClick={() => {
          walletDiagnostics.clear();
          setReport("");
          setStatus("Debug logs cleared.");
        }}
      >
        <Trash2 size={17} /> Clear logs
      </button>
      {status && (
        <p role="status" className="small">
          {status}
        </p>
      )}
      {report && (
        <>
          <label htmlFor="debug-report">Debug report</label>
          <textarea
            id="debug-report"
            className="mono"
            readOnly
            rows={10}
            spellCheck={false}
            value={report}
            onFocus={(event) => event.currentTarget.select()}
          />
        </>
      )}
    </section>
  );
}
