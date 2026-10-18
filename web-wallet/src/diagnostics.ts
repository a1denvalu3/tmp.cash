// Diagnostics use an allowlist, not string redaction. Never pass wallet state,
// request bodies, tokens, preimages, URLs, or arbitrary error text to the report.
export const DIAGNOSTICS_KEY = "tmp.cash-diagnostics-v1";
export const MAX_DIAGNOSTIC_ENTRIES = 200;
export const DIAGNOSTIC_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_STORED_LENGTH = 150_000;

const events = [
  "session.started",
  "action.started",
  "action.succeeded",
  "action.failed",
  "action.pending",
  "request.started",
  "request.completed",
  "request.failed",
  "runtime.error",
  "runtime.rejection",
  "wallet.crashed",
  "wallet.balance",
  "quote.observed",
  "browser.online",
  "browser.offline",
] as const;
const actions = [
  "connect",
  "read-wallet",
  "refresh",
  "create-funding",
  "check-funding",
  "send",
  "receive",
  "lookup-payment",
  "quote-payment",
  "pay",
  "retry",
  "add-preimage",
  "backup",
  "restore",
  "save-mint",
  "qr-camera",
  "qr-image",
] as const;
const endpoints = [
  "/v1/info",
  "/v1/keys",
  "/v1/mint/quote/bolt11",
  "/v1/mint/quote/bolt11/:id",
  "/v1/mint/bolt11",
  "/v1/htlcs/check",
  "/v1/checkstate",
  "/v1/swap",
  "/v1/melt/quote/bolt11",
  "/v1/melt/bolt11",
  "other",
] as const;
const errorTypes = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "PSMintError",
  "ZodError",
  "AbortError",
  "TimeoutError",
  "QuotaExceededError",
  "SecurityError",
  "InvalidStateError",
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "OperationError",
  "UnknownError",
  "VersionError",
] as const;

// Only exact, reviewed messages are exported. A mint can echo a secret in its
// error response, and validation errors may include their rejected inputs.
const safeMessages = [
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
  "Mint returned an invalid response",
  "Mint response is too large",
  "Mint returned inconsistent keyset parameters",
  "Mint returned unexpected backing HTLCs",
  "Mint returned inconsistent backing block height",
  "Mint changed backing deadline clock during check",
  "Invalid token credential, denomination or backing",
  "Token belongs to a different mint",
  "Token is already spent or has a pending operation",
  "This wallet accepts cashuPS tokens",
  "Invalid token encoding",
  "Token is too large",
  "Duplicate token proof",
  "Inconsistent backing metadata",
  "Unsupported credential version",
  "Preimage does not match backing HTLC",
  "Preimage does not match this backing HTLC",
  "Token is missing its backing preimage",
  "Backing HTLC is closed or unavailable",
  "Backing HTLC redemption deadline has passed or is inconsistent",
  "Mint omitted proof states",
  "Mint changed signing keyset",
  "Mint changed output denominations",
  "Mint returned an inconsistent melt quote",
  "Mint returned an invalid melt receipt",
  "Unexpected or duplicate change",
  "Mint changed backing allocation of change",
  "Not enough tokens to cover invoice and fee reserve",
  "Unknown funding request",
  "Unknown pending operation",
  "Invalid amount",
  "Enter a BOLT11 Lightning invoice",
  "Enter a Lightning invoice, Lightning address, or LNURL",
  "Could not reach the LNURL service. Please try again.",
  "The LNURL service returned an invalid response",
  "The LNURL service rejected this payment",
  "This LNURL does not provide a valid Lightning payment request",
  "This LNURL does not accept a whole-satoshi payment amount",
  "This LNURL requires payer information that this wallet does not support",
  "The LNURL service returned invalid payment metadata",
  "The LNURL service did not provide a payment description",
  "The LNURL service did not return a Lightning invoice",
  "The LNURL invoice amount does not match your requested amount",
  "The LNURL service returned an expired invoice. Please try again.",
  "The LNURL invoice does not match the payment metadata",
  "Wait for the Lightning address lookup to finish",
  "Invalid invoice signature",
  "Invalid invoice tags",
  "Invoice signature does not match payee",
  "Invoice must contain an amount and payment hash",
  "Invoice must use whole satoshis",
  "melt payment is pending; retry the same request",
  "melt payment failed; tokens are unspent",
  "melt payment failed; backing has expired",
  "melt quote has expired",
  "backing HTLC is closed; its tokens have expired",
  "backing HTLC redemption deadline has passed",
  "melt quote already belongs to another request",
  "payout invoice is already paid",
  "backing HTLC is too close to its settlement cutoff for a new melt",
  "Use a backup password with at least 12 characters",
  "Wallet state is too large for a restorable backup",
  "Backup file is too large",
  "Backup is too large",
  "Choose a backup file",
  "Unsupported backup format",
  "Invalid backup encryption parameters",
  "Incorrect password or damaged backup",
  "Unsupported backup contents",
] as const;

