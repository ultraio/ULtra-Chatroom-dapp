import { defineConfig } from '@playwright/test';

// Config for the interactive manual session ONLY (tests/e2e/manualSession.ts).
// The automated suite keeps using the default playwright.config.ts, whose
// testMatch only picks up *.spec.ts — manualSession.ts deliberately doesn't
// match that, so it needs its own config with an explicit testMatch to be
// discoverable at all, and timeout:0 + headless:false so page.pause() can
// hold a visible browser window open indefinitely.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'manualSession.ts',
  timeout: 0,
  workers: 1,
  webServer: {
    command: 'npm run dev -- --port 5183',
    port: 5183,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:5183',
    headless: false,
  },
});
