import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  // Ultra Wallet's content script only matches "https://*/*" (checked its
  // manifest directly) — plain http://localhost never gets window.ultra
  // injected. basicSsl serves a self-signed cert locally so the extension
  // fires; the browser will show a one-time cert warning to click through.
  plugins: [
    vue({
      // <emoji-picker> (from emoji-picker-element) is a custom element, not a
      // Vue component — tell the compiler so it renders it natively and binds
      // @emoji-click as a real DOM event listener (and doesn't warn about an
      // unresolved component). vue-tsc's template check is handled separately
      // by the GlobalComponents shim in src/emoji-picker.d.ts.
      template: { compilerOptions: { isCustomElement: (tag) => tag === 'emoji-picker' } },
    }),
    basicSsl(),
  ],
  server: { https: true },
  preview: { https: true },
  test: {
    environment: 'node',
    exclude: ['node_modules/**', 'tests/e2e/**'],
  },
});
