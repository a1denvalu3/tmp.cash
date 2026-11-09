import { defineConfig } from "@playwright/test";

const walletPort = process.env.WALLET_E2E_PORT || "5173";
const walletUrl = `http://127.0.0.1:${walletPort}`;

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
      command: `WALLET_E2E_ORIGIN=${walletUrl} ../.venv/bin/python tests/fixture.py --port 3339`,
      url: "http://127.0.0.1:3339/test/health",
      reuseExistingServer: false,
    },
    {
      command: process.env.WALLET_E2E_PRODUCTION
        ? `WALLET_CLOUD_PROXY_TARGET=http://127.0.0.1:3339 npm run preview -- --port ${walletPort}`
        : `WALLET_CLOUD_PROXY_TARGET=http://127.0.0.1:3339 npm run dev -- --port ${walletPort}`,
      url: walletUrl,
      reuseExistingServer: false,
    },
  ],
});
