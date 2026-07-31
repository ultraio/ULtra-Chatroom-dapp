// Installs a window.ultra mock implementing the provider surface (KB 06 §8)
// — @ultraos/wallet-sdk talks to this exactly as it would the real
// extension. signTransaction bridges to chain.ts via page.exposeFunction so
// it REALLY signs with the dev key and pushes to the seeded local chain.
import type { Page } from '@playwright/test';
import { pushAsDevKey, type RawAction } from './chain';

const MAINNET_CHAIN_ID = 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097';

export async function installMockWallet(page: Page, account: string, permission = 'active'): Promise<void> {
  await page.exposeFunction('__chatroomPushAction', async (actions: RawAction[]) => pushAsDevKey(actions));

  await page.addInitScript(
    ({ account, permission, chainId }) => {
      let trusted = false;
      (window as any).ultra = {
        async connect(params?: { onlyIfTrusted?: boolean }) {
          // Mirror a real extension: onlyIfTrusted (used by tryReconnect on
          // page load) only succeeds once the origin has been explicitly
          // trusted via a prior non-silent connect() — otherwise the
          // "Connect Wallet" button would never render for the test to click.
          if (params?.onlyIfTrusted && !trusted) {
            return { status: 'fail', message: 'origin not trusted', code: 4001 };
          }
          trusted = true;
          return {
            status: 'success',
            data: { selectedAccount: { accountName: account, permissions: [{ name: permission, publicKeys: [] }] } },
          };
        },
        async disconnect() {
          return { status: 'success', data: {} };
        },
        async getChainId() {
          return { status: 'success', data: chainId };
        },
        async getSelectedAccount() {
          return { status: 'success', data: { accountName: account, permissions: [{ name: permission, publicKeys: [] }] } };
        },
        async getNetwork() {
          return { status: 'success', data: { name: 'mainnet', chainId, nodeUrl: 'http://127.0.0.1:8888' } };
        },
        async signTransaction(actions: any[]) {
          const raw = actions.map((a: any) => ({
            account: a.contract,
            name: a.action,
            authorization: a.authorization,
            data: a.data,
          }));
          const result = await (window as any).__chatroomPushAction(raw);
          if (!result.ok) return { status: 'fail', message: result.error, code: 0 };
          return { status: 'success', data: { transactionHash: result.id, unsignedAuth: [] } };
        },
        on() {},
        off() {},
        once() {},
      };
    },
    { account, permission, chainId: MAINNET_CHAIN_ID },
  );
}
