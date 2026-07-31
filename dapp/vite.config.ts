import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  // Ultra Wallet's content script only matches "https://*/*" (checked its
  // manifest directly) — plain http://localhost never gets window.ultra
  // injected. basicSsl serves a self-signed cert locally so the extension
  // fires; the browser will show a one-time cert warning to click through.
  plugins: [vue(), basicSsl()],
  server: { https: true },
  preview: { https: true },
  test: {
    environment: 'node',
    exclude: ['node_modules/**', 'tests/e2e/**'],
  },
});
