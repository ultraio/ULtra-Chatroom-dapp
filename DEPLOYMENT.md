# Deployment runbook

Steps 0–4 (local toolchain: compile, contract tests, seeded chain, Playwright
e2e) have been **run and verified end to end** on Windows, using the public
Docker image. Follow them in order — each one depends on the previous. Step 5
(mainnet deploy) has not been executed — it's permissionless and mechanically
identical to steps 0-4, just against the real endpoint (see the correction
at the top of that section).

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
ABI contains the `messages.a` table and no public actions (only the
`on_transfer` notify handler).

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

Expected result: all 6 cases in `chatroom.spec.ts` pass — setup, alice posts
(id 0), bob posts (id 1), empty memo reverts, over-length memo reverts,
exactly-256-char memo accepted (boundary case). If any fail, that's a real bug
to fix before deploying, not a spec to loosen.

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
while testing locally. It ships as the placeholder
`'REPLACE_WITH_DEPLOYED_ACCOUNT'` — flip it to `'chatroom1'` before running
e2e, and flip it back afterward (see gotchas below for why this matters).

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
5. **Point the dapp at it:** edit `dapp/src/config.ts`, replace
   `CONTRACT_ACCOUNT = 'REPLACE_WITH_DEPLOYED_ACCOUNT'` with the real deployed
   account name.

## Open question the brief asked to flag, not silently work around

**RAM growth is unbounded.** Every message permanently adds one row to
`messages.a`, paid for by the contract account's own RAM (never the sender's
— Ultra's notify-context rule, KB `03` §5.1), and v1 has no delete/expiry by
design (brief: "No editing or deleting messages once sent"). For a
disposable proof-of-concept this is fine at low volume, but it means the
contract account's RAM bill grows monotonically with usage and must be
topped up manually (RAM is refundable via `refundram` if the contract is ever
decommissioned, but there's no automatic reclaiming while it's live). This
wasn't papered over with, e.g., a message TTL or a max-row cap, because
nothing like that was in the brief or the KB as a chain-level answer — if
usage were expected to be more than trivial, this is the first thing to
revisit, and it should be a product decision (cap total messages? paginate
and archive old ones off-contract? accept the RAM cost as the price of "just
the chain, no backend"?), not something to decide unilaterally here.

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
- **`dapp/src/config.ts`**'s `CONTRACT_ACCOUNT` is a placeholder by design
  (see step 5.6) — it must be temporarily set to `'chatroom1'` for local e2e
  runs (step 4) and reverted to `'REPLACE_WITH_DEPLOYED_ACCOUNT'` afterward.
  Leaving it on `'chatroom1'` after testing looks like a real deployed
  account and will cause `eosio.token::transfer` to fail with "to account
  does not exist" once someone runs the app against a chain where
  `chatroom1` isn't the seeded test account.
