// Deployed to mainnet 2026-07-30 (see ../../DEPLOYMENT.md §5).
export const CONTRACT_ACCOUNT = '1aa2aa3aa4eo';

export const TOKEN_CONTRACT = 'eosio.token';
export const UOS_SYMBOL = 'UOS';
export const UOS_PRECISION = 8;
export const MESSAGES_TABLE = 'messages.a';
export const BANNED_TABLE = 'banned.a';

// The minimum positive amount eosio.token::transfer allows at 8 decimals —
// used as fixed "postage" so the user only ever has to think about the text.
export const POSTAGE_QUANTITY = '0.00000001 UOS';

// Contract-enforced cap (see contracts/chatroom — no protocol-level memo
// limit exists to discover; this is our own design choice, mirrored here).
export const MAX_MESSAGE_LENGTH = 256;

// Ultra: 500ms blocks / ~1s Savanna finality (KB 01 §1) — poll close to that
// cadence without hammering the RPC on every render tick.
export const POLL_INTERVAL_MS = 1000;

// Some wallets never resolve or reject signTransaction() if their approval
// popup is closed directly instead of an explicit Decline click — without a
// bound, the send button would stay disabled forever (see connection.ts).
export const SIGN_TIMEOUT_MS = 120_000;

export interface NetworkConfig {
  name: string;
  chainId: string;
  nodeUrls: string[]; // first = primary, rest = failover (KB 07 §4)
}

// Mainnet only, per the chosen build target. cryptolions is deliberately
// excluded from the rotation — the KB flags it as a spare that silently
// IP-bans, never a primary.
export const NETWORKS: NetworkConfig[] = [
  {
    name: 'mainnet',
    chainId: 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097',
    nodeUrls: [
      // import.meta.env.DEV is a Vite build-time constant — this branch is
      // dead-code-eliminated from production builds, so it can never point a
      // real deploy at the local chain. Without it, reads before wallet
      // connect hit these public mainnet URLs (which don't have the local
      // test account), so the feed loads empty until the wallet's own
      // nodeUrl is swapped in post-connect.
      ...(import.meta.env.DEV ? ['http://127.0.0.1:8888'] : []),
      'https://api.mainnet.ultra.io',
      'https://ultra.eosphere.io',
      'https://ultra.eosrio.io',
      'https://ultra.eosusa.io',
      'https://api.ultra.eossweden.org',
    ],
  },
];

export function matchNetwork(chainId: string): NetworkConfig | undefined {
  return NETWORKS.find((n) => n.chainId === chainId);
}
