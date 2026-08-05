// App state + wallet sync (KB 05 §4 / 06 §3.2-3.4). The wallet is the
// source of truth for account + network; this module never picks either.
import { reactive } from 'vue';
import { APIClient } from '@wharfkit/antelope';
import * as wallet from './ultraWallet';
import { NETWORKS, matchNetwork, type NetworkConfig } from './config';

export interface ConnectionState {
  walletAvailable: boolean;
  connected: boolean;
  account: string;
  permission: string;
  chainId: string;
  network: NetworkConfig | undefined;
  networkMismatch: boolean;
  syncing: boolean;
  busy: boolean;
  error: string;
}

export const state: ConnectionState = reactive({
  walletAvailable: false,
  connected: false,
  account: '',
  permission: 'active',
  chainId: '',
  network: undefined,
  networkMismatch: false,
  syncing: false,
  busy: false,
  error: '',
});

let client: APIClient | null = null;

function buildClient(nodeUrls: string[]): APIClient {
  // @wharfkit/antelope takes one url; failover is handled by us re-pointing
  // on read failure rather than a built-in pool (KB 07 §4: "always carry a
  // fallback endpoint list and rotate on failure").
  return new APIClient({ url: nodeUrls[0] });
}

export function getClient(): APIClient {
  if (!client) client = buildClient(NETWORKS[0].nodeUrls);
  return client;
}

export async function rotateClientOnFailure(): Promise<void> {
  const urls = state.network?.nodeUrls ?? NETWORKS[0].nodeUrls;
  const current = (client as any)?.url as string | undefined;
  const idx = current ? urls.indexOf(current) : -1;
  const next = urls[(idx + 1) % urls.length];
  client = buildClient([next, ...urls.filter((u) => u !== next)]);
}

async function refreshFromWallet(): Promise<void> {
  const account = await wallet.getSelectedAccount();
  if (account.status === 'success' && account.data) {
    state.connected = true;
    state.account = (account.data as any).accountName ?? '';
    const perms = (account.data as any).permissions;
    state.permission = perms?.[0]?.name ?? 'active';
  }

  const net = await wallet.getNetwork();
  if (net.status === 'success' && net.data) {
    const data = net.data as any;
    state.chainId = data.chainId ?? '';
    const matched = matchNetwork(state.chainId);
    state.network = matched ?? NETWORKS[0];
    state.networkMismatch = !matched;
    if (!state.networkMismatch) {
      // The wallet is the source of truth for network (see file header) —
      // try its reported RPC first, with the static list as failover.
      const walletUrl = data.nodeUrl as string | undefined;
      const urls = walletUrl
        ? [walletUrl, ...state.network.nodeUrls.filter((u) => u !== walletUrl)]
        : state.network.nodeUrls;
      client = buildClient(urls);
    }
  }
}

export async function connect(): Promise<void> {
  state.error = '';
  const res = await wallet.connect({});
  if (res.status !== 'success') {
    state.error = res.message || 'Connection was declined.';
    return;
  }
  await refreshFromWallet();
}

function resetConnectionState(): void {
  state.connected = false;
  state.account = '';
  state.chainId = '';
  state.network = undefined;
}

export async function disconnect(): Promise<void> {
  try {
    await wallet.disconnect();
  } finally {
    resetConnectionState();
  }
}

export async function tryReconnect(): Promise<void> {
  if (!wallet.isAvailable()) return;
  try {
    const res = await wallet.connect({ onlyIfTrusted: true });
    if (res.status === 'success') await refreshFromWallet();
  } catch {
    // origin not yet trusted — normal, not an error
  }
}

export function initWalletSync(): void {
  state.walletAvailable = wallet.isAvailable();
  if (!state.walletAvailable) return;

  wallet.on('accountChanged', async () => {
    // Never trust the event payload directly — re-query the truth.
    await refreshFromWallet();
  });

  wallet.on('networkChanged', async () => {
    if (state.syncing) return;
    state.syncing = true;
    try {
      await refreshFromWallet();
    } finally {
      state.syncing = false;
    }
  });

  wallet.on('disconnect', resetConnectionState);
}

export function teardownWalletSync(): void {
  wallet.dispose();
}

export function auth(): { actor: string; permission: string }[] {
  return [{ actor: state.account, permission: state.permission }];
}

export async function signAndPush(actions: Array<Record<string, unknown>>): Promise<string> {
  state.busy = true;
  try {
    const res = await wallet.signTransaction(actions as any);
    if (res.status !== 'success') {
      throw new Error(res.message || (res.code === 4001 ? 'You declined the transaction.' : 'Transaction failed.'));
    }
    if ((res.data as any)?.unsignedAuth?.length) {
      throw new Error('Transaction was only partially signed.');
    }
    return (res.data as any).transactionHash as string;
  } finally {
    state.busy = false;
  }
}
