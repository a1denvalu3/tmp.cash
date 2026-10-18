import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { psInvoiceDetails } from "@cashu/cashu-ts/tmp-cash";

const mintUrl = "http://127.0.0.1:3339";
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    (url) => localStorage.setItem("layer3-mint", url),
    mintUrl,
  );
});

test("exports real funding and payment invoices, quote IDs, and balance changes without spend secrets", async ({
  page,
}) => {
  const fundingPreimages: string[] = [];
  const quoteIds: string[] = [];
  const payoutPreimages: string[] = [];
  const reservedAmounts: number[] = [];
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (path === "/v1/mint/quote/bolt11" || path === "/v1/melt/quote/bolt11")
      quoteIds.push((await response.json()).quote);
    if (path === "/v1/melt/bolt11")
      payoutPreimages.push((await response.json()).payout_preimage);
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/melt/bolt11") {
      const inputs: { preimage: string; amount: number }[] =
        request.postDataJSON().inputs;
      reservedAmounts.push(
        inputs.reduce((sum, input) => sum + input.amount, 0),
      );
      fundingPreimages.push(...inputs.map((input) => input.preimage));
    }
  });
  await page.goto("/wallet/");
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add sats", exact: true }).click();
  await page.getByLabel("Amount in sats").fill("100");
  await page.getByRole("button", { name: "Create funding invoice" }).click();
  await expect(page.getByLabel("Funding invoice")).toHaveValue(/^lnbcrt/);
  const fundingInvoice = await page.getByLabel("Funding invoice").inputValue();
  await page.request.post(mintUrl + "/test/accept", {
    data: { payment_hash: psInvoiceDetails(fundingInvoice).paymentHash },
  });
  await page.getByRole("button", { name: "Check payment" }).click();
  await expect(
    page.getByText("100 sats received", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to wallet" }).click();
  await expect(page.getByTestId("balance")).toHaveText("100sats");
  const paymentInvoice = (
    await (
      await page.request.post(mintUrl + "/test/receiver", {
        data: { amount: 10 },
      })
    ).json()
  ).request;
  await page
    .getByRole("button", { name: "Pay with Lightning", exact: true })
    .click();
  await page.getByLabel("Lightning invoice or address").fill(paymentInvoice);
  await page.getByRole("button", { name: "Review payment" }).click();
  await page.getByRole("button", { name: "Pay 10 sats", exact: true }).click();
  await expect(page.getByText(/^Paid 10 sats/)).toBeVisible();
  await page.reload();
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByText("Logs include invoices, balances, and quote IDs.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy debug logs" }).click();
  const text = await page.getByLabel("Debug report").inputValue();
  const report = JSON.parse(text);
  expect(report.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "quote.observed",
        invoice: fundingInvoice,
        quoteId: quoteIds[0],
      }),
      expect.objectContaining({
        event: "quote.observed",
        invoice: paymentInvoice,
        quoteId: quoteIds[1],
      }),
      expect.objectContaining({
        event: "wallet.balance",
        balance: 100,
        redeemable: 100,
        verified: true,
      }),
      expect.objectContaining({
        event: "wallet.balance",
        reserved: reservedAmounts[0],
      }),
      expect.objectContaining({
        event: "request.started",
        endpoint: "/v1/melt/bolt11",
        quoteId: quoteIds[1],
      }),
    ]),
  );
  expect(fundingPreimages.length).toBeGreaterThan(0);
  expect(payoutPreimages.length).toBeGreaterThan(0);
  for (const secret of [...fundingPreimages, ...payoutPreimages])
    expect(text).not.toContain(secret);
  expect(text).not.toContain('"credential"');
  expect(text).not.toContain('"proofs"');
  expect(text).not.toContain('"secrets"');
});

