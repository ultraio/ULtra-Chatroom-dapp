// Manual interactive session — NOT part of the automated suite (no
// ".spec."/".test." in the filename, so `npm run test:e2e`'s default glob
// skips it; it must be invoked explicitly, see below).
//
// Opens a real, headed Chromium window with the same mock wallet the
// automated tests use (installMockWallet), wired to sign as ACCOUNT with the
// seeded local chain's dev key. Then it pauses so you can drive the actual
// UI by hand — click Connect Wallet, type a message, hit Send — and every
// Send really signs + pushes to the local chain via chain.ts, exactly like
// the real extension would.
//
// Prerequisites (see ../../../DEPLOYMENT.md steps 0-3):
//   - the seeded --keep-alive chain must be running on 127.0.0.1:8888
//   - src/config.ts's CONTRACT_ACCOUNT must be temporarily 'chatroom1'
//     (matches what e2e_setup.ts deployed to)
//
// Run:
//   npx playwright test tests/e2e/manualSession.ts --headed --timeout=0
//
// To act as bob instead of alice in a second window (e.g. to see both sides
// of a conversation), open another terminal:
//   MANUAL_ACCOUNT=bob npx playwright test tests/e2e/manualSession.ts --headed --timeout=0
import { test } from '@playwright/test';
import { installMockWallet } from './mockWallet';

const ACCOUNT = process.env.MANUAL_ACCOUNT || 'alice';

test('manual session', async ({ page }) => {
  await installMockWallet(page, ACCOUNT);
  await page.goto('/');

  // eslint-disable-next-line no-console
  console.log(`\nBrowser open, wired to sign as "${ACCOUNT}". Use the page directly:`);
  // eslint-disable-next-line no-console
  console.log('click Connect Wallet, type a message, hit Send. Resume/close when done.\n');

  await page.pause();
});
