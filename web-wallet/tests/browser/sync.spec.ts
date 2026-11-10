import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { psInvoiceDetails } from "@cashu/cashu-ts/tmp-cash";
import { testRelay } from "../helpers/nostr-relay";

let relay: Awaited<ReturnType<typeof testRelay>>;
test.beforeAll(async () => {
  relay = await testRelay();
});
test.afterAll(async () => {
  await relay.close();
});
const mint = "http://127.0.0.1:3339";
async function prepare(context: BrowserContext) {
  await context.addInitScript((url) => {
    localStorage.setItem("layer3-mint", url);
    localStorage.setItem("tmpcash-backup-prompt-dismissed", "1");
  }, mint);
}
async function fund(page: Page, value: number) {
  await page.getByRole("button", { name: "Add sats", exact: true }).click();
  await page.getByLabel("Amount in sats").fill(String(value));
  await page.getByRole("button", { name: "Create funding invoice" }).click();
  await expect(page.getByLabel("Funding invoice")).toHaveValue(/^lnbcrt/);
  const hash = psInvoiceDetails(
    await page.getByLabel("Funding invoice").inputValue(),
  ).paymentHash;
  await page.request.post(mint + "/test/accept", {
    data: { payment_hash: hash },
  });
  await page.getByRole("button", { name: "Check payment" }).click();
  await expect(
    page.getByText(`${value} sats received`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to wallet" }).click();
}
test("pairs isolated browsers through NIP-42, keeps outgoing tokens excluded, and resumes after reload", async ({
  page,
  context,
  browser,
}) => {
  await prepare(context);
  await page.goto("/wallet/");
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  await fund(page, 16);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Relay URLs")).toHaveValue(
    "wss://buzz.cashu.space",
  );
  await page.getByLabel("Relay URLs").fill(relay.url);
  await page.getByRole("button", { name: "Enable device sync" }).click();
  await expect(page.getByLabel("Your private sync code")).toHaveValue(
    /^tmpcash-sync1:/,
  );
  const code = await page.getByLabel("Your private sync code").inputValue();
  const fresh = await browser.newContext();
  try {
    await prepare(fresh);
    const other = await fresh.newPage();
    await other.goto("/wallet/");
    await expect(
      other.getByText("Mint connected", { exact: true }),
    ).toBeVisible();
    await other.getByRole("button", { name: "Settings", exact: true }).click();
    await other
      .getByText("Connect to an existing wallet", { exact: true })
      .click();
    await other.getByLabel("Private sync code", { exact: true }).fill(code);
    await other.getByRole("button", { name: "Connect this device" }).click();
    await expect(
      other.getByRole("button", { name: "Pause sync on this device" }),
    ).toBeVisible();
    await other.getByRole("button", { name: "Wallet", exact: true }).click();
    await expect(other.getByTestId("balance")).toHaveText("16sats");
    await page.getByRole("button", { name: "Wallet", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByLabel("Amount in sats").fill("8");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByLabel("Ecash token")).toContainText("cashuPS");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect(other.getByTestId("balance")).toHaveText("8sats", {
      timeout: 20000,
    });
    await other.reload();
    await expect(other.getByTestId("balance")).toHaveText("8sats");
    expect(relay.auth.length).toBeGreaterThanOrEqual(3);
    expect(
      [...relay.events.values()].every(
        (e) => !e.content.includes("credential"),
      ),
    ).toBe(true);
  } finally {
    await fresh.close();
  }
});

test("allows retrying a valid but unknown sync code without trapping an empty wallet", async ({
  page,
  context,
}) => {
  await prepare(context);
  await page.goto("/wallet/");
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByText("Connect to an existing wallet", { exact: true })
    .click();
  const code =
    "tmpcash-sync1:" +
    btoa(
      JSON.stringify({
        version: 1,
        secret: "42".repeat(32),
        mint,
        relays: [relay.url],
      }),
    );
  await page.getByLabel("Private sync code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Connect this device" }).click();
  await expect(
    page.getByRole("button", { name: "Enable device sync" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pause sync on this device" }),
  ).toHaveCount(0);
});