test("copies and downloads safe diagnostics after a failed action, reload, and offline connection", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const secret = "cashuPSSENSITIVE lnbcSENSITIVE " + "f".repeat(64);
  await page.route(mintUrl + "/v1/mint/quote/bolt11", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      json: { detail: secret },
    }),
  );
  await page.goto("/wallet/");
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add sats", exact: true }).click();
  await page.getByLabel("Amount in sats").fill("1024");
  await page.getByRole("button", { name: "Create funding invoice" }).click();
  await expect(page.getByRole("alert")).toContainText(secret);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.evaluate((value) => {
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error(value), message: value }),
    );
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", {
        reason: new Error(value),
        promise: Promise.resolve(),
      }),
    );
  }, secret);
  await page.route(mintUrl + "/**", (route) => route.abort("failed"));
  await page.reload();
  await expect(page.getByText("Mint offline", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Copy debug logs" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Debug logs copied" }),
  ).toBeVisible();
  const text = await page.getByLabel("Debug report").inputValue();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  for (const value of [
    secret,
    "cashuPSSENSITIVE",
    "lnbcSENSITIVE",
    "f".repeat(64),
    mintUrl,
  ])
    expect(text).not.toContain(value);
  const report = JSON.parse(text);
  expect(report.build).toMatch(/^0\.1\.0\+/);
  expect(report.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "action.failed",
        action: "create-funding",
        errorType: "PSMintError",
        status: 503,
      }),
      expect.objectContaining({
        event: "request.completed",
        endpoint: "/v1/mint/quote/bolt11",
        status: 503,
      }),
      expect.objectContaining({ event: "runtime.error" }),
      expect.objectContaining({ event: "runtime.rejection" }),
      expect.objectContaining({
        event: "request.failed",
        endpoint: "/v1/info",
      }),
    ]),
  );
  const sessions = new Set(
    report.events
      .filter((event: { event: string }) => event.event === "session.started")
      .map((event: { session: string }) => event.session),
  );
  expect(sessions.size).toBe(2);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download logs" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^tmp\.cash-debug-.*\.json$/);
  expect(
    JSON.parse(await readFile((await download.path())!, "utf8")).events,
  ).toEqual(report.events);
  await page.getByRole("button", { name: "Clear logs" }).click();
  await expect(
    page.getByText("Debug logs cleared.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Debug report")).toHaveCount(0);
  await page.getByRole("button", { name: "Copy debug logs" }).click();
  expect(
    JSON.parse(await page.getByLabel("Debug report").inputValue()).events,
  ).toEqual([]);
});

test("offers manual copy when the clipboard and browser storage are blocked", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "tmp.cash-diagnostics-v1")
        throw new DOMException("Full", "QuotaExceededError");
      original.call(this, key, value);
    };
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("Denied");
        },
      },
    });
  });
  await page.goto("/wallet/");
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Copy debug logs" }).click();
  await expect(
    page.getByText("Select and copy the debug logs below.", { exact: true }),
  ).toBeVisible();
  const report = JSON.parse(await page.getByLabel("Debug report").inputValue());
  expect(report.environment.persistence).toBe("memory-only");
  expect(report.events).toContainEqual(
    expect.objectContaining({ event: "action.succeeded", action: "connect" }),
  );
});

test("keeps logs accessible when the lazy wallet screen crashes", async ({
  page,
}) => {
  await page.route("**/src/App.tsx*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'throw new Error("cashuPSPRIVATE crash detail");',
    }),
  );
  // In production the wallet lives in a separate hashed bundle.
  await page.route("**/assets/App-*.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'throw new Error("cashuPSPRIVATE crash detail");',
    }),
  );
  await page.goto("/wallet/");
  await expect(
    page.getByRole("heading", { name: "The wallet could not open." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy debug logs" }).click();
  const text = await page.getByLabel("Debug report").inputValue();
  expect(text).not.toContain("cashuPSPRIVATE");
  expect(JSON.parse(text).events).toContainEqual(
    expect.objectContaining({ event: "wallet.crashed" }),
  );
});
