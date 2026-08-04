# Deployment runbook

Steps 0–4 (local toolchain: compile, contract tests, seeded chain, Playwright
e2e) have been **run and verified end to end** on Windows, using the public
Docker image. Follow them in order — each one depends on the previous.

Step 5 (mainnet deploy) **has been executed.** The contract is live on Ultra
mainnet under account **`1aa2aa3aa4eo`** (code first set 2026-07-30). As of the
last check the deployed code is the **original** version — ABI exposes only the
`messages.a` and `senders.a` tables and no actions — and both tables are empty
(no messages posted yet). The `owner` and `active` permissions are held by the
same key, so a leaked `active` key is recoverable via `owner`, but there is no
hot/cold separation; guard that key accordingly (it is also moderation
authority — see the ban note below).

The **moderation + retention upgrade** in this repo (rolling 1000-message
window, `banned.a` table, owner-only `ban`/`unban`) has **not yet been pushed
to mainnet.** It is a non-breaking `set contract` + `set abi` over the live
account: `banned.a` is a new empty table and `ban`/`unban` are additive
actions, and no existing table struct changes, so it upgrades in place with no
migration. Because the live tables are currently empty, the prune path has no
backlog to drain on first write.

If you're an AI picking this up cold: run each command block, check its
"expected result" before moving to the next step, and if something doesn't
match, see "Gotchas already fixed in this repo" at the bottom before
re-deriving a fix — it's probably one of these.

## 0. Get the toolchain (public path, per KB `00` §3 / `02` §3)

```bash
docker pull quay.io/ultra.io/3rdparty-devtools:latest    # or pin :0.3.1

# Windows/git-bash only: MSYS_NO_PATHCONV=1 stops git-bash from mangling the
# absolute container paths below (e.g. turning /opt/... into a Windows path).
# Harmless to always include; not needed on Linux/macOS.
MSYS_NO_PATHCONV=1 docker run -dit --name ultra -p 8888:8888 -p 9876:9876 \
  -v ~/ultra_workdir:/opt/ultra_workdir quay.io/ultra.io/3rdparty-devtools:latest

docker exec ultra bash -lc ultra-smoke   # sanity check the image itself
```

The image ships `cdt-cpp` (CDT 4.1.1), `nodeos`/`cleos` (Savanna, mainnet-
matching), prebuilt system contracts at `/opt/eosio.contracts/build/contracts`,
and `@ultraos/ultratest2` preinstalled.

Copy this repo's `contracts/` and `ultratests/` directories into
`~/ultra_workdir` (i.e. the host folder you mounted above) so they're visible
inside the container at `/opt/ultra_workdir/contracts` and
`/opt/ultra_workdir/ultratests`:

```bash
cp -r contracts ultratests ~/ultra_workdir/
```

`ultratests/package.json` contains `file:<GLOBAL_ROOT>/...` placeholders that
must be resolved to the real path inside the container before `npm install`
works:

```bash
MSYS_NO_PATHCONV=1 docker exec ultra bash -lc '
  cd /opt/ultra_workdir/ultratests &&
  sed -i "s|<GLOBAL_ROOT>|/usr/local/lib/node_modules|g" package.json &&
  cp package.json chatroom/package.json
'
```

The `cp package.json chatroom/package.json` matters: ultratest2 requires a
`package.json` colocated with the spec file's own directory, not just in the
parent `ultratests/` folder.

## 1. Compile the contract

```bash
MSYS_NO_PATHCONV=1 docker exec ultra bash -lc '
  cd /opt/ultra_workdir/contracts/chatroom &&
  mkdir -p build && cd build &&
  cmake .. && make
'
```

Expected result: `build/chatroom.wasm` and `build/chatroom.abi` exist, and the
ABI contains the `messages.a`, `senders.a`, and `banned.a` tables, the
`on_transfer` notify handler, and the two owner-only actions `ban` / `unban`.
Re-deploying over the live contract is non-breaking: `banned.a` is a new empty
table and `ban`/`unban` are additive actions — no existing table struct
changes — so `set contract` + `set abi` upgrade in place with no migration.

## 2. Run the contract test suite (ultratest2)

```bash
MSYS_NO_PATHCONV=1 docker exec ultra bash -lc '
  cd /opt/ultra_workdir/ultratests &&
  npm install &&
  npx ultratest2 --contracts-dir-path=/opt/eosio.contracts/build/contracts \
    -t chatroom/chatroom.spec.ts
'
```

