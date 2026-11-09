import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { psInvoiceDetails } from "@cashu/cashu-ts/tmp-cash";

test.skip(
  process.env.WALLET_E2E_CLOUD !== "1",
  "Run npm run test:e2e:cloud to enable the provider fixtures.",
);
const mintUrl = "http://127.0.0.1:3339";
const passphrase = "a guided backup test password";
interface FileValue {
  id: string;
  name: string;
  appProperties: Record<string, string>;
  payload: string;
}
interface ProviderState {
  files: Map<string, FileValue>;
  records: Map<string, unknown>;
  uploads: number;
  loseNext: boolean;
  mintLeaks: string[];
}
function providerState(): ProviderState {
  return {
    files: new Map(),
    records: new Map(),
    uploads: 0,
    loseNext: false,
    mintLeaks: [],
  };
}
async function providers(context: BrowserContext, state: ProviderState) {
  await context.addInitScript(
    (url) => localStorage.setItem("layer3-mint", url),
    mintUrl,
  );
  await context.addCookies([
    {
      name: "wallet-cloud-account",
      value: "browser-google-token",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  context.on("request", (request) => {
    if (request.url().startsWith(mintUrl)) {
      const fields = JSON.stringify({
        headers: request.headers(),
        body: request.postData(),
      });
      if (
        /browser-google-token|wallet-test@example|google:test-user|drive\.appdata|apple:test-user/i.test(
          fields,
        )
      )
        state.mintLeaks.push(request.url());
    }
  });
  await context.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.google={accounts:{oauth2:{initTokenClient:config=>({requestAccessToken:()=>setTimeout(()=>config.callback({access_token:'browser-google-token',expires_in:3600,scope:'openid email https://www.googleapis.com/auth/drive.appdata'}),0)})}}};`,
    }),
  );
  await context.route(
    "https://openidconnect.googleapis.com/v1/userinfo",
    (route) =>
      route.fulfill({
        json: { sub: "test-user", email: "wallet-test@example.com" },
      }),
  );
  await context.route("https://www.googleapis.com/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    expect(request.headers().authorization).toBe("Bearer browser-google-token");
    if (url.pathname.startsWith("/upload/drive/v3/files")) {
      const boundary = request.headers()["content-type"].split("boundary=")[1];
      const parts = request.postData()!.split("--" + boundary);
      const meta = JSON.parse(
        parts[1].slice(parts[1].indexOf("\r\n\r\n") + 4).trim(),
      );
      const payload = parts[2].slice(parts[2].indexOf("\r\n\r\n") + 4).trim();
      expect(meta.parents).toEqual(["appDataFolder"]);
      const id = "drive-" + crypto.randomUUID();
      const file = {
        id,
        name: meta.name,
        appProperties: meta.appProperties,
        payload,
      };
      state.files.set(id, file);
      state.uploads++;
      if (state.loseNext) {
        state.loseNext = false;
        return route.abort("internetdisconnected");
      }
      return route.fulfill({
        json: { id, name: file.name, appProperties: file.appProperties },
      });
    }
    if (url.pathname === "/drive/v3/files") {
      expect(url.searchParams.get("spaces")).toBe("appDataFolder");
      const uploadId = url.searchParams
        .get("q")
        ?.match(/key='uploadId' and value='([^']+)'/)?.[1];
      return route.fulfill({
        json: {
          files: [...state.files.values()]
            .filter(
              (file) => !uploadId || file.appProperties.uploadId === uploadId,
            )
            .map(({ payload: _, ...file }) => file),
        },
      });
    }
    const id = url.pathname.split("/").at(-1)!;
    if (request.method() === "DELETE") {
      state.files.delete(id);
      return route.fulfill({ status: 204 });
    }
    const file = state.files.get(id);
    return file
      ? route.fulfill({ contentType: "application/json", body: file.payload })
      : route.fulfill({ status: 404 });
  });
  await context.route(
    "https://cdn.apple-cloudkit.com/ck/2/cloudkit.js",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `(()=>{
    let config,resolveSignIn;
    const identity={userRecordName:'test-user',nameComponents:{givenName:'Apple',familyName:'Tester'}};
    const request=(operation,body)=>fetch('https://api.apple-cloudkit.com/browser-test/'+operation,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
    const container={setUpAuth:()=>{const host=document.getElementById('apple-sign-in-button');if(host){const b=document.createElement('button');b.textContent='Continue with Apple';b.className='button secondary full';b.onclick=()=>{sessionStorage.setItem('mock-apple-signed-in','1');resolveSignIn?.(identity);};host.replaceChildren(b);}return Promise.resolve(sessionStorage.getItem('mock-apple-signed-in')?identity:null);},whenUserSignsIn:()=>new Promise(resolve=>resolveSignIn=resolve),signOut:()=>sessionStorage.removeItem('mock-apple-signed-in'),privateCloudDatabase:{performQuery:q=>request('query',q),fetchRecords:ids=>request('lookup',{ids}),saveRecords:records=>request('save',{records}),deleteRecords:ids=>request('delete',{ids})}};
    window.CloudKit={configure:value=>{config=value;if(!config.containers[0].apiTokenAuth.apiToken)throw Error('Missing API token');},getDefaultContainer:()=>container};
  })();`,
      }),
  );
  await context.route(
    "https://api.apple-cloudkit.com/browser-test/*",
    async (route) => {
      const { ids, records } = route.request().postDataJSON();
      const operation = new URL(route.request().url()).pathname
        .split("/")
        .at(-1);
      if (operation === "query")
        return route.fulfill({
          json: {
            records: [...state.records.values()].filter(
              (value: any) => value.recordType === "TmpCashBackup",
            ),
          },
        });
      if (operation === "lookup")
        return route.fulfill({
          json: {
            records: ids.map(
              (id: string) =>
                state.records.get(id) ?? {
                  recordName: id,
                  serverErrorCode: "NOT_FOUND",
                },
            ),
          },
        });
      if (operation === "save") {
        for (const record of records)
          state.records.set(record.recordName, record);
        state.uploads++;
        return route.fulfill({ json: { records } });
      }
      for (const id of ids) state.records.delete(id);
      return route.fulfill({ json: { records: [] } });
    },
  );
}
async function welcome(page: Page) {
  await page.goto("/wallet/");
  await expect(
    page.getByRole("dialog", { name: "Keep your wallet safe." }),
  ).toBeVisible();
}
async function signIn(page: Page, provider = "Google") {
  await page
    .getByRole("button", { name: "Continue with " + provider, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    /How would you like to protect it|We found saved wallets/,
  );
}
async function chooseProtection(page: Page, encrypted: boolean, name: string) {
  await page
    .getByRole("button", {
      name: encrypted ? /Add a backup password/ : /Use my account only/,
    })
    .click();
  if (encrypted) {
    await page.getByLabel("Backup password", { exact: true }).fill(passphrase);
    await page.getByLabel("Confirm password").fill(passphrase);
  } else {
    await expect(
      page.getByRole("button", { name: "Turn on automatic backup" }),
    ).toBeDisabled();
    await expect(page.getByRole("dialog")).toContainText(
      "cloud storage provider",
    );
    await page
      .getByRole("checkbox", { name: /I understand that anyone with access/ })
      .check();
  }
  await page.getByText("Wallet name (optional)", { exact: true }).click();
  await page.getByLabel("Wallet name", { exact: true }).fill(name);
}
async function finish(page: Page) {
  await page.getByRole("button", { name: "Turn on automatic backup" }).click();
  await expect(
    page.getByRole("dialog", { name: "Your wallet is backed up." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to my wallet" }).click();
}
async function fund(page: Page, value: number) {
  await expect(page.getByText("Mint connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add sats", exact: true }).click();
  await page.getByLabel("Amount in sats").fill(String(value));
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
    page.getByText(`${value} sats received`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to wallet" }).click();
}

test("explains the benefit in a wallet popup, allows skipping, and can be reopened from the wallet", async ({
  page,
  context,
}) => {
  const state = providerState();
  await providers(context, state);
  await welcome(page);
  await expect(page.getByRole("dialog")).toContainText(
    "find your wallet again",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "Your mint never receives",
  );
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Set up wallet backup", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Keep your wallet safe." }),
  ).toBeVisible();
  expect(state.uploads).toBe(0);
  expect(state.mintLeaks).toEqual([]);
});

for (const encrypted of [true, false]) {
  test(`guides ${encrypted ? "password-protected" : "account-only"} setup, automatic saving and recovery without informing the mint`, async ({
    page,
    context,
    browser,
  }) => {
    const state = providerState();
    await providers(context, state);
    await welcome(page);
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await fund(page, 32);
    await page
      .getByRole("button", { name: "Set up wallet backup", exact: true })
      .click();
    await signIn(page);
    await chooseProtection(page, encrypted, "My guided wallet");
    expect(state.uploads).toBe(0);
    await finish(page);
    expect(state.files.size).toBe(1);
    const first = [...state.files.values()][0];
    expect(first.appProperties.encrypted).toBe(String(encrypted));
    if (encrypted) {
      expect(first.payload).not.toContain('"proofs"');
      expect(first.payload).not.toContain(passphrase);
    } else expect(first.payload).toContain('"proofs"');
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Wallet backup is on" }),
    ).toBeVisible();
    await fund(page, 8);
    await expect
      .poll(() => state.files.size, { timeout: 12000 })
      .toBeGreaterThan(1);
    const newest = [...state.files.values()].sort(
      (a, b) =>
        Number(b.appProperties.created) - Number(a.appProperties.created),
    )[0];
    if (!encrypted)
      expect(JSON.parse(newest.payload).state.activity).toHaveLength(2);
    const fresh = await browser.newContext();
    await providers(fresh, state);
    const restored = await fresh.newPage();
    await welcome(restored);
    await signIn(restored);
    await restored
      .getByRole("button", { name: /My guided wallet/ })
      .first()
      .click();
    if (encrypted) {
      await restored
        .getByLabel("Backup password", { exact: true })
        .fill("an incorrect backup password");
      await restored.getByRole("button", { name: "Restore my wallet" }).click();
      await expect(restored.getByRole("alert")).toContainText(
        /password|unlock/i,
      );
      await restored
        .getByLabel("Backup password", { exact: true })
        .fill(passphrase);
    } else {
      await expect(
        restored.getByLabel("Backup password", { exact: true }),
      ).toHaveCount(0);
      await restored
        .getByRole("checkbox", { name: /this backup has no password/ })
        .check();
    }
    await restored.getByRole("button", { name: "Restore my wallet" }).click();
    await expect(
      restored.getByRole("dialog", { name: "Your wallet is backed up." }),
    ).toBeVisible();
    await restored.getByRole("button", { name: "Back to my wallet" }).click();
    await expect(restored.getByTestId("balance")).toHaveText("40sats");
    expect(
      (await page.request.get(mintUrl + "/api/cloud/status")).status(),
    ).toBe(404);
    expect(state.mintLeaks).toEqual([]);
    await fresh.close();
  });
}

test("retries an accepted upload after response loss and reload without creating a conflicting snapshot", async ({
  page,
  context,
}) => {
  const state = providerState();
  await providers(context, state);
  await welcome(page);
  await signIn(page);
  await chooseProtection(page, true, "Retry wallet");
  state.loseNext = true;
  await page.getByRole("button", { name: "Turn on automatic backup" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "We’ll try again when you’re online",
  );
  expect(state.files.size).toBe(1);
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: "Your wallet is backed up." }),
  ).toBeVisible();
  expect(state.files.size).toBe(1);
  expect(state.uploads).toBe(1);
});

test("guides Apple sign-in to private iCloud backup storage", async ({
  page,
  context,
}) => {
  const state = providerState();
  await providers(context, state);
  await welcome(page);
  await signIn(page, "Apple");
  await chooseProtection(page, false, "Apple wallet");
  await finish(page);
  expect(
    [...state.records.values()].some(
      (value: any) => value.recordType === "TmpCashBackup",
    ),
  ).toBe(true);
  expect(state.files.size).toBe(0);
  expect(state.mintLeaks).toEqual([]);
});

test("keeps the guided popup usable on a narrow screen and never requires sign-in to spend", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 360, height: 700 });
  const state = providerState();
  await providers(context, state);
  await welcome(page);
  const dialog = page.getByRole("dialog"),
    box = await dialog.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(330);
  await expect(
    page.getByRole("button", { name: "Continue with Google", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await fund(page, 4);
  await expect(page.getByTestId("balance")).toHaveText("4sats");
  expect(state.uploads).toBe(0);
});

test("reconnects an expired Google session without repeating password setup", async ({
  page,
  context,
}) => {
  const state = providerState();
  await providers(context, state);
  await welcome(page);
  await signIn(page);
  await chooseProtection(page, true, "Reconnect wallet");
  await finish(page);
  await page.clock.setFixedTime(new Date(Date.now() + 7200000));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Reconnect Google", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reconnect Google", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue with Google", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Your wallet is backed up." }),
  ).toBeVisible();
  await expect(page.getByLabel("Backup password", { exact: true })).toHaveCount(
    0,
  );
  expect(
    new Set(
      [...state.files.values()].map((file) => file.appProperties.walletId),
    ).size,
  ).toBe(1);
});

test("lets the user keep using the wallet while the first backup is still saving", async ({
  page,
  context,
}) => {
  const state = providerState();
  await providers(context, state);
  await welcome(page);
  await signIn(page);
  await chooseProtection(page, true, "Background wallet");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  await page.route(
    "https://www.googleapis.com/upload/drive/v3/files**",
    async (route) => {
      if (first) {
        first = false;
        await held;
      }
      await route.fallback();
    },
  );
  await page.getByRole("button", { name: "Turn on automatic backup" }).click();
  await expect(
    page.getByRole("dialog", { name: "Saving your wallet…" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Keep using my wallet", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Wallet backup is on" }),
  ).toHaveCount(0);
  await fund(page, 4);
  release();
  await expect
    .poll(() => state.files.size, { timeout: 12000 })
    .toBeGreaterThan(1);
  expect(state.mintLeaks).toEqual([]);
});
