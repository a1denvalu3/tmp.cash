import { test, expect, type Page } from "@playwright/test";
import { psInvoiceDetails } from "@cashu/cashu-ts/tmp-cash";
import { readFile } from "node:fs/promises";
const mintUrl = "http://127.0.0.1:3339";
const passphrase = "a cloud backup test passphrase";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    (url) => localStorage.setItem("layer3-mint", url),
    mintUrl,
  );
});
async function signIn(page: Page) {
  await page.goto("/wallet/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await expect(
    page.getByText("wallet-test@example.com", { exact: true }),
  ).toBeVisible();
}
async function fund(page: Page, amount: number) {
  await page.getByRole("button", { name: "Wallet", exact: true }).click();
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add sats", exact: true }).click();
  await page.getByLabel("Amount in sats").fill(String(amount));
  await page.getByRole("button", { name: "Create funding invoice" }).click();
  await expect(page.getByLabel("Funding invoice")).toHaveValue(/^lnbcrt/);
  const hash = psInvoiceDetails(
    await page.getByLabel("Funding invoice").inputValue(),
  ).paymentHash;
  await page.request.post(mintUrl + "/test/accept", {
    data: { payment_hash: hash },
  });
  await page.getByRole("button", { name: "Check payment" }).click();
  await expect(
    page.getByText(`${amount} sats received`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to wallet" }).click();
}
for (const encrypted of [true, false]) {
  test(`saves ${encrypted ? "encrypted" : "unencrypted"} cloud backups across reload, retries offline changes, and restores after social login`, async ({
    page,
    browser,
  }) => {
    const name = encrypted
      ? "Encrypted browser test"
      : "No passphrase browser test";
    await signIn(page);
    await expect(
      page.getByRole("button", { name: "Enable automatic backups" }),
    ).toBeVisible();
    await page.getByLabel("Backup name").fill(name);
    if (encrypted) {
      await page
        .getByLabel("Cloud backup passphrase", { exact: true })
        .fill(passphrase);
      await page.getByLabel("Confirm passphrase").fill(passphrase);
    } else {
      await page.getByLabel("Backup protection").selectOption("plaintext");
      await expect(
        page.getByText(/including the backup server operator/).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Enable automatic backups" }),
      ).toBeDisabled();
      await page
        .getByRole("checkbox", { name: /I understand that anyone with access/ })
        .check();
    }
    await page
      .getByRole("button", { name: "Enable automatic backups" })
      .click();
    await expect(page.getByText(/Last saved:/)).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Pause automatic backups" }),
    ).toBeVisible();
    await page.route("**/api/cloud/backups/*", (route) =>
      route.request().method() === "PUT"
        ? route.abort("internetdisconnected")
        : route.continue(),
    );
    await fund(page, 32);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator(".cloud-card")).toContainText(
      /Failed to fetch|NetworkError/,
      { timeout: 12000 },
    );
    await page.unroute("**/api/cloud/backups/*");
    await expect(page.locator(".cloud-card")).toContainText(
      "Changes are saved automatically",
      { timeout: 12000 },
    );
    const put = page.waitForResponse(
      (response) =>
        response.url().includes("/api/cloud/backups/") &&
        response.request().method() === "PUT",
    );
    await page
      .getByRole("button", { name: "Back up now", exact: true })
      .click();
    const saved = await put;
    expect(saved.status()).toBe(200);
    const uploaded = saved.request().postDataJSON();
    if (encrypted) {
      expect(uploaded.payload).not.toContain("preimage");
      expect(uploaded.payload).not.toContain("proofs");
      expect(uploaded.payload).not.toContain(passphrase);
    } else expect(uploaded.payload).toContain("preimage");
    const context = await browser.newContext();
    const restored = await context.newPage();
    await restored.addInitScript(
      (url) => localStorage.setItem("layer3-mint", url),
      mintUrl,
    );
    await signIn(restored);
    await restored
      .getByRole("button", { name: "Restore " + name, exact: true })
      .click();
    if (encrypted) {
      await restored
        .getByLabel("Saved backup passphrase")
        .fill("an incorrect backup passphrase");
      await restored
        .getByRole("button", { name: "Restore saved wallet" })
        .click();
      await expect(restored.getByRole("alert")).toContainText(
        "Incorrect password",
      );
      await restored.getByLabel("Saved backup passphrase").fill(passphrase);
    } else
      await expect(restored.getByLabel("Saved backup passphrase")).toHaveCount(
        0,
      );
    await restored
      .getByRole("button", { name: "Restore saved wallet" })
      .click();
    await expect(restored.getByRole("alert")).toContainText(
      "Cloud backup restored",
    );
    await restored.getByRole("button", { name: "Wallet", exact: true }).click();
    await expect(restored.getByTestId("balance")).toHaveText("32sats");
    await restored
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await restored
      .getByRole("button", { name: "Restore " + name, exact: true })
      .click();
    if (encrypted)
      await restored.getByLabel("Saved backup passphrase").fill(passphrase);
    await restored
      .getByRole("button", { name: "Restore saved wallet" })
      .click();
    await expect(restored.getByRole("alert")).toContainText(
      "Restore requires an empty wallet",
    );
    await context.close();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Continue with Google" }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Continue with Google" }),
    ).toBeVisible();
  });
}