type DiagnosticEvent = (typeof events)[number];
export type DiagnosticAction = (typeof actions)[number];
interface DiagnosticDetails {
  action?: DiagnosticAction;
  actionId?: number;
  requestId?: number;
  endpoint?: (typeof endpoints)[number];
  method?: "GET" | "POST";
  status?: number;
  durationMs?: number;
  errorType?: string;
  reason?: string;
  frames?: string[];
  line?: number;
  column?: number;
  invoice?: string;
  quoteId?: string;
  balance?: number;
  redeemable?: number;
  reserved?: number;
  sent?: number;
  expired?: number;
  verified?: boolean;
}
interface DiagnosticEntry extends DiagnosticDetails {
  time: number;
  session: string;
  sequence: number;
  event: DiagnosticEvent;
}
type LogStorage = Pick<Storage, "getItem" | "setItem">;

function member<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && values.includes(value as T);
}
function integer(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
  );
}
function identifier(): string {
  // This ID only distinguishes browser sessions; it never identifies funds.
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}
function cleanDetails(value: DiagnosticDetails): DiagnosticDetails {
  const result: DiagnosticDetails = {};
  if (member(actions, value.action)) result.action = value.action;
  if (member(endpoints, value.endpoint)) result.endpoint = value.endpoint;
  if (member(["GET", "POST"] as const, value.method))
    result.method = value.method;
  if (member(errorTypes, value.errorType)) result.errorType = value.errorType;
  if (member(safeMessages, value.reason)) result.reason = value.reason;
  // These fields are intentionally shareable. Keep their shape constrained so
  // arbitrary input or an entire wallet object cannot become diagnostic text.
  if (
    typeof value.invoice === "string" &&
    value.invoice.length <= 4096 &&
    /^ln(?:bcrt|bc|tb)[0-9]*[munp]?1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{100,}$/i.test(
      value.invoice,
    )
  )
    result.invoice = value.invoice;
  if (
    typeof value.quoteId === "string" &&
    /^[0-9a-f]{64}$/i.test(value.quoteId)
  )
    result.quoteId = value.quoteId;
  for (const key of [
    "balance",
    "redeemable",
    "reserved",
    "sent",
    "expired",
  ] as const)
    if (integer(value[key])) result[key] = value[key];
  if (typeof value.verified === "boolean") result.verified = value.verified;
  for (const key of ["actionId", "requestId", "line", "column"] as const)
    if (integer(value[key], 1_000_000_000)) result[key] = value[key];
  if (integer(value.status, 599) && value.status >= 100)
    result.status = value.status;
  if (integer(value.durationMs, 86_400_000))
    result.durationMs = value.durationMs;
  if (Array.isArray(value.frames))
    result.frames = value.frames
      .filter(
        (frame) =>
          typeof frame === "string" &&
          /^(App|main|wallet|index|InvoiceScanner|diagnostics|chunk):\d{1,9}:\d{1,9}$/.test(
            frame,
          ),
      )
      .slice(0, 5);
  return result;
}

function bounded(entries: DiagnosticEntry[]): DiagnosticEntry[] {
  // Invoices can be long. Bound storage by size as well as event count, leaving
  // room for the envelope, so a report remains readable after a reload.
  let remaining = MAX_STORED_LENGTH - 100;
  const kept: DiagnosticEntry[] = [];
  for (const entry of entries.slice(-MAX_DIAGNOSTIC_ENTRIES).reverse()) {
    remaining -= JSON.stringify(entry).length + 1;
    if (remaining < 0) break;
    kept.push(entry);
  }
  return kept.reverse();
}

