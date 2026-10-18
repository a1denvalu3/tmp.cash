import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <button
        type="button"
        className="button secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setError("");
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setError("Select and copy the text below.");
          }
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
        {copied ? "Copied" : label}
      </button>
      {error && (
        <p role="status" className="small">
          {error}
        </p>
      )}
    </>
  );
}
