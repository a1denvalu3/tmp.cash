import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  psInvoiceDetails,
  psPreimageHash,
  decodePSToken,
  psTokenAmount,
} from "@cashu/cashu-ts/tmp-cash";

const mintUrl = "http://127.0.0.1:3339";
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    (url) => localStorage.setItem("layer3-mint", url),
    mintUrl,
  );
});
async function fund(page: Page, amount: number) {
  await page.getByRole("button", { name: "Wallet", exact: true }).click();
  await page.getByRole("button", { name: "Add sats", exact: true }).click();
  await page.getByLabel("Amount in sats").fill(String(amount));
  await page.getByRole("button", { name: "Create funding invoice" }).click();
  await expect(page.getByLabel("Funding invoice")).toHaveValue(/^lnbcrt/);
  const invoice = await page.getByLabel("Funding invoice").inputValue();
  const hash = psInvoiceDetails(invoice).paymentHash;
  await page.request.post(mintUrl + "/test/accept", {
    data: { payment_hash: hash },
  });
  await page.getByRole("button", { name: "Check payment" }).click();
  await expect(
    page.getByText(`${amount} sats received`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to wallet" }).click();
  return { invoice, hash };
}
async function details(page: Page, name: string) {
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const button = page
    .getByRole("button", { name: new RegExp(`^View ${name} details`) })
    .first();
  await button.focus();
  await button.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  return page.getByRole("dialog");
}
async function close(page: Page) {
  await page.getByRole("button", { name: "Close dialog" }).click();
}

test("opens deposit, send, receive, and payment receipts and preserves the payment proof offline and in backups", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/wallet/");
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  const funding = await fund(page, 100);
  let popup = await details(page, "Added ecash");
  await expect(
    popup.getByLabel("Funding invoice", { exact: true }),
  ).toHaveValue(funding.invoice);
  await expect(popup.getByLabel("Backing hash", { exact: true })).toHaveValue(
    funding.hash,
  );
  await expect(popup.locator("time").first()).toHaveAttribute(
    "datetime",
    /^\d{4}-\d{2}-\d{2}T/,
  );
  expect(
    psTokenAmount(
      decodePSToken(await popup.getByLabel("Issued token").inputValue()),
    ),
  ).toBe(100);
  await expect(popup.getByLabel("Quote ID", { exact: true })).toHaveValue(
    /^[0-9a-f]{64}$/,
  );
  await close(page);
  await page.getByRole("button", { name: "Wallet", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByLabel("Amount in sats").fill("30");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByLabel("Outgoing token")).toHaveValue(/^cashuPS/);
  const token = await page.getByLabel("Outgoing token").inputValue();
  await close(page);
  popup = await details(page, "Sent ecash");
  await expect(popup.getByLabel("Outgoing token")).toHaveValue(token);
  await expect(popup.getByLabel("Backing funding invoice")).toHaveValue(
    funding.invoice,
  );
  await expect(popup.getByLabel("Backing hash", { exact: true })).toHaveValue(
    funding.hash,
  );
  await close(page);

  const bobContext = await browser.newContext({
    baseURL,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const bob = await bobContext.newPage();
  await bob.addInitScript(
    (url) => localStorage.setItem("layer3-mint", url),
    mintUrl,
  );
  await bob.goto("/wallet/");
  await expect(bob.getByText("Mint connected", { exact: true })).toBeVisible();
  await bob.getByRole("button", { name: "Receive", exact: true }).click();
  await bob.getByLabel("Ecash token").fill(token);
  await bob.getByRole("button", { name: "Receive token", exact: true }).click();
  await expect(
    bob.getByText("Received 30 sats.", { exact: true }),
  ).toBeVisible();
  popup = await details(bob, "Received ecash");
  await expect(popup.getByLabel("Received token")).toHaveValue(token);
  await expect(popup.getByText(/exchanged for fresh proofs/)).toBeVisible();
  await close(bob);
  const invoice = (
    await (
      await bob.request.post(mintUrl + "/test/receiver", {
        data: { amount: 10 },
      })
    ).json()
  ).request;
  await bob.getByRole("button", { name: "Wallet", exact: true }).click();
  await bob
    .getByRole("button", { name: "Pay with Lightning", exact: true })
    .click();
  await bob.getByLabel("Lightning invoice or address").fill(invoice);
  await bob.getByRole("button", { name: "Review payment" }).click();
  await bob.getByRole("button", { name: "Pay 10 sats", exact: true }).click();
  await expect(bob.getByText(/^Paid 10 sats/)).toBeVisible();
  popup = await details(bob, "Lightning payment");
  await expect(
    popup.getByLabel("Lightning invoice", { exact: true }),
  ).toHaveValue(invoice);
  await expect(
    popup.getByText(/It matches the invoice payment hash/),
  ).toBeVisible();
  const preimage = await popup
    .getByLabel("Payment preimage", { exact: true })
    .inputValue();
  await popup.screenshot({ path: "test-results/activity-payment-details.png" });
  expect(psPreimageHash(preimage)).toBe(psInvoiceDetails(invoice).paymentHash);
  await expect(popup.getByLabel("Payment hash", { exact: true })).toHaveValue(
    psInvoiceDetails(invoice).paymentHash,
  );
  expect(
    psTokenAmount(
      decodePSToken(await popup.getByLabel("Spent token").inputValue()),
    ),
  ).toBeGreaterThanOrEqual(12);
  await popup
    .getByRole("button", { name: "Copy payment preimage", exact: true })
    .click();
  expect(await bob.evaluate(() => navigator.clipboard.readText())).toBe(
    preimage,
  );
  await close(bob);
  await bob.route(mintUrl + "/**", (route) => route.abort("failed"));
  await bob.reload();
  await expect(bob.getByText("Mint offline", { exact: true })).toBeVisible();
  popup = await details(bob, "Lightning payment");
  await expect(
    popup.getByLabel("Payment preimage", { exact: true }),
  ).toHaveValue(preimage);
  await expect(
    popup.getByLabel("Lightning invoice", { exact: true }),
  ).toHaveValue(invoice);
  await close(bob);
  await bob.getByRole("button", { name: "Settings", exact: true }).click();
  await bob.getByRole("button", { name: "Export backup", exact: true }).click();
  const password = "activity details browser backup";
  await bob.getByLabel("Backup password").fill(password);
  const downloaded = bob.waitForEvent("download");
  await bob.getByRole("button", { name: "Download encrypted backup" }).click();
  const download = await downloaded;
  const buffer = await readFile((await download.path())!);
  expect(buffer.toString()).not.toContain(preimage);
  const restoreContext = await browser.newContext({ baseURL });
  const restored = await restoreContext.newPage();
  await restored.addInitScript(
    (url) => localStorage.setItem("layer3-mint", url),
    mintUrl,
  );
  await restored.goto("/wallet/");
  await expect(
    restored.getByText("Mint connected", { exact: true }),
  ).toBeVisible();
  await restored.getByRole("button", { name: "Settings", exact: true }).click();
  await restored
    .getByRole("button", { name: "Restore backup", exact: true })
    .click();
  await restored.getByLabel("Backup file").setInputFiles({
    name: "activity-backup.json",
    mimeType: "application/json",
    buffer,
  });
  await restored.getByLabel("Backup password").fill(password);
  await restored
    .getByRole("button", { name: "Restore wallet", exact: true })
    .click();
  await expect(restored.getByRole("dialog")).toHaveCount(0);
  popup = await details(restored, "Lightning payment");
  await expect(
    popup.getByLabel("Payment preimage", { exact: true }),
  ).toHaveValue(preimage);
  await expect(
    popup.getByLabel("Lightning invoice", { exact: true }),
  ).toHaveValue(invoice);
  await restoreContext.close();
  await bobContext.close();
});

test("opens expiry details and keeps legacy activity readable on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 576 });
  await page.goto("/wallet/");
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  const funding = await fund(page, 32);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("cashu_layer3_wallet_v3");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("activity", "readwrite");
      const store = tx.objectStore("activity");
      const request = store.getAll();
      request.onsuccess = () => {
        for (const row of request.result) {
          delete row.details;
          store.put(row);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  let popup = await details(page, "Added ecash");
  await expect(
    popup.getByText("Invoice not recorded for this older activity."),
  ).toBeVisible();
  await expect(
    popup.getByText("Ecash token not recorded for this older activity."),
  ).toBeVisible();
  await close(page);
  await page.request.post(mintUrl + "/test/settle", {
    data: { payment_hash: funding.hash },
  });
  await page.getByRole("button", { name: "Wallet", exact: true }).click();
  await page.getByRole("button", { name: "Refresh backing status" }).click();
  popup = await details(page, "Backing expired");
  await expect(popup.getByLabel("Backing hash", { exact: true })).toHaveValue(
    funding.hash,
  );
  await expect(
    popup.getByText(/not the exact time the backing closed/),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const dimensions = await popup.evaluate((element) => ({
    width: element.scrollWidth,
    client: element.clientWidth,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.client + 1);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
