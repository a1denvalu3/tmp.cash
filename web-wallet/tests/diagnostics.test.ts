import { afterEach, expect, it, vi } from "vitest";
import {
  WalletDiagnostics,
  DIAGNOSTICS_KEY,
  MAX_DIAGNOSTIC_ENTRIES,
  DIAGNOSTIC_RETENTION_MS,
  diagnosticError,
  diagnoseAction,
  diagnosticFetch,
  walletDiagnostics,
} from "../src/diagnostics";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

it("persists only allowed fields and exact reviewed error messages", () => {
  const storage = memoryStorage();
  const diagnostics = new WalletDiagnostics(() => storage);
  const secrets = [
    "cashuPSsensitiveBearerToken",
    "lnbcSensitiveInvoice",
    "abandon ability able about above absent absorb abstract absurd abuse access accident",
    "f".repeat(64),
    "my backup password",
  ];
  const error = new Error(secrets.join(" "));
  error.name = secrets[0];
  error.stack = `${error.message}\n at ${secrets[3]} (https://user:password@private.example/assets/App-abcd1234.js:40:12)\n at https://private.example/src/App.tsx:50:8\n at https://private.example/assets/${secrets[0]}.js:60:9`;
  diagnostics.record("action.failed", {
    action: "receive",
    ...diagnosticError(error),
    token: secrets[0],
    amount: 123456789,
    url: "https://user:password@private.example",
  } as Parameters<WalletDiagnostics["record"]>[1]);
  diagnostics.record("runtime.error", {
    errorType: "ZodError",
    reason: `Invalid token encoding ${secrets[0]}`,
    frames: [secrets[1], "App:2:3"],
  });
  diagnostics.record(
    "action.failed",
    diagnosticError(new Error("Invalid token encoding")),
  );
  const report = diagnostics.report();
  const stored = storage.getItem(DIAGNOSTICS_KEY)!;
  for (const secret of [
    ...secrets,
    "private.example",
    "user:password",
    "123456789",
  ])
    expect(report + stored).not.toContain(secret);
  const { events } = JSON.parse(report);
  expect(events[0]).toMatchObject({
    event: "action.failed",
    action: "receive",
    errorType: "UnknownError",
    frames: ["App:40:12", "App:50:8", "chunk:60:9"],
  });
  expect(events[1]).not.toHaveProperty("reason");
  expect(events[2].reason).toBe("Invalid token encoding");
});

it("revalidates persisted entries instead of exporting arbitrary stored data", () => {
  const storage = memoryStorage();
  const diagnostics = new WalletDiagnostics(() => storage);
  diagnostics.record("session.started");
  const stored = JSON.parse(storage.getItem(DIAGNOSTICS_KEY)!);
  Object.assign(stored.entries[0], {
    token: "cashuPSSECRET",
    reason: "SECRET",
    errorType: "SECRET",
    endpoint: "/SECRET",
    action: "SECRET",
    frames: ["SECRET", "main:1:2"],
    status: -1,
  });
  stored.entries.push({ ...stored.entries[0], event: "SECRET" });
  storage.setItem(DIAGNOSTICS_KEY, JSON.stringify(stored));
  const report = new WalletDiagnostics(() => storage).report();
  expect(report).not.toContain("SECRET");
  expect(JSON.parse(report).events).toHaveLength(1);
  expect(JSON.parse(report).events[0].frames).toEqual(["main:1:2"]);
});

it("bounds the buffer, survives reloads, and removes expired entries", () => {
  const storage = memoryStorage();
  let now = Date.now();
  const diagnostics = new WalletDiagnostics(
    () => storage,
    () => now,
  );
  for (let i = 0; i < MAX_DIAGNOSTIC_ENTRIES + 5; i++) {
    now++;
    diagnostics.record("action.started", { action: "refresh", actionId: i });
  }
  const reloaded = new WalletDiagnostics(
    () => storage,
    () => now,
  );
  const report = JSON.parse(reloaded.report());
  expect(report.events).toHaveLength(MAX_DIAGNOSTIC_ENTRIES);
  expect(report.events[0].actionId).toBe(5);
  now += DIAGNOSTIC_RETENTION_MS + 1;
  expect(JSON.parse(reloaded.report()).events).toEqual([]);
  expect(JSON.parse(storage.getItem(DIAGNOSTICS_KEY)!).entries).toEqual([]);
});

it("merges sequential tab writes and honors a clear from another tab", () => {
  const storage = memoryStorage();
  const firstTab = new WalletDiagnostics(() => storage);
  const secondTab = new WalletDiagnostics(() => storage);
  firstTab.record("session.started");
  secondTab.record("browser.offline");
  expect(JSON.parse(firstTab.report()).events).toHaveLength(2);
  firstTab.clear();
  expect(JSON.parse(secondTab.report()).events).toEqual([]);
  secondTab.record("browser.online");
  expect(
    JSON.parse(firstTab.report()).events.map(
      (event: { event: string }) => event.event,
    ),
  ).toEqual(["browser.online"]);
});

