// Thin passthrough around @ultraos/wallet-sdk (KB 06 §3.1) — no app state
// lives here, just the SDK singleton + availability guard.
import { UltraWalletSDK } from '@ultraos/wallet-sdk';
import type { BlockchainTransaction } from '@ultraos/wallet-sdk';

let sdk: UltraWalletSDK | null = null;

export function isAvailable(): boolean {
  return typeof window !== 'undefined' && !!(window as any).ultra;
}

function getSDK(): UltraWalletSDK {
  if (!isAvailable()) throw new Error('Ultra Wallet extension is not installed');
  if (!sdk) sdk = new UltraWalletSDK({ provider: 'extension' });
  return sdk;
}

export const connect = (params: Record<string, unknown> = {}) => getSDK().connect(params);
export const disconnect = () => getSDK().disconnect();
export const signTransaction = (actions: BlockchainTransaction[]) => getSDK().signTransaction(actions);
export const getSelectedAccount = () => getSDK().getSelectedAccount();
export const getNetwork = () => getSDK().getNetwork();
export const switchNetwork = (chainId: string) => getSDK().switchNetwork(chainId);
export const on = (...args: Parameters<UltraWalletSDK['on']>) => getSDK().on(...args);
export const off = (...args: Parameters<UltraWalletSDK['off']>) => getSDK().off(...args);
export const dispose = () => {
  if (sdk) {
    sdk.dispose();
    sdk = null;
  }
};