export function diagnosticError(error: unknown): DiagnosticDetails {
  try {
    if (!error || typeof error !== "object")
      return { errorType: "UnknownError" };
    const source = error as {
      name?: unknown;
      message?: unknown;
      status?: unknown;
      stack?: unknown;
    };
    const details: DiagnosticDetails = {
      errorType: member(errorTypes, source.name) ? source.name : "UnknownError",
    };
    if (member(safeMessages, source.message)) details.reason = source.message;
    if (integer(source.status, 599) && source.status >= 100)
      details.status = source.status;
    // Export only bundle labels and numeric positions, never function names,
    // arbitrary filenames, source paths, query strings, or the stack's message.
    if (typeof source.stack === "string") {
      details.frames = [
        ...source.stack
          .slice(0, 16_000)
          .matchAll(
            /\/(?:src\/(App|main|InvoiceScanner|diagnostics)\.tsx?|assets\/([\w-]+)\.js):(\d{1,9}):(\d{1,9})(?=[)\s]|$)/g,
          ),
      ]
        .slice(0, 5)
        .map((match) => {
          const bundle =
            match[1] ??
            /^(App|main|wallet|index|InvoiceScanner|diagnostics)-/.exec(
              match[2],
            )?.[1] ??
            "chunk";
          return `${bundle}:${match[3]}:${match[4]}`;
        });
    }
    return cleanDetails(details);
  } catch {
    return { errorType: "UnknownError" };
  }
}

