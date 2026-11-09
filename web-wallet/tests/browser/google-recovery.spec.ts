import { test, expect, type Page } from "@playwright/test";
import { psInvoiceDetails } from "@cashu/cashu-ts/tmp-cash";

const mint = "http://127.0.0.1:3339";
test.skip(
  !process.env.VITE_FIREBASE_API_KEY ||
    Boolean(process.env.WALLET_E2E_PRODUCTION),
  "Run with the documented dummy Firebase configuration against the development server",
);

async function google(page: Page, copies: string[]) {
  await page.addInitScript(
    (url) => localStorage.setItem("layer3-mint", url),
    mint,
  );
  // Exercise the actual UI/Drive HTTP contract without a Google account or OAuth popup.
  await page.route("**/src/google.ts*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `let listener = () => {};
      export function observeGoogleUser(fn) { listener = fn; queueMicrotask(() => fn(null)); return () => {}; }
      export async function connectGoogle() { const user = {uid:"alice", email:"alice@example.test"}; listener(user); return {user, token:"test-token"}; }
      export async function disconnectGoogle() { listener(null); }`,
    }),
  );
  await page.route("https://www.googleapis.com/**", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer test-token");
    if (route.request().method() === "POST") {
      const body = route.request().postData()!;
      copies.push(
        body
          .split("Content-Type: application/json\r\n\r\n")[1]
          .split("\r\n--")[0],
      );
      await route.fulfill({ json: { id: `copy_${copies.length - 1}` } });
    } else if (route.request().url().includes("alt=media")) {
      const id = new URL(route.request().url()).pathname.split("/").pop()!;
      await route.fulfill({
        contentType: "application/json",
        body: copies[Number(id.split("_")[1])],
      });
    } else {
      await route.fulfill({
        json: {
          files: copies
            .map((_, index) => ({
              id: `copy_${index}`,
              name: `backup-${index}.json`,
              createdTime: new Date().toISOString(),
            }))
            .reverse(),
        },
      });
    }
  });
}

for (const mode of ["passphrase", "plaintext"] as const) {
  test(`automatically backs up and restores a real wallet through Google Drive in ${mode} mode`, async ({
    page,
    browser,
    baseURL,
  }) => {
    const copies: string[] = [];
    await google(page, copies);
    await page.goto("/wallet/");
    await expect(
      page.getByText("Mint connected", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page.getByLabel("Encrypt with a passphrase")).toBeChecked();
    if (mode === "plaintext")
      await page.getByLabel("Save without encryption").check();
    else
      await page
        .getByLabel("Recovery passphrase")
        .fill("a browser recovery passphrase");
    await page
      .getByRole("button", { name: "Enable automatic backups" })
      .click();
    await expect.poll(() => copies.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Wallet", exact: true }).click();
    await page.getByRole("button", { name: "Add sats", exact: true }).click();
    await page.getByLabel("Amount in sats").fill("64");
    await page.getByRole("button", { name: "Create funding invoice" }).click();
    await expect(page.getByLabel("Funding invoice")).toHaveValue(/^lnbcrt/);
    const payment_hash = psInvoiceDetails(
      await page.getByLabel("Funding invoice").inputValue(),
    ).paymentHash;
    await page.request.post(mint + "/test/accept", { data: { payment_hash } });
    await expect(page.getByTestId("balance")).toHaveText("64sats", {
      timeout: 12000,
    });
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const before = copies.length;
    await page.getByRole("button", { name: "Back up now" }).click();
    await expect.poll(() => copies.length).toBeGreaterThan(before);
    const raw = copies.at(-1)!;
    expect(JSON.parse(raw).format).toBe(
      mode === "plaintext" ? "tmp.cash-plaintext" : "cashu-layer3-encrypted",
    );
    if (mode === "passphrase") expect(raw).not.toContain("credential");
    else expect(raw).toContain("credential");

    const context = await browser.newContext({ baseURL });
    try {
      const restored = await context.newPage();
      await google(restored, copies);
      await restored.goto("/wallet/");
      await expect(
        restored.getByText("Mint connected", { exact: true }),
      ).toBeVisible();
      await restored
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await restored
        .getByRole("button", { name: "Continue with Google" })
        .click();
      await restored
        .getByRole("button", { name: "Find Google Drive backups" })
        .click();
      await restored
        .getByRole("button", { name: "Restore from Google Drive" })
        .click();
      if (mode === "passphrase") {
        await restored
          .locator("#drive-restore-password")
          .fill("a browser recovery passphrase");
        await restored
          .getByRole("button", { name: "Restore from Google Drive" })
          .click();
      }
      await expect(
        restored.getByText("Google Drive backup restored."),
      ).toBeVisible();
      await restored
        .getByRole("button", { name: "Wallet", exact: true })
        .click();
      await expect(restored.getByTestId("balance")).toHaveText("64sats");
    } finally {
      await context.close();
    }
  });
}