`--contracts-dir-path` must point at the **system** contracts (bios, token,
system) that ultratest2 needs to bootstrap the chain — not this repo's own
contract build output. Getting this backwards is the single most common
mistake here (see gotchas below).

Expected result: `chatroom.spec.ts` passes — the original message/flood-control
cases (post + id increment, empty/over-length/256-char memo, 5s cooldown,
day_count) plus the moderation cases (non-owner ban/unban rejected with
"missing authority", owner ban recorded in `banned.a`, banned account's
transfer reverts with "banned", idempotent re-ban, ban of a nonexistent
account and self-ban both revert, unban restores posting). Run this spec
against the **default (window = 1000) build** so its ~7 messages are never
pruned. If any fail, that's a real bug to fix before deploying, not a spec to
loosen.

**Prune / retention window** is a separate spec, `chatroom.prune.spec.ts`,
because it needs a small-window build (posting 1000+ messages through the 5s
cooldown is impractical — same rationale as the untested 50/day cap). Build a
throwaway variant and run it on its own:

```bash
MSYS_NO_PATHCONV=1 docker exec ultra bash -lc '
  cd /opt/ultra_workdir/contracts/chatroom &&
  rm -rf build && mkdir build && cd build &&
  cmake -DCHATROOM_MAX_ROOM_MESSAGES=3 .. && make &&
  cd /opt/ultra_workdir/ultratests && npm install &&
  npx ultratest2 --contracts-dir-path=/opt/eosio.contracts/build/contracts \
    -t chatroom/chatroom.prune.spec.ts
'
```

It asserts that at window = 3, ids climb 0→4 while the table holds at 3 rows,
the two oldest ids are erased (RAM refunded, not just paged past), and
`available_primary_key()` stays monotonic across deletions. **Rebuild without
`-DCHATROOM_MAX_ROOM_MESSAGES` before deploying** so mainnet gets the 1000
window — and don't run `chatroom.spec.ts` against the window=3 build (its
row-count assertions would break as messages get pruned). One build per spec.

**Do not skip this step to save time.** It's the only place the RAM-payer
rule (`get_self()` pays for every row, never the sender) gets exercised
against a real nodeos instance instead of just read on the page.

## 3. Seed a local keep-alive chain for manual QA / Playwright E2E

```bash
MSYS_NO_PATHCONV=1 docker exec ultra bash -lc '
  cd /opt/ultra_workdir/ultratests &&
  npx ultratest2 --contracts-dir-path=/opt/eosio.contracts/build/contracts \
    -t chatroom/e2e_setup.ts --keep-alive
' > /tmp/e2e_setup.log 2>&1 &
```

Run this in the background (or a separate terminal) — it stays alive on
purpose. It deploys the compiled contract to a fresh `chatroom1` account,
funds `alice`/`bob` with 10 UOS each, posts one starter message, then re-keys
both accounts' `active` permission to the well-known local dev key
(`EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV` — **local/dev only**,
never usable on a real network) so an external process (the Playwright mock
wallet) can sign as them.

Verify it worked:

```bash
MSYS_NO_PATHCONV=1 docker exec ultra cat /opt/ultra_workdir/e2e_setup.log   # or /tmp/e2e_setup.log, wherever you redirected
# expect: "Passed Test e2e_setup.ts" and "ULTRATEST2 EXIT: code=0"

curl -s http://127.0.0.1:8888/v1/chain/get_info   # expect a JSON response with an advancing head_block_num
```

If a previous `nodeos` is still bound to `:8888`, `pkill -x nodeos` first
(ultratest2 also does this on its own start).

## 4. Run Playwright e2e against the seeded chain

The chain seeded in step 3 must still be running for this step.

**One-time setting:** `dapp/src/config.ts`'s `CONTRACT_ACCOUNT` must
temporarily be `'chatroom1'` (matching the account `e2e_setup.ts` deploys to)
while testing locally. It ships as the live mainnet account `'1aa2aa3aa4eo'` —
flip it to `'chatroom1'` before running e2e, and flip it back to
`'1aa2aa3aa4eo'` afterward (see gotchas below for why this matters).

```bash
cd dapp
npm install
npx playwright install chromium   # first time only, if the browser binary isn't present
npm run test:e2e                  # Playwright — see playwright.config.ts
```

Expected result: both tests pass —
"connect, send a message, see it in the feed and on chain" and
"a message over the 256-character cap is rejected client-side, never reaches
the chain".