test("requires risk acknowledgement for an unencrypted file and restores it without a password", async ({
  page,
  browser,
}) => {
  await page.goto("/wallet/");
  await fund(page, 16);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Export backup", exact: true })
    .click();
  await page.getByLabel("File protection").selectOption("plaintext");
  await expect(
    page.getByRole("button", { name: "Download unencrypted backup" }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: /I understand that anyone with this file/ })
    .check();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download unencrypted backup" })
    .click();
  const buffer = await readFile((await (await download).path())!);
  expect(buffer.toString()).toContain("preimage");
  const context = await browser.newContext();
  const restored = await context.newPage();
  await restored.addInitScript(
    (url) => localStorage.setItem("layer3-mint", url),
    mintUrl,
  );
  await restored.goto("/wallet/");
  await restored.getByRole("button", { name: "Settings", exact: true }).click();
  await restored
    .getByRole("button", { name: "Restore backup", exact: true })
    .click();
  await restored.getByLabel("Backup file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer,
  });
  await restored
    .getByRole("button", { name: "Restore wallet", exact: true })
    .click();
  await expect(restored.getByRole("dialog")).toHaveCount(0);
  await restored.getByRole("button", { name: "Wallet", exact: true }).click();
  await expect(restored.getByTestId("balance")).toHaveText("16sats");
  await context.close();
});

test("resumes saved backups when a wallet opened offline reconnects", async ({
  page,
}) => {
  await signIn(page);
  await page.getByLabel("Backup name").fill("Reconnect test");
  await page.getByLabel("Backup protection").selectOption("plaintext");
  await page
    .getByRole("checkbox", { name: /I understand that anyone with access/ })
    .check();
  await page.getByRole("button", { name: "Enable automatic backups" }).click();
  await expect(page.getByText(/Last saved:/)).toBeVisible();
  await page.route("**/api/cloud/status", (route) =>
    route.abort("internetdisconnected"),
  );
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText(/Cloud sign-in is unavailable/)).toBeVisible();
  await page.unroute("**/api/cloud/status");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(
    page.getByRole("button", { name: "Pause automatic backups" }),
  ).toBeVisible();
  await expect(page.getByText(/Last saved:/)).toBeVisible();
});

for (const encrypted of [true, false]) {
  test(`recovers an accepted ${encrypted ? "encrypted" : "unencrypted"} cloud save after a lost response and reload`, async ({
    page,
  }) => {
    await signIn(page);
    await page
      .getByLabel("Backup name")
      .fill(`Lost response ${encrypted ? "encrypted" : "unencrypted"}`);
    if (encrypted) {
      await page
        .getByLabel("Cloud backup passphrase", { exact: true })
        .fill(passphrase);
      await page.getByLabel("Confirm passphrase").fill(passphrase);
    } else {
      await page.getByLabel("Backup protection").selectOption("plaintext");
      await page
        .getByRole("checkbox", { name: /I understand that anyone with access/ })
        .check();
    }
    const attempts: { payload: string; revision: number }[] = [];
    let savedUrl = "";
    await page.route("**/api/cloud/backups/*", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) {
        savedUrl = route.request().url();
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort("internetdisconnected");
      } else await route.continue();
    });
    await page
      .getByRole("button", { name: "Enable automatic backups" })
      .click();
    await expect(page.locator(".cloud-card")).toContainText(
      /Failed to fetch|NetworkError/,
    );
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator(".cloud-card")).toContainText(
      "Changes are saved automatically",
      { timeout: 12000 },
    );
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const user = (await (await page.request.get("/api/cloud/status")).json())
      .user;
    const headers = { "X-Cloud-Account": user.account };
    const recovered = await (
      await page.request.get(savedUrl, { headers })
    ).json();
    expect(recovered.revision).toBe(1);
    expect(recovered.payload).toBe(attempts[0].payload);
    await fund(page, 8);
    await expect
      .poll(
        async () =>
          (await (await page.request.get(savedUrl, { headers })).json())
            .revision,
        { timeout: 12000 },
      )
      .toBeGreaterThan(1);
  });
}