export class WalletDiagnostics {
  private entries: DiagnosticEntry[] = [];
  private generation = "0000000000000000";
  private session = identifier();
  private sequence = 0;
  private persistent = false;
  constructor(
    private readonly storage: () => LogStorage | undefined = () =>
      globalThis.localStorage,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(): DiagnosticEntry[] {
    let saved: DiagnosticEntry[] = [];
    try {
      const raw = this.storage()?.getItem(DIAGNOSTICS_KEY);
      if (raw && raw.length <= MAX_STORED_LENGTH) {
        const parsed = JSON.parse(raw);
        if (
          typeof parsed.generation === "string" &&
          /^[0-9a-f]{16}$/.test(parsed.generation) &&
          Array.isArray(parsed.entries)
        ) {
          if (this.generation !== parsed.generation) this.entries = [];
          this.generation = parsed.generation;
          saved = parsed.entries;
        }
      }
    } catch {
      this.persistent = false;
    }
    const unique = new Map<string, DiagnosticEntry>();
    const now = this.now();
    for (const entry of [...saved, ...this.entries]) {
      if (
        !entry ||
        !member(events, entry.event) ||
        !integer(entry.time) ||
        entry.time < now - DIAGNOSTIC_RETENTION_MS ||
        entry.time > now + 60_000 ||
        typeof entry.session !== "string" ||
        !/^[0-9a-f]{16}$/.test(entry.session) ||
        !integer(entry.sequence)
      )
        continue;
      unique.set(`${entry.session}:${entry.sequence}`, {
        time: entry.time,
        session: entry.session,
        sequence: entry.sequence,
        event: entry.event,
        ...cleanDetails(entry),
      });
    }
    return bounded(
      [...unique.values()].sort(
        (a, b) => a.time - b.time || a.sequence - b.sequence,
      ),
    );
  }
  private persist(): void {
    try {
      const storage = this.storage();
      if (!storage) {
        this.persistent = false;
        return;
      }
      storage.setItem(
        DIAGNOSTICS_KEY,
        JSON.stringify({ generation: this.generation, entries: this.entries }),
      );
      this.persistent = true;
    } catch {
      // Quota limits or blocked storage must never break a wallet operation.
      this.persistent = false;
    }
  }
  record(event: DiagnosticEvent, details: DiagnosticDetails = {}): void {
    try {
      if (!member(events, event)) return;
      this.entries = this.recent();
      this.entries.push({
        time: this.now(),
        session: this.session,
        sequence: ++this.sequence,
        event,
        ...cleanDetails(details),
      });
      this.entries = bounded(this.entries);
      this.persist();
    } catch {
      /* Diagnostics must not change the outcome of wallet operations. */
    }
  }
  clear(): void {
    this.entries = [];
    this.generation = identifier();
    this.persist();
  }
  report(): string {
    this.entries = this.recent();
    this.persist();
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const browser =
      /(Edg|Firefox|CriOS|FxiOS)\/(\d{1,4})/.exec(ua) ??
      /(Chrome|Version)\/(\d{1,4})/.exec(ua);
    return JSON.stringify(
      {
        report: "tmp.cash debug logs",
        format: 1,
        exportedAt: new Date(this.now()).toISOString(),
        build: import.meta.env.VITE_WALLET_BUILD || "development",
        builtAt: import.meta.env.VITE_WALLET_BUILT_AT || null,
        environment: {
          browser: browser
            ? `${browser[1] === "Version" ? "Safari" : browser[1]} ${browser[2]}`
            : "Unknown",
          online: typeof navigator !== "undefined" ? navigator.onLine : null,
          secureContext: globalThis.isSecureContext ?? false,
          webLocks: typeof navigator !== "undefined" && !!navigator.locks,
          persistence: this.persistent ? "browser" : "memory-only",
        },
        events: this.entries,
      },
      null,
      2,
    );
  }
}

export const walletDiagnostics = new WalletDiagnostics();
let actionSequence = 0;
export async function diagnoseAction<T>(
  action: DiagnosticAction,
  fn: () => Promise<T>,
): Promise<T> {
  const actionId = ++actionSequence;
  const started = Date.now();
  walletDiagnostics.record("action.started", { action, actionId });
  try {
    const result = await fn();
    walletDiagnostics.record("action.succeeded", {
      action,
      actionId,
      durationMs: Math.max(0, Date.now() - started),
    });
    return result;
  } catch (error) {
    const details = diagnosticError(error);
    const pending =
      details.errorType === "PSMintError" &&
      details.status === 409 &&
      details.reason === "melt payment is pending; retry the same request";
    walletDiagnostics.record(pending ? "action.pending" : "action.failed", {
      action,
      actionId,
      durationMs: Math.max(0, Date.now() - started),
      ...details,
    });
    throw error;
  }
}

let requestSequence = 0;
// Only the wallet's injected fetcher is observed; global fetch and console are
// untouched. Responses and errors are returned without reading response bodies.
// Only invoice/quote fields from known JSON requests are selected for logging.
export const diagnosticFetch: typeof fetch = async (input, init) => {
  const requestId = ++requestSequence;
  let endpoint: DiagnosticDetails["endpoint"] = "other";
  let method: DiagnosticDetails["method"];
  let context: DiagnosticDetails = {};
  try {
    const path = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    ).pathname;
    const canonical = path.replace(
      /^\/v1\/mint\/quote\/bolt11\/[0-9a-f]{64}$/,
      "/v1/mint/quote/bolt11/:id",
    );
    if (member(endpoints, canonical)) endpoint = canonical;
    if (endpoint === "/v1/mint/quote/bolt11/:id")
      context.quoteId = path.slice(path.lastIndexOf("/") + 1);
    const verb =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (verb === "GET" || verb === "POST") method = verb;
    if (
      method === "POST" &&
      typeof init?.body === "string" &&
      init.body.length <= 4_000_000
    ) {
      if (endpoint === "/v1/melt/quote/bolt11") {
        const body = JSON.parse(init.body);
        context.invoice = body.request;
      } else if (
        endpoint === "/v1/mint/bolt11" ||
        endpoint === "/v1/melt/bolt11"
      ) {
        const body = JSON.parse(init.body);
        context.quoteId = body.quote;
      }
    }
    context = cleanDetails(context);
  } catch {
    /* A malformed URL is still passed unchanged to fetch. */
  }
  const details = { requestId, endpoint, method, ...context };
  const started = Date.now();
  walletDiagnostics.record("request.started", details);
  try {
    const response = await globalThis.fetch(input, init);
    walletDiagnostics.record("request.completed", {
      ...details,
      status: response.status,
      durationMs: Math.max(0, Date.now() - started),
    });
    return response;
  } catch (error) {
    walletDiagnostics.record("request.failed", {
      ...details,
      durationMs: Math.max(0, Date.now() - started),
      ...diagnosticError(error),
    });
    throw error;
  }
};

let started = false;
export function startWalletDiagnostics(): void {
  if (started) return;
  started = true;
  walletDiagnostics.record("session.started");
  window.addEventListener("error", (event) =>
    walletDiagnostics.record("runtime.error", {
      ...diagnosticError(event.error),
      line: event.lineno,
      column: event.colno,
    }),
  );
  window.addEventListener("unhandledrejection", (event) =>
    walletDiagnostics.record(
      "runtime.rejection",
      diagnosticError(event.reason),
    ),
  );
  window.addEventListener("online", () =>
    walletDiagnostics.record("browser.online"),
  );
  window.addEventListener("offline", () =>
    walletDiagnostics.record("browser.offline"),
  );
}