Frontend unit tests and build are independent of all of the above and can be
run in any plain Node environment at any time:

```bash
cd dapp
npm run build   # vue-tsc --noEmit && vite build
npm test        # vitest
```

## 5. Deploy to mainnet

**Correction (2026-07-28, per KB `08` rev. 2026-07-28):** earlier versions of
this doc said mainnet deployment requires a Pro Wallet specifically plus
KYC/KYB to lift a 10 KB pre-KYC RAM cap, and named that the pipeline's real
bottleneck. That was wrong. **Deploying a contract on Ultra mainnet is
permissionless** — no special account type, no KYC/KYB gate, no on-chain
setcode whitelist. Any account with enough UOS to buy RAM can `set contract`.
The mechanics below are otherwise identical to the local/testnet runs earlier
in this doc — only the `-u` endpoint and chain ID change.

### 5a. If you don't already have a funded Ultra account

1. **Install the Ultra browser extension** and click **Add Ultra Account**
   (or log in if you already have one) — this gives you a free **Ultra
   Account (EBA)** backed by a real blockchain account. No cost, no approval.
2. **Buy UOS.** In the extension, click **Buy UOS** → redirects to **Simplex**
   (card payment) if your country/card is supported. If not, buy **ERC-20
   UOS on Uniswap** (Ethereum) and move it over with the **Ultra bridge**.
3. **(Recommended) Upgrade to an Ultra Pro Wallet.** Either account type can
   deploy a contract — the difference is key recovery, not permission:
   - **EBA:** `owner` permission is null — you can sign with `active`, but
     can't rotate it, so a leaked `active` key can't be reset.
   - **Pro Wallet:** you hold both `owner` and `active` → if `active` leaks,
     reset it with `owner` (`cleos set account permission <acct> active …`).
     Worth doing for anything you intend to keep live.
   - In the extension: **Create an Ultra Pro Wallet** (~2 USD in UOS,
     oracle-priced). Programmatic equivalent from an existing funded account:
     `cleos push action eosio newnonebact '{"creator":"<payer>","owner":{...},
     "active":{...},"max_payment":"1.00000000 UOS"}' -p <payer>`.
   Account names are auto-generated either way — you don't get to choose one,
   only the local `contract("chatroom")` identifier in the source is under
   your control.
4. **Export the deploying account's private key**: extension → **Menu →
   Export Private Key**. Treat it as a secret — see the handling note below.

### 5b. Deploy

1. **Load the key into `cleos`'s wallet** (same `keosd` setup you'd use
   locally, just against the real key):
   ```bash
   keosd --unlock-timeout=86400 &                          # keep it unlocked for the session
   cleos wallet create --to-console                        # SAVE the password it prints
   cleos wallet import --private-key "$ULTRA_ACTIVE_KEY"   # read from env, never typed/logged literally
   ```
   **Key handling:** put the key in a local `.env` (`ULTRA_ACTIVE_KEY=...`),
   add `.env` to `.gitignore`, and reference it only via the environment
   variable as above. If an AI agent is driving this step, tell it explicitly
   to never read, print, log, or echo `.env`'s contents — it should reference
   the value through the environment only. Never paste a mainnet private key
   into a chat, a commit, or a shell command that gets logged.
2. **Buy RAM** for the account (`cleos push action eosio buyrambytes ...`).
   Size for the wasm/ABI plus room for the table to grow — see "RAM growth is
   unbounded" below for how to think about sizing.
3. **Deploy** (chatroom has no inline actions, so no `eosio.code` permission
   is needed):
   ```bash
   cleos -u <mainnet-rpc> set contract <your-account> \
     ./contracts/chatroom/build/chatroom.wasm ./contracts/chatroom/build/chatroom.abi \
     -p <your-account>@active
   ```
4. **Verify:** `cleos get account <your-account>` (check `ram_usage` vs
   `ram_quota`), then `cleos get table <your-account> <your-account>
   messages.a` to confirm the table exists and is empty.
5. **Point the dapp at it:** `dapp/src/config.ts` already sets
   `CONTRACT_ACCOUNT = '1aa2aa3aa4eo'` (the current live account). Only change
   this if you deploy to a different account — set it to that account name.

## RAM growth & moderation (resolved — was flagged as an open question)

