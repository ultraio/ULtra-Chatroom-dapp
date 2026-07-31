import { defineConfig } from '@playwright/test';

// Requires VITE_NODE_URL / config.ts pointed at the seeded local chain
// (KB 05 §6) — not executed in this sandbox, see tests/e2e/chain.ts.
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  webServer: {
    command: 'npm run dev -- --port 5183',
    port: 5183,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:5183',
  },
});
