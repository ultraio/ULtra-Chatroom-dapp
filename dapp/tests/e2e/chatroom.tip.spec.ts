// Requires the seeded keep-alive chain (ultratests/chatroom/e2e_setup.ts, which
// now grants chatroom1@eosio.code) running at :8888, then `npx playwright test`.
// Verifies the full /tip flow end to end: the dapp sends ONE transfer to the
// contract, the contract forwards to the recipient, and the feed badges the
// stored row as a verified tip.
import { test, expect } from '@playwright/test';
import { installMockWallet } from './mockWallet';
import { chainClient } from './chain';

const CONTRACT_ACCOUNT = 'chatroom1';

async function uosBalance(account: string): Promise<number> {
  const { rows } = await chainClient.v1.chain.get_table_rows({
    code: 'eosio.token',
    scope: account,
    table: 'accounts',
    json: true,
    limit: 1,
  });
  const row = rows[0] as any;
  return row ? parseFloat(String(row.balance).split(' ')[0]) : 0;
}

test('tip: bob tips alice — contract forwards on-chain and the feed badges it', async ({ page }) => {
  await installMockWallet(page, 'bob');
  await page.goto('/');

  await page.getByRole('button', { name: 'Connect Wallet' }).click();
  await expect(page.locator('.topbar .account')).toHaveText('bob');

  const aliceBefore = await uosBalance('alice');

  const note = `nice work ${Date.now()}`;
  const composerInput = page.locator('.composer input[type="text"]');
  await composerInput.fill(`/tip alice 3 ${note}`);
  await composerInput.press('Enter');

  // The stored row is badged as a verified tip (id is above the dev boundary -1).
  const tipRow = page.locator('.bubble.tip', { hasText: note });
  await expect(tipRow).toBeVisible({ timeout: 10_000 });
  await expect(tipRow.locator('.tip-badge')).toHaveText(/tip/i);
  await expect(tipRow.locator('.tip-body')).toContainText('3 UOS');
  await expect(tipRow.locator('.tip-body')).toContainText('@alice');

  // The contract actually forwarded the funds: alice is +3 UOS.
  await expect.poll(async () => await uosBalance('alice'), { timeout: 10_000 }).toBe(aliceBefore + 3);

  // ...and the on-chain message row stores the verbatim tip memo.
  const { rows } = await chainClient.v1.chain.get_table_rows({
    code: CONTRACT_ACCOUNT,
    scope: CONTRACT_ACCOUNT,
    table: 'messages.a',
    json: true,
    limit: 1000,
  });
  const last = rows[rows.length - 1] as any;
  expect(last.text).toBe(`/tip alice 3 ${note}`);
  expect(last.sender).toBe('bob');
});

test('tip: a self-tip is rejected client-side and never reaches the chain', async ({ page }) => {
  await installMockWallet(page, 'bob');
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect Wallet' }).click();
  await expect(page.locator('.topbar .account')).toHaveText('bob');

  const { rows: before } = await chainClient.v1.chain.get_table_rows({
    code: CONTRACT_ACCOUNT, scope: CONTRACT_ACCOUNT, table: 'messages.a', json: true, limit: 1000,
  });

  const composerInput = page.locator('.composer input[type="text"]');
  await composerInput.fill('/tip bob 1 to myself');
  await composerInput.press('Enter');

  await expect(page.getByText(/can't tip yourself/i)).toBeVisible();

  const { rows: after } = await chainClient.v1.chain.get_table_rows({
    code: CONTRACT_ACCOUNT, scope: CONTRACT_ACCOUNT, table: 'messages.a', json: true, limit: 1000,
  });
  expect(after.length).toBe(before.length);
});