**RAM growth is bounded by a rolling retention window.** Each message is a row
in `messages.a`, paid for by the contract account's own RAM (never the
sender's — Ultra's notify-context rule, KB `03` §5.1). To keep that RAM bill
from growing without limit, the contract retains only the most recent
`MAX_ROOM_MESSAGES` (1000) rows room-wide: on each write it prunes rows whose
id is more than 1000 behind the newest (see `on_transfer`). Pruning is capped
at `PRUNE_BATCH` (20) erases per message so the first write after this upgrade
can't try to delete a large pre-existing backlog in one oversized transaction
(which would exceed the CPU limit, revert the transfer, and wedge posting); any
backlog drains a few rows per message until steady state (delete 1 / add 1).
Erased rows refund RAM to the contract, so at steady state the RAM footprint is
flat at ~1000 rows regardless of total lifetime volume or account count.

Moderation is separate: `ban`/`unban` are owner-only actions (they
`require_auth` the contract account). A banned account is rejected in
`on_transfer` (so it can't post and stops consuming RAM), and the dapp reads
`banned.a` to hide that account's already-stored messages until they scroll out
of the 1000-row window. Banning does not delete on-chain data — it can't; chain
history is public and immutable, this only stops new posts and hides old ones
in the official UI. Because the ban is enforced by signing with the contract
account's `active` key, custody of that key is now also moderation authority —
see the key-handling note in §5.

## Gotchas already fixed in this repo (context if something looks off)

These were real bugs found by actually running the pipeline, not
hypotheticals — the fixes are already applied in the current source, listed
here so nobody "fixes" them again or reverts them by accident:

- **`chatroom.hpp`** needed `#include <eosio/system.hpp>` for
  `current_time_point()` — CDT declares it there, not in `eosio/time.hpp`.
- **`ultratests/chatroom.spec.ts` / `e2e_setup.ts`**: `publishContract`'s
  relative path resolves from the spec file's own directory, so it must be
  `'../../contracts/chatroom/build/'`, not `'../../build/contracts/chatroom/'`.
- **`chatroom.spec.ts`** setup case didn't fund alice/bob before the transfer
  tests, causing "overdrawn balance" — added
  `ultraAPI.token.transferTokens('ultra.eosio', 'alice'/'bob', 10)`.
- **`chatroom.spec.ts`**'s over-length-memo test expected our contract's own
  "message too long" revert, but `eosio.token` itself enforces a 256-byte memo
  cap and rejects it first — the test now expects "memo has more than 256
  bytes" (our own check is real but unreachable in practice for the >256
  case).
- **`e2e_setup.ts`**: `updateAuth` lives directly on `ultraAPI` (not
  `ultraAPI.system`) and takes positional args `(account, permission, parent,
  threshold, keys, accounts)`, not an auth object.
- **`dapp/src/connection.ts`**: `refreshFromWallet()` ignored the
  wallet-reported `nodeUrl` field entirely, contradicting its own header
  comment that the wallet is the source of truth for network. Fixed to try
  the wallet's `nodeUrl` first, falling back to the static `NETWORKS` list.
- **`dapp/tests/e2e/mockWallet.ts`**: was missing a `getChainId()` method —
  `@ultraos/wallet-sdk`'s `ExtensionProvider.connect()` calls
  `walletProvider.getChainId()` *before* its own `connect()`, so without it
  every connect attempt threw silently.
- **`dapp/tests/e2e/mockWallet.ts`**: `connect()` also ignored the
  `onlyIfTrusted` param and always succeeded, so `App.vue`'s
  `onMounted → tryReconnect()` auto-connected on every page load and the
  "Connect Wallet" button the tests click on never rendered. Fixed to track a
  `trusted` flag and only satisfy `onlyIfTrusted` after an explicit connect.
- **`dapp/vite.config.ts`**: `vitest run` was picking up the Playwright spec
  under `tests/e2e/` and crashing (Playwright's `test()` isn't valid inside
  Vitest) — fixed with `test.exclude: ['node_modules/**', 'tests/e2e/**']`.
- **`dapp/src/config.ts`**'s `CONTRACT_ACCOUNT` is the live mainnet account
  `'1aa2aa3aa4eo'` — it must be temporarily set to `'chatroom1'` for local e2e
  runs (step 4) and reverted to `'1aa2aa3aa4eo'` afterward. Leaving it on
  `'chatroom1'` after testing will cause `eosio.token::transfer` to fail with
  "to account does not exist" once someone runs the app against mainnet, where
  `chatroom1` isn't a real account.
