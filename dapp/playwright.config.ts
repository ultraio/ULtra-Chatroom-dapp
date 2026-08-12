import { defineConfig } from '@playwright/test';

// Requires VITE_NODE_URL / config.ts pointed at the seeded local chain
// (KB 05 §6) — not executed in this sandbox, see tests/e2e/chain.ts.
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  webServer: {
    // e2e runs the dev server over plain http (E2E_HTTP=1) so the in-browser
    // feed reads can reach the http chain RPC without mixed-content blocking
    // (the mock wallet doesn't need the https origin the real extension does).
    command: 'E2E_HTTP=1 npm run dev -- --port 5183',
    url: 'http://localhost:5183',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:5183',
  },
});