it("keeps in-memory logs when storage is blocked or full", () => {
  const blocked = new WalletDiagnostics(() => {
    throw new Error("Storage denied");
  });
  const full = new WalletDiagnostics(() => ({
    getItem: () => null,
    setItem: () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    },
  }));
  for (const diagnostics of [blocked, full]) {
    diagnostics.record("session.started");
    diagnostics.record(
      "runtime.error",
      diagnosticError(new TypeError("Failed to fetch")),
    );
    const report = JSON.parse(diagnostics.report());
    expect(report.events).toHaveLength(2);
    expect(report.environment.persistence).toBe("memory-only");
    diagnostics.clear();
    expect(JSON.parse(diagnostics.report()).events).toEqual([]);
  }
});

it.each(["broken JSON", "null", "x".repeat(150_001)])(
  "recovers from corrupt or oversized diagnostic storage",
  (raw) => {
    const storage = memoryStorage();
    storage.setItem(DIAGNOSTICS_KEY, raw);
    const diagnostics = new WalletDiagnostics(() => storage);
    expect(() => diagnostics.record("session.started")).not.toThrow();
    expect(JSON.parse(diagnostics.report()).events).toHaveLength(1);
  },
);

it("records quote lookup IDs without consuming responses or exposing other fields", async () => {
  vi.stubGlobal("localStorage", memoryStorage());
  walletDiagnostics.clear();
  const secret = "f".repeat(64);
  const quoteId = "a1".repeat(32);
  const response = new Response(
    JSON.stringify({ token: "cashuPSSECRET", preimage: secret }),
    { status: 503 },
  );
  const fetcher = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetcher);
  const input = new URL(
    `https://private.example/v1/mint/quote/bolt11/${quoteId}?secret=PRIVATE`,
  );
  const init = {
    method: "POST",
    headers: { Authorization: "PRIVATE" },
    body: JSON.stringify({ preimage: secret }),
    signal: AbortSignal.timeout(1000),
  };
  expect(await diagnosticFetch(input, init)).toBe(response);
  expect(fetcher).toHaveBeenCalledWith(input, init);
  expect(response.bodyUsed).toBe(false);
  expect(await response.json()).toHaveProperty("preimage", secret);
  await diagnosticFetch("https://private.example/PRIVATE", { method: "GET" });
  const report = walletDiagnostics.report();
  for (const value of [
    secret,
    "PRIVATE",
    "private.example",
    "cashuPSSECRET",
    "Authorization",
  ])
    expect(report).not.toContain(value);
  expect(JSON.parse(report).events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "request.completed",
        endpoint: "/v1/mint/quote/bolt11/:id",
        method: "POST",
        status: 503,
        quoteId,
      }),
      expect.objectContaining({
        event: "request.completed",
        endpoint: "other",
      }),
    ]),
  );
});

it("retains invoices, quote IDs, and balances across reloads while omitting wallet secrets", () => {
  const storage = memoryStorage();
  const diagnostics = new WalletDiagnostics(() => storage);
  const invoice = "lnbcrt100n1" + "q".repeat(200);
  const quoteId = "a1".repeat(32);
  diagnostics.record("quote.observed", {
    invoice,
    quoteId,
    preimage: "f".repeat(64),
    proofs: [{ credential: "PRIVATE", secret: "PRIVATE" }],
    password: "PRIVATE",
    token: "cashuPSPRIVATE",
  } as Parameters<WalletDiagnostics["record"]>[1]);
  diagnostics.record("wallet.balance", {
    balance: 100,
    redeemable: 80,
    reserved: 20,
    sent: 5,
    expired: 2,
    verified: true,
  });
  const report = new WalletDiagnostics(() => storage).report();
  expect(JSON.parse(report).events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: "quote.observed", invoice, quoteId }),
      expect.objectContaining({
        event: "wallet.balance",
        balance: 100,
        redeemable: 80,
        reserved: 20,
        sent: 5,
        expired: 2,
        verified: true,
      }),
    ]),
  );
  expect(report).not.toContain("PRIVATE");
  expect(report).not.toContain("f".repeat(64));
  diagnostics.record("quote.observed", {
    invoice: "cashuPSPRIVATE",
    quoteId: "password:PRIVATE",
    balance: NaN,
    reserved: -1,
  });
  const last = JSON.parse(diagnostics.report()).events.at(-1);
  for (const key of ["invoice", "quoteId", "balance", "reserved"])
    expect(last).not.toHaveProperty(key);
});

