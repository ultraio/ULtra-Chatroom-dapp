# Onchain Chat Room (Ultra mainnet)

A single-room, wallet-only chat dapp. Every message is an `eosio.token::transfer`
to a purpose-built `chatroom` contract with the message text as the memo; the
contract records it in an onchain table. There is no backend, no database, and
no localStorage — closing and reopening the app rebuilds the feed from chain
reads alone, per `ultra-chatroom-dapp-brief.md`. The contract keeps a rolling
window of the most recent 1000 messages room-wide (older rows are pruned on
write to bound RAM), so the rebuilt feed is that retained window, not all
history ever sent.

## Layout

```
contracts/chatroom/     Antelope C++ contract (on_notify handler + messages.a table)
ultratests/chatroom/    ultratest2 spec suite + keep-alive E2E chain seeder
dapp/                   Vue 3 + Vite + TypeScript frontend
dapp/tests/e2e/         Playwright E2E scaffold (drives the seeded keep-alive chain)
```

## How it works

1. User connects via `@ultraos/wallet-sdk` (`window.ultra`, per KB `06`).
2. Sending a message = one `eosio.token::transfer` from the user to the
   `chatroom` contract account, `0.00000001 UOS` (the minimum positive amount
   at 8 decimals — pure postage, the quantity itself is meaningless), memo =
   the message text.
3. The contract's `on_notify("eosio.token::transfer")` handler
   (`contracts/chatroom/src/chatroom.cpp`) validates the transfer is real
   (guards against spoofed notifications, only accepts UOS, rejects empty or
   >256-character memos) and appends a row to `messages.a`, paid for out of
   the contract's own RAM (Ultra's notify-context rule: a contract may only
   bill *itself*, never the sender — KB `03` §5.1).
4. The frontend reads `messages.a` via `get_table_rows` on load, then polls
   for new rows every second (`POLL_INTERVAL_MS`, matched to Ultra's ~500ms
   block time / ~1s Savanna finality) using `lower_bound` on the primary key
   so each poll only fetches the new tail, not a full re-scan.

## Design decisions not dictated by the chain

The brief called out two things explicitly to confirm rather than guess, and
one project-level choice the user made directly:

- **No protocol-level memo length limit exists** for `eosio.token::transfer`
  (checked against the full KB — nothing in `01`, `03`, or `11` documents one).
  The 256-character cap is a **contract-enforced product decision**, not a
  discovered chain fact — see `MAX_MSG_LEN` in `chatroom.hpp` and
  `MAX_MESSAGE_LENGTH` in `dapp/src/config.ts` (kept in sync manually; there's
  no shared source between C++ and TS here).
- **Feed reconstruction is via a custom contract + table**, not by scanning
  token-transfer history/an indexer. This was a user choice between two valid
  options: it costs more upfront (a real contract to write, test, and deploy,
  requiring KYC — see `DEPLOYMENT.md`) but reads back deterministically from
  any RPC node with a single `get_table_rows` call, with no dependency on
  Hyperion/history-plugin availability or indexing lag.
- **Target network is mainnet.** `dapp/src/config.ts` only defines a
  `mainnet` `NetworkConfig`; there is no testnet fallback wired in.

## What's verified vs. not, in this sandbox

This sandbox has Node v24.15.0 / npm 11.14.1 only — **no Docker, no CDT, no
nodeos**. That splits the deliverables into two honesty tiers:

| Verified here | Not verified here (needs the toolchain — see `DEPLOYMENT.md`) |
| --- | --- |
| `npm install`, `npm run build` (`vue-tsc --noEmit && vite build`) — clean | Contract compiles with `cdt-cpp` |
| `npm test` (vitest) — 8/8 passing, covers `chatMath.ts` message validation | `ultratests/chatroom/chatroom.spec.ts` actually passes against a live chain |
| Standalone `tsc --noEmit` typecheck of the Playwright E2E scaffold — clean | Playwright E2E (`dapp/tests/e2e/*`) actually drives a seeded chain end to end |
| Manual read-through of the contract logic and ultratest2 spec | The contract's RAM/notify behavior under a real nodeos |

Every file that falls in the right-hand column has an
`// UNVERIFIED IN THIS SANDBOX` comment at the top pointing at the KB section
that documents the pattern it follows, so nothing is silently assumed correct.

## Quick start (on a machine with the full toolchain)

See `DEPLOYMENT.md` for the complete, ordered runbook (build → test → deploy →
configure the dapp → run E2E). Short version once the contract is deployed:

```bash
cd dapp
npm install
npm run dev        # local dev server against config.ts's mainnet endpoints
npm test           # vitest unit tests (chatMath)
npm run build      # typecheck + production build
npm run test:e2e   # Playwright, requires a seeded --keep-alive local chain (see DEPLOYMENT.md)
```

## Explicit v1 scope (per the brief)

No replies/threads, no reactions, no profiles beyond the wallet address, no
multiple rooms, no edit/delete, no moderation, no rich media/link previews.
This is intentionally disposable — a proof point that Ultra can run a live,
always-on, fully onchain dapp, not a maintained product.
