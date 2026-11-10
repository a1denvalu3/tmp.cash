import { defineConfig } from "@playwright/test";

const walletPort = process.env.WALLET_E2E_PORT || "5173";
const walletUrl = `http://127.0.0.1:${walletPort}`;
const cloud = process.env.WALLET_E2E_CLOUD === "1";
const providerEnv = {
  VITE_GOOGLE_CLIENT_ID: cloud
    ? "browser-test-client.apps.googleusercontent.com"
    : "",
  VITE_APPLE_CLOUDKIT_CONTAINER: cloud ? "iCloud.tmpcash.browser-test" : "",
  VITE_APPLE_CLOUDKIT_API_TOKEN: cloud ? "browser-test-public-api-token" : "",
};

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: walletUrl,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "poetry run python tests/fixture.py --port 3339",
      url: "http://127.0.0.1:3339/test/health",
      reuseExistingServer: false,
    },
    {
      command: process.env.WALLET_E2E_PRODUCTION
        ? `npm run preview -- --port ${walletPort}`
        : `npm run dev -- --port ${walletPort}`,
      url: walletUrl,
      env: providerEnv,
      reuseExistingServer: false,
    },
  ],
});
