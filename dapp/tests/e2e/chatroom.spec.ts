// Requires a seeded keep-alive chain first (KB 04 §6):
//   ultratest2 --contracts-dir-path=<...>/build/contracts \
//     -t <repo>/ultratests/chatroom/e2e_setup.ts --keep-alive
// then, in another terminal: npx playwright test
//
// UNVERIFIED IN THIS SANDBOX — no local nodeos/CDT/Docker here to seed a
// chain against. Validate on a machine with the toolchain before trusting it.
import { test, expect } from '@playwright/test';
import { installMockWallet } from './mockWallet';
import { chainClient } from './chain';

const CONTRACT_ACCOUNT = 'chatroom1'; // matches e2e_setup.ts

test('connect, send a message, see it in the feed and on chain', async ({ page }) => {
  await installMockWallet(page, 'alice');
  await page.goto('/');

  await page.getByRole('button', { name: 'Connect Wallet' }).click();
  await expect(page.locator('.topbar .account')).toHaveText('alice');

  const text = `e2e message ${Date.now()}`;
  const composerInput = page.locator('.composer-line input[type="text"]');
  await composerInput.fill(text);
  await composerInput.press('Enter');

  await expect(page.getByText(text)).toBeVisible({ timeout: 10_000 });

  const { rows } = await chainClient.v1.chain.get_table_rows({
    code: CONTRACT_ACCOUNT,
    scope: CONTRACT_ACCOUNT,
    table: 'messages.a',
    json: true,
    limit: 100,
  });
  const last = rows[rows.length - 1] as any;
  expect(last.text).toBe(text);
  expect(last.sender).toBe('alice');
});

test('a message over the 256-character cap is rejected client-side, never reaches the chain', async ({ page }) => {
  await installMockWallet(page, 'alice');
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect Wallet' }).click();

  const { rows: before } = await chainClient.v1.chain.get_table_rows({
    code: CONTRACT_ACCOUNT,
    scope: CONTRACT_ACCOUNT,
    table: 'messages.a',
    json: true,
    limit: 1000,
  });

  const tooLong = 'x'.repeat(300);
  const composerInput = page.locator('.composer-line input[type="text"]');
  await composerInput.fill(tooLong.slice(0, 256)); // input has maxlength=256
  await page.evaluate((v) => {
    const el = document.querySelector('.composer-line input[type="text"]') as HTMLInputElement;
    el.value = v;
    el.dispatchEvent(new Event('input'));
  }, tooLong);
  await composerInput.press('Enter');

  await expect(page.getByText(/too long/i)).toBeVisible();

  const { rows: after } = await chainClient.v1.chain.get_table_rows({
    code: CONTRACT_ACCOUNT,
    scope: CONTRACT_ACCOUNT,
    table: 'messages.a',
    json: true,
    limit: 1000,
  });
  expect(after.length).toBe(before.length);
});