it("bounds long invoice logs by size so they remain readable after reload", () => {
  const storage = memoryStorage();
  const diagnostics = new WalletDiagnostics(() => storage);
  const invoice = "lnbcrt100n1" + "q".repeat(4000);
  for (let i = 0; i < MAX_DIAGNOSTIC_ENTRIES; i++)
    diagnostics.record("quote.observed", {
      invoice,
      quoteId: i.toString(16).padStart(64, "0"),
    });
  const events = JSON.parse(diagnostics.report()).events;
  expect(events.length).toBeGreaterThan(0);
  expect(events.length).toBeLessThan(MAX_DIAGNOSTIC_ENTRIES);
  expect(events.at(-1)).toMatchObject({
    invoice,
    quoteId: (MAX_DIAGNOSTIC_ENTRIES - 1).toString(16).padStart(64, "0"),
  });
  expect(storage.getItem(DIAGNOSTICS_KEY)!.length).toBeLessThanOrEqual(150_000);
  expect(
    JSON.parse(new WalletDiagnostics(() => storage).report()).events,
  ).toEqual(events);
});

it("selects invoice and quote fields from payment requests and preserves malformed requests", async () => {
  vi.stubGlobal("localStorage", memoryStorage());
  walletDiagnostics.clear();
  const invoice = "LNBC100N1" + "Q".repeat(200);
  const quoteId = "a1".repeat(32);
  const secret = "f".repeat(64);
  const fetcher = vi.fn().mockImplementation(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  await diagnosticFetch("https://private.example/v1/melt/quote/bolt11", {
    method: "POST",
    body: JSON.stringify({ request: invoice, preimage: secret }),
  });
  for (const endpoint of ["mint", "melt"])
    await diagnosticFetch(`https://private.example/v1/${endpoint}/bolt11`, {
      method: "POST",
      body: JSON.stringify({
        quote: quoteId,
        inputs: [{ preimage: secret, token: "cashuPSPRIVATE" }],
        secrets: [secret],
      }),
    });
  const bad = { method: "POST", body: "invalid JSON PRIVATE" };
  await diagnosticFetch("https://private.example/v1/melt/bolt11", bad);
  expect(fetcher).toHaveBeenLastCalledWith(
    "https://private.example/v1/melt/bolt11",
    bad,
  );
  const report = walletDiagnostics.report();
  expect(report).not.toContain("PRIVATE");
  expect(report).not.toContain(secret);
  expect(JSON.parse(report).events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "request.started",
        endpoint: "/v1/melt/quote/bolt11",
        invoice,
      }),
      expect.objectContaining({
        event: "request.started",
        endpoint: "/v1/mint/bolt11",
        quoteId,
      }),
      expect.objectContaining({
        event: "request.completed",
        endpoint: "/v1/melt/bolt11",
        quoteId,
      }),
    ]),
  );
});

it("preserves request exceptions and action results, including pending payments", async () => {
  vi.stubGlobal("localStorage", memoryStorage());
  walletDiagnostics.clear();
  const error = new TypeError("Server echoed cashuPSSECRET");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
  await expect(
    diagnosticFetch("https://private.example/v1/swap", { method: "POST" }),
  ).rejects.toBe(error);
  const result = { token: "cashuPSSECRET" };
  await expect(diagnoseAction("send", async () => result)).resolves.toBe(
    result,
  );
  await expect(
    diagnoseAction("receive", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  const pending = Object.assign(
    new Error("melt payment is pending; retry the same request"),
    { name: "PSMintError", status: 409 },
  );
  await expect(
    diagnoseAction("pay", async () => {
      throw pending;
    }),
  ).rejects.toBe(pending);
  const report = walletDiagnostics.report();
  expect(report).not.toContain("cashuPSSECRET");
  expect(JSON.parse(report).events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "request.failed",
        endpoint: "/v1/swap",
        errorType: "TypeError",
      }),
      expect.objectContaining({ event: "action.succeeded", action: "send" }),
      expect.objectContaining({ event: "action.failed", action: "receive" }),
      expect.objectContaining({
        event: "action.pending",
        action: "pay",
        status: 409,
      }),
    ]),
  );
});

it("does not export raw browser identification or hostile error getters", () => {
  vi.stubGlobal("navigator", {
    userAgent: "PRIVATE Firefox/132 PRIVATE",
    onLine: true,
  });
  const diagnostics = new WalletDiagnostics(() => memoryStorage());
  expect(JSON.parse(diagnostics.report()).environment.browser).toBe(
    "Firefox 132",
  );
  expect(diagnostics.report()).not.toContain("PRIVATE");
  expect(
    diagnosticError({
      get name() {
        throw new Error("PRIVATE");
      },
    }),
  ).toEqual({ errorType: "UnknownError" });
  expect(diagnosticError("cashuPSSECRET")).toEqual({
    errorType: "UnknownError",
  });
});
