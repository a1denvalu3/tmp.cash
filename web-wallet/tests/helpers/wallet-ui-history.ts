import type { Page } from "@playwright/test";

interface WalletUiHistory {
  balances: string[];
  mint: string[];
}

/** Observe every rendered transition, including flickers a final-state assertion misses. */
export async function observeWalletUi(page: Page) {
  await page.evaluate(() => {
    const target = window as typeof window & {
      walletUiHistory: WalletUiHistory;
    };
    target.walletUiHistory = { balances: [], mint: [] };
    const sample = () => {
      const balance =
        document
          .querySelector('[data-testid="balance"]')
          ?.textContent?.replace(/\s+/g, "") ?? "missing";
      const mint =
        document
          .querySelector('[data-testid="mint-status"]')
          ?.textContent?.replace(/\s+/g, " ")
          .trim() ?? "missing";
      target.walletUiHistory.balances.push(balance);
      target.walletUiHistory.mint.push(mint);
    };
    sample();
    new MutationObserver(sample).observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

export async function walletUiHistory(page: Page): Promise<WalletUiHistory> {
  return page.evaluate(() => {
    const history = (
      window as typeof window & { walletUiHistory: WalletUiHistory }
    ).walletUiHistory;
    return {
      balances: [...new Set(history.balances)],
      mint: [...new Set(history.mint)],
    };
  });
}
