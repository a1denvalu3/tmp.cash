import { test, expect, type Page } from "@playwright/test";
import { psInvoiceDetails, psRandomHex } from "@cashu/cashu-ts/tmp-cash";

test.skip(
  !process.env.FIRESTORE_EMULATOR_HOST ||
    !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    process.env.VITE_FIREBASE_SYNC_ENABLED !== "true" ||
    Boolean(process.env.WALLET_E2E_PRODUCTION),
  "Run with test:sync:browser",
);
const mint = "http://127.0.0.1:3339";
async function signIn(page: Page, email: string) {
  await page.addInitScript(
    (url) => localStorage.setItem("layer3-mint", url),
    mint,
  );
  await page.route("**/src/google.ts*", async (route) => {
    // Preserve Vite's resolved SDK module identities. Only Google's popup is replaced;
    // authentication, security rules, transactions, and wallet execution are real.
    const source = await (await route.fetch()).text();
    const firestore = await (
      await page.request.get("/src/firestore-wallet.ts")
    ).text();
    function path(text: string, name: string) {
      const found = text.match(
        new RegExp(`from ["']([^"']*firebase_${name}\\.js[^"']*)["']`),
      );
      if (!found) throw new Error(`Missing ${name} SDK import`);
      return JSON.stringify(found[1]);
    }
    await route.fulfill({
      contentType: "application/javascript",
      body: `
      import {initializeApp,getApps} from ${path(source, "app")};
      import {getAuth,connectAuthEmulator,onAuthStateChanged,signInWithEmailAndPassword,createUserWithEmailAndPassword,signOut} from ${path(source, "auth")};
      import {getFirestore,connectFirestoreEmulator} from ${path(firestore, "firestore")};
      let initialized=false;
      export function googleApp() {
        const app=getApps().find(app=>app.name==='tmp.cash') ?? initializeApp({projectId:'demo-tmpcash',apiKey:'demo-public-key',authDomain:'demo-tmpcash.firebaseapp.com'},'tmp.cash');
        if(!initialized) { connectAuthEmulator(getAuth(app),'http://127.0.0.1:9099',{disableWarnings:true}); connectFirestoreEmulator(getFirestore(app),'127.0.0.1',8089); initialized=true; }
        return app;
      }
      export function observeGoogleUser(fn) { return onAuthStateChanged(getAuth(googleApp()),fn); }
      export async function connectGoogle() {
        const auth=getAuth(googleApp());
        try { await signInWithEmailAndPassword(auth,${JSON.stringify(email)},'test-only-demo-passphrase'); }
        catch { await createUserWithEmailAndPassword(auth,${JSON.stringify(email)},'test-only-demo-passphrase'); }
        return {user:auth.currentUser,token:'test-drive-token'};
      }
      export async function disconnectGoogle() { await signOut(getAuth(googleApp())); }
    `,
    });
  });
  await page.goto("/wallet/");
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Use Google wallet", exact: true })
    .click();
}

for (const protection of ["passphrase", "plaintext"] as const)
  test(`coordinates a ${protection} wallet across desktop/mobile profiles and locks after sign-out`, async ({
    page,
    browser,
    baseURL,
  }) => {
    const email = `shared-${psRandomHex().slice(0, 12)}@example.test`;
    await signIn(page, email);
    if (protection === "passphrase")
      await page
        .getByLabel("Shared wallet passphrase")
        .fill("a shared browser passphrase");
    else await page.getByLabel("Save without encryption").check();
    await page
      .getByRole("button", { name: "Create shared wallet", exact: true })
      .click();
    await expect(
      page.getByText(`Google wallet open for ${email}.`),
    ).toBeVisible();
    await page.getByRole("button", { name: "Wallet", exact: true }).click();
    await page.getByRole("button", { name: "Add sats", exact: true }).click();
    await page.getByLabel("Amount in sats").fill("64");
    await page.getByRole("button", { name: "Create funding invoice" }).click();
    await expect(page.getByLabel("Funding invoice")).toHaveValue(/^lnbcrt/);
    const hash = psInvoiceDetails(
      await page.getByLabel("Funding invoice").inputValue(),
    ).paymentHash;
    await page.request.post(mint + "/test/accept", {
      data: { payment_hash: hash },
    });
    await expect(page.getByTestId("balance")).toHaveText("64sats", {
      timeout: 15000,
    });
    await page.getByRole("button", { name: "Close dialog" }).click();
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      isMobile: true,
    });
    try {
      const mobile = await context.newPage();
      await signIn(mobile, email);
      if (protection === "passphrase") {
        await mobile
          .getByLabel("Shared wallet passphrase")
          .fill("a shared browser passphrase");
        await mobile
          .getByRole("button", { name: "Unlock Google wallet", exact: true })
          .click();
      }
      await expect(
        mobile.getByText(`Google wallet open for ${email}.`),
      ).toBeVisible();
      await mobile.getByRole("button", { name: "Wallet", exact: true }).click();
      await expect(mobile.getByTestId("balance")).toHaveText("64sats");
      for (const active of [page, mobile]) {
        await active.getByRole("button", { name: "Send", exact: true }).click();
        await active.getByLabel("Amount in sats").fill("64");
      }
      await Promise.all([
        page.getByRole("button", { name: "Create token" }).click(),
        mobile.getByRole("button", { name: "Create token" }).click(),
      ]);
      await expect
        .poll(
          async () =>
            (await page.getByLabel("Outgoing token").count()) +
            (await mobile.getByLabel("Outgoing token").count()),
          { timeout: 15000 },
        )
        .toBe(1);
      await mobile.getByRole("button", { name: "Close dialog" }).click();
      await mobile
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await mobile
        .getByRole("button", { name: "Sign out of Google", exact: true })
        .click();
      await expect(
        mobile.getByText("Google wallet open for", { exact: false }),
      ).toHaveCount(0);
      await mobile.getByRole("button", { name: "Wallet", exact: true }).click();
      await expect(
        mobile.getByRole("button", { name: "Send", exact: true }),
      ).toBeDisabled();
      await mobile.reload();
      await expect(
        mobile.getByRole("button", { name: "Send", exact: true }),
      ).toBeDisabled();
    } finally {
      await context.close();
    }
  });
