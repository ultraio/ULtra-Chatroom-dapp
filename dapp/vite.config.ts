import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Ultra Wallet's content script only matches "https://*/*", so local manual QA
// with the REAL extension needs https (basicSsl). Playwright e2e injects a MOCK
// wallet instead (no extension), and a self-signed https origin can't talk to
// the http://127.0.0.1:8888 chain RPC (mixed content is blocked in-browser). So
// e2e runs the dev server over plain http (E2E_HTTP=1) — see playwright.config.
const httpsMode = process.env.E2E_HTTP !== '1';

export default defineConfig({
  // basicSsl serves a self-signed cert locally so the extension fires; the
  // browser shows a one-time cert warning to click through.
  plugins: [
    vue({
      // <emoji-picker> (from emoji-picker-element) is a custom element, not a
      // Vue component — tell the compiler so it renders it natively and binds
      // @emoji-click as a real DOM event listener (and doesn't warn about an
      // unresolved component). vue-tsc's template check is handled separately
      // by the GlobalComponents shim in src/emoji-picker.d.ts.
      template: { compilerOptions: { isCustomElement: (tag) => tag === 'emoji-picker' } },
    }),
    ...(httpsMode ? [basicSsl()] : []),
  ],
  // e2e disables HMR: the dev server is only serving a headless browser for one
  // run, and Vite 8's HMR websocket upgrade crashes the http server on Node 22
  // (shouldUpgradeCallback). No HMR ⇒ no ws upgrade ⇒ stable server.
  server: { https: httpsMode, hmr: httpsMode },
  preview: { https: httpsMode },
  test: {
    environment: 'node',
    exclude: ['node_modules/**', 'tests/e2e/**'],
  },
});
