import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;
const revision = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
})();

export default defineConfig(({ command }) => ({
  define: {
    "import.meta.env.VITE_WALLET_BUILD": JSON.stringify(
      `${version}+${revision}`,
    ),
    "import.meta.env.VITE_WALLET_BUILT_AT": JSON.stringify(
      new Date().toISOString(),
    ),
  },
  plugins: [
    react(),
    {
      name: "wallet-csp",
      transformIndexHtml: () =>
        command === "build"
          ? [
              {
                tag: "meta",
                attrs: {
                  "http-equiv": "Content-Security-Policy",
                  content:
                    "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' http: https:; object-src 'none'; base-uri 'self'; form-action 'none'",
                },
                injectTo: "head" as const,
              },
            ]
          : [],
    },
  ],
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        landing: fileURLToPath(new URL("./index.html", import.meta.url)),
        cryptography: fileURLToPath(
          new URL("./how-it-works/index.html", import.meta.url),
        ),
        wallet: fileURLToPath(new URL("./wallet/index.html", import.meta.url)),
      },
    },
  },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30000 },
}));
