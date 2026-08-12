// Live mainnet account (code first set 2026-07-30, see ../../DEPLOYMENT.md §5).
// Local dev + Playwright e2e run against the account e2e_setup.ts deploys to
// (`chatroom1`), so DEV-branch it the same way nodeUrls / TIP_BADGE_MIN_ID do —
// this removes the old manual "flip to chatroom1 then flip back" footgun. The
// production build (import.meta.env.DEV === false) always ships '1aa2aa3aa4eo'.
export const CONTRACT_ACCOUNT = import.meta.env.DEV ? 'chatroom1' : '1aa2aa3aa4eo';

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

// Reserved command prefix, mirrored from the contract (chatroom.hpp TIP_PREFIX).
// A message whose memo starts with this is a verified, contract-forwarded tip.
export const TIP_PREFIX = '/tip ';

// Upgrade boundary for the "verified tip" badge. The contract only started
// reserving the "/tip " prefix when the tip-capable contract went live, so a
// "/tip " row is a genuine tip ONLY if its id is above the highest id that
// existed at that moment. The feed badges a "/tip " row iff its id exceeds this.
// Dev chains start empty (every row is post-upgrade) → -1 badges all.
//
// ⚠️ DEPLOY STEP: set the production value to the max messages.a id captured
// immediately after `set contract` on mainnet (see DEPLOYMENT.md). Placeholder
// 17 = the live max id observed 2026-08-13, before the tip contract is deployed;
// re-capture at deploy. Capturing slightly early only ever under-badges a few
// genuine early tips — it can never badge a forgery.
export const TIP_BADGE_MIN_ID = import.meta.env.DEV ? -1 : 17;

// Ultra: 500ms blocks / ~1s Savanna finality (KB 01 §1) — poll close to that
// cadence without hammering the RPC on every render tick.
export const POLL_INTERVAL_MS = 1000;

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
