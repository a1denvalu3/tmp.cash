export function RecoveryProtection({
  mode,
  onChange,
}: {
  mode: "passphrase" | "plaintext";
  onChange(mode: "passphrase" | "plaintext"): void;
}) {
  return (
    <fieldset className="recovery-options">
      <legend>Backup protection</legend>
      <label>
        <input
          type="radio"
          name="backup-protection"
          checked={mode === "passphrase"}
          onChange={() => onChange("passphrase")}
        />{" "}
        Encrypt with a passphrase
      </label>
      <label>
        <input
          type="radio"
          name="backup-protection"
          checked={mode === "plaintext"}
          onChange={() => onChange("plaintext")}
        />{" "}
        Save without encryption
      </label>
      {mode === "plaintext" && (
        <p className="small muted">
          Anyone who can read this backup can access your wallet secrets.
        </p>
      )}
    </fieldset>
  );
}
