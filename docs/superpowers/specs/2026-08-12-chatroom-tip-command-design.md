# Chatroom `/tip` command — design

- **Date:** 2026-08-12
- **Status:** Approved (brainstorming) — revised after adversarial review + on-chain
  verification; ready for implementation plan
- **Scope:** Add a `/tip <receiver> <amount> [note]` command to the on-chain
  chatroom. Sending it transfers UOS to `receiver` **and** records the message
  in the feed, in one atomic on-chain transaction, with the tip made
  **contract-verified** so a recorded tip can never be faked.

---

## 1. Motivation

A chatroom message is an `eosio.token::transfer` of a fixed "postage" amount
(`0.00000001 UOS`) to the contract, whose memo IS the message text
(`contracts/chatroom/src/chatroom.cpp` `on_transfer`).

A tip should move real UOS to a third party and also show up in the feed. The
naive design bundles two independent `transfer` actions client-side (tip →
receiver, postage → contract). It was rejected because it is **fakeable**: the
contract is not a party to the tip transfer, so it cannot tell a postage message
that says *"tipped 5 UOS to bob"* from one that actually paid bob. Anyone
hand-crafting a raw transaction (bypassing the dapp UI) could post the receipt
text with **no tip attached**.

The fix is to make the **contract itself** move the money: the user transfers to
the chatroom, the chatroom forwards the payment to the receiver in the same
transaction, and the message is committed atomically with the forward.

## 2. Trust model — the reserved-prefix invariant (+ upgrade boundary)

The contract **reserves the `/tip ` memo prefix**. Any inbound transfer whose
memo starts with `/tip ` is forced down the tip path, which:

1. requires a valid `receiver`, a strictly well-formed `amount`, and a `note`;
2. requires the **stated amount to equal the amount actually received**
   (`parse_uos(amount) == quantity`);
3. inline-forwards the full `quantity` to `receiver`;
4. commits the message row atomically with that forward.

Any of these failing reverts the whole transaction (see §3.3 for why the
forward's atomicity is by transaction rollback, not synchronous ordering).

**The upgrade boundary (critical — see B1 in review).** The *currently deployed*
contract stores **any** memo verbatim as long as it is exactly postage-sized
(`chatroom.cpp:14`) and ≤256 bytes (`chatroom.cpp:15-16`) — there is **no prefix
reservation today**. So a `/tip bob 5000 lol` memo can be posted **right now** for
dust, with no funds moved, and would sit in `messages.a` as ordinary text. If the
new dapp badged `/tip `-prefixed rows purely by content, every such pre-upgrade
row (and any innocent chat line that happens to start with `/tip `) would be
rendered as a forged "verified tip". Content alone **cannot** discriminate across
the boundary, because anything the new contract writes, a user could also have
typed as plain text under the old contract.

The discriminator is **position in the monotonic id sequence**. Message ids come
from `available_primary_key()` and never decrease or repeat, even across erases
(`chatroom.cpp:64`, and the retention comment `chatroom.cpp:74-78`). At deploy we
capture `TIP_BADGE_MIN_ID` = the highest message id present the moment the
tip-capable contract goes live. After that moment the prefix is reserved, so **no
forged `/tip ` row can be created**. Therefore:

> **A stored message that (a) begins with `/tip ` and (b) has `id > TIP_BADGE_MIN_ID`
> is, by contract construction, always a real forwarded tip whose displayed
> amount equals the amount paid.** The dapp badges only such rows; everything
> else — including any pre-boundary `/tip ` row — renders as plain text.

Capturing the boundary slightly early is fail-safe: it can only *under*-badge a
few genuine early tips (they render as plain text), never *over*-badge a forgery.
No new table columns and no accounting are needed — the message row stays exactly
`id, sender, text, sent_at`.

*(Alternative considered and rejected: rename the table to `messages.b` so it
starts empty and the invariant is absolute with no boundary constant. Rejected
because it discards visible chat history on deploy; the id high-water-mark is
non-destructive and equally sound.)*

## 3. Contract changes (`contracts/chatroom`)

Single `on_transfer` handler, single `messages.a` table — no schema change.

```
on_transfer(from, to, quantity, memo):
  if from == self or to != self: return          # unchanged: inbound only,
                                                  #   and absorbs our own forward's
                                                  #   self-notification (from==self)
  check first_receiver == eosio.token             # unchanged
  check quantity.symbol == UOS                     # unchanged (pins symbol before == below)
  check 0 < memo.size() <= MAX_MSG_LEN             # unchanged (256 bytes)
  check not banned(from)                           # unchanged
  ...cooldown + daily flood control...             # unchanged, applies to tips too

  if memo starts with "/tip ":                     # NEW tip branch
      (receiver, amount_str, note) = parse_tip(memo)         # canonical tokenizer (§3.1)
      check(is_account(receiver), "chatroom: tip recipient does not exist")   # SYNCHRONOUS — see §3.3
      check(receiver != from,     "chatroom: cannot tip yourself")
      check(receiver != self,     "chatroom: cannot tip the room")
      check(parse_uos(amount_str) == quantity,
            "chatroom: tip amount does not match the transfer")               # §1 requirement
      # forward the full received amount to the receiver
      inline eosio.token::transfer(
          self -> receiver, quantity,
          note.empty() ? "Tip via Ultra Chat" : note)                        # needs eosio.code
  else:                                            # normal message, unchanged
      check quantity.amount == POSTAGE_AMOUNT

  emplace message { id, sender: from, text: memo, sent_at: now }   # verbatim, unchanged
  ...retention prune...                            # unchanged
```

### 3.1 Memo grammar + canonical tokenizer (contract and dapp MUST match)

`/tip <receiver> <amount> [note]`

- Tokenize by **runs of ASCII space** (`0x20`): skip the leading `/tip ` marker,
  then token 1 = `receiver`, token 2 = `amount`, and `note` = the **verbatim
  remainder** of the memo after the amount token ends (leading spaces trimmed;
  interior formatting preserved). Both the contract `parse_tip` and the dapp's
  prettify/validation use this identical rule (review L2) so receiver/amount/note
  can never render differently than what was forwarded.
- `receiver` — a legal eosio/Ultra account name (`[.1-5a-z]{1,12}`).
- `amount` — a plain decimal (`5`, `5.5`, `0.25`), **no symbol suffix**, parsed by
  the strict grammar in §3.2.
- `note` — remainder (may be empty).

The whole memo is stored verbatim as the message text; the dapp prettifies it at
render (§4.5). Example stored text: `/tip bob 5 gg well played`.

### 3.2 `parse_uos` — strict grammar (contract-side C++; dapp mirrors it byte-for-byte)

Parse `amount_str` into an `int64` at 8-decimal fixed point and build
`asset{value, UOS_SYM}`. **Reject** (assert → revert) anything not matching
`^[0-9]+(\.[0-9]{1,8})?$` (review H2):

- empty, or any character outside `[0-9.]`, or a `+`/`-` sign;
- more than one `.`; a leading `.` (`.5`) or trailing `.` (`5.`); no integer digit;
- more than 8 fractional digits;
- an integer value that overflows `int64` (explicit bounds check).

Right-pad the fractional part to exactly 8 digits, concatenate, convert to
`int64`. Because the equality check is exact (`== quantity`, not `>=`) and the
symbol is pinned first (`chatroom.cpp:13`), `asset::operator==` reduces to the
int64 amount: the receiver gets exactly the number shown and the contract keeps
zero. Strict parsing matters for **display too**, not just funds — a lenient
parser (e.g. `stoll("5abc")→5`) would forward 5 yet store `/tip bob 5abc`, which
the badge would then render as "5abc UOS". There is deliberately **no** lower
bound tied to `POSTAGE_AMOUNT`; a `0.00000001` tip is legal. The
`== POSTAGE_AMOUNT` assert now applies **only** to the non-tip branch.

### 3.3 Ordering, atomicity, and no stranded funds

`chatroom.hpp:38-41` warns the contract has **no withdraw action** — anything it
keeps is permanent. The tip branch keeps **zero**, but the mechanism is
transaction atomicity, not synchronous ordering (review M2): `action.send()`
**queues** the forward to run *after* `on_transfer` returns, so the `emplace`
actually executes *before* the forward does. If the queued forward asserts
(overdrawn balance `eosio.token.cpp:150`, or `to account does not exist`
`eosio.token.cpp:85`), the **entire transaction reverts** — the emplace and the
user→contract transfer included. There is no path where the contract accepts a
tip and retains it. The **synchronous** `is_account(receiver)` check is therefore
load-bearing: it produces a clean early revert with our own message instead of a
late, muddier eosio.token assert. The existing `from == self` early-return
(`chatroom.cpp:7`) absorbs the forward's self-notification, so there is no
re-entrancy or double-record (verified: forward triggers `require_recipient(from=self)`,
`eosio.token.cpp:90`, which re-enters and returns immediately).

### 3.4 Header comment update

The `POSTAGE_AMOUNT` comment (`chatroom.hpp:38-41`) currently justifies rejecting
larger transfers ("a bundled tip action … fails loudly instead of getting
silently stranded"). Update it: larger transfers are now accepted **only** on the
`/tip ` path and are always forwarded in the same tx, never stranded.

### 3.5 External dependency — UOS must not carry a transfer tax/burn

Ultra's `eosio.token::transfer` supports a per-symbol tax/burn config
(`eosio.token.cpp:98-138`): when a `tokenconfig` row exists for the symbol, the
recipient is credited only `actual_quantity = quantity − tax`, while the
**notification** to the recipient still carries the **original** `quantity`
(`require_recipient` fires with the action's original args, `eosio.token.cpp:90-91`).
Under an active tax, the chatroom would see `quantity`, pass the amount check, but
have received only `actual_quantity`, so `sub_balance(self, quantity)` would
revert every tip with "overdrawn balance" (`eosio.token.cpp:150`).

**Verified inactive on mainnet (2026-08-12):** `get_table_rows(code=eosio.token,
scope=UOS, table=tokenconfig)` returns `[]`; scope encoding proven by the `stat`
table at scope `UOS` returning the live supply (`1,018,418,774.28329134 UOS`). So
`config == end()` → `actual_quantity == quantity` and the design works today. This
is an **external dependency**, not something the chatroom controls: if `eosio`
ever runs `configtax`/`configburn` on UOS, all tips break. Document it; do not
attempt to "fix" it in-contract (adjusting the forward to `actual_quantity` would
also break the displayed-==-paid guarantee).

## 4. Dapp changes (`dapp/src`)

The dapp sends **one** action — `transfer(me → contract, <amount> UOS,
memo="/tip …")` — and does client-side parsing only for early validation/UX. The
contract is the authority.

### 4.1 `config.ts`

- `TIP_PREFIX = '/tip '`.
- `TIP_BADGE_MIN_ID` — the message-id high-water-mark captured at deploy (§2, §6);
  rows at or below it are never badged. Baked in before the dapp is built/deployed.

### 4.2 New `tipCommand.ts` (pure, vitest-pinned — mirrors `chatMath.ts`)

- `isTipCommand(raw): boolean` — draft starts with `TIP_PREFIX`.
- `parseTipCommand(raw): { ok; receiver; amount; quantity; memo; error? }`
  - tokenizes with the §3.1 canonical rule; validates receiver name
    (`[.1-5a-z]{1,12}`), not self;
  - validates amount with the **exact §3.2 grammar** and formats `quantity` using
    **integer/string arithmetic only — never `parseFloat`/`toFixed`** (review H1):
    split on `.`, right-pad the fractional part to 8 digits, reject `>8`,
    assemble `"<int>.<frac8> UOS"`. This guarantees the memo's amount token and
    the transfer's int64 amount denote the identical value, so a legit tip can
    never revert on a `parse_uos(amount) != quantity` mismatch;
  - rebuilds the canonical `memo` (`/tip <receiver> <amount> <note>`) that is both
    the transfer memo and the stored message;
  - enforces `byteLength(memo) <= MAX_MESSAGE_LENGTH` (reuses `chatMath.byteLength`);
  - returns a clear `error` per failure (usage, bad name, bad amount, >8 dp,
    self-tip, note too long).
- The mirror is advisory (better errors pre-sign); the contract re-checks all.

### 4.3 `chatClient.ts`

- `buildTipAction(from, permission, quantity, memo)` → single-action array:
  `eosio.token::transfer(from → CONTRACT_ACCOUNT, quantity, memo)`. Next to
  `buildSendMessageAction`; `POSTAGE_QUANTITY` is unused here (the tip amount is
  the transfer amount).

### 4.4 `MessageInput.vue`

- In `send()`: if `isTipCommand(draft)`, `parseTipCommand` → on error set
  `error.value` and stop; else `buildTipAction` → existing `signAndPush` → clear
  draft / `emit('sent')`. Non-tip path unchanged.
- Byte counter (`remaining`) counts the canonical tip `memo` in tip mode, the raw
  draft otherwise.
- A one-line hint shows `/tip <account> <amount> [note]` usage while the draft is
  a tip command. Optionally warn when the receiver is an obvious system account
  (`eosio`, `eosio.token`, `eosio.*`) — funds are irreversible (review L1).

### 4.5 `MessageFeed.vue` — prettify verified tips only

- A row is a **verified tip** iff `text` starts with `TIP_PREFIX` **and**
  `id > TIP_BADGE_MIN_ID` (§2). Only those get the 💸 badge and a human line
  `tipped <amount> UOS to @<receiver> — <note>`, parsed from the stored text with
  the §3.1 tokenizer.
- Render the badge line with **text interpolation only — never `v-html`** (review
  N2; `note` is attacker-controlled verbatim memo text). Matches the existing safe
  `{{ m.text }}` at `MessageFeed.vue:51`.
- All other rows — including any `/tip `-prefixed row with `id <= TIP_BADGE_MIN_ID`
  — render exactly as today (plain text).

### 4.6 `chatMath.ts` `friendlyChainError`

Map the **exact** contract/token assert strings (review L3 — pin these so the
mirror can't drift):

- `overdrawn balance` (`eosio.token.cpp:150`) → "You don't have enough UOS to send that tip."
- `chatroom: tip recipient does not exist` → "That account doesn't exist."
- `chatroom: cannot tip yourself` / `cannot tip the room` → surfaced verbatim-ish.
- `chatroom: tip amount does not match the transfer` → generic "Tip could not be verified — try again."

## 5. Edge cases

| Input / situation | Result |
|---|---|
| `/tip bob 5 gg` (valid, bob exists, funded) | bob receives `5 UOS`; message stored; feed badges it |
| `/tip bob 5` (no note) | forward memo defaults to `"Tip via Ultra Chat"`; message stored |
| receiver doesn't exist | synchronous `is_account` assert → whole tx reverts → no funds move, no message |
| stated amount ≠ transferred amount (hand-crafted tx) | `parse_uos != quantity` → revert (the anti-fake guarantee) |
| amount with garbage chars (`5abc`) / `+`/`-`/`.5`/`5.`/`>8dp` | strict `parse_uos` rejects → revert (funds + display safe) |
| insufficient balance | queued forward reverts (`overdrawn balance`) → friendly error, no message |
| `/tip` with missing receiver/amount | client shows usage error; never signed |
| `receiver == sender` or `== contract` | rejected (client + contract) |
| tip to a system account (`eosio`, `eosio.token`) | allowed on-chain (funds move, likely lost); dapp may warn (L1) |
| memo > 256 bytes | rejected (client + contract) — same cap as normal messages |
| **pre-upgrade `/tip ` row** (`id <= TIP_BADGE_MIN_ID`) | rendered as **plain text**, never badged (B1 mitigation) |
| normal (postage) message with `/tip ` memo after upgrade | routed to tip path, amount check fails → reverts (can't be posted) |
| literal chat line beginning `"/tip "` after upgrade (e.g. `"/tip is great"`) | reserved — reverts / client usage error; **behavior change vs today** (review M3), documented |
| UOS gains a transfer tax config later | all tips revert (`overdrawn balance`); external dependency (§3.5) |
| tip while on 5s cooldown / over daily cap | reverts like any message (flood control runs before the tip branch); a reverted tip does not consume the daily count |

## 6. Deployment impact

- **New requirement: `eosio.code`.** The contract now sends an inline action, so
  the contract account's `active` permission must include `<contract>@eosio.code`.
  Update **both** places in `DEPLOYMENT.md` that state otherwise: the step-3
  heading (`DEPLOYMENT.md:255-257`) and the RAM/perm note around `:245-260`; the
  non-breaking-upgrade note (`DEPLOYMENT.md:83-84`) stays true (tables unchanged).
  Add the `cleos set account permission … active … eosio.code` step before/with
  the redeploy of `1aa2aa3aa4eo`.
- **Capture `TIP_BADGE_MIN_ID`.** Immediately after `set contract`, read the
  current max message id (`get_table_rows messages.a`, reverse, limit 1) and bake
  it into `config.ts` before building/deploying the dapp (§2, §4.1).
- **No contract RAM funding change from tips.** Verified: Ultra's
  `eosio.token::add_balance` sponsors a brand-new receiver balance row itself
  (`to_acnts.emplace(get_self(), …)`, `eosio.token.cpp:158-167`, "BLOCK-641 Add
  RAM sponsor"), so forwarding to a never-held-UOS receiver does **not** bill the
  chatroom. A tip costs the chatroom exactly one message row, same as any message
  (bounded by the 1000-row retention window, `chatroom.hpp:71`).
- **Table-compatible.** `messages.a`/`senders.a`/`banned.a` unchanged → redeploy
  over the live contract is non-breaking (`DEPLOYMENT.md:83`).

## 7. Testing

- **Contract (`ultratests/chatroom`)**: valid tip forwards the exact amount +
  records message; stated≠received reverts; strict `parse_uos` rejects each
  malformed amount (`5abc`, `+5`, `.5`, `5.`, `5.000000000`, empty, overflow);
  unknown receiver reverts (no funds move); self-tip / tip-the-room revert; normal
  postage message with `/tip ` memo reverts; non-tip messages still require exact
  postage; cooldown/daily/ban still apply to tips; a reverted tip leaves no
  message row and does not consume the daily count; contract retains zero after a
  tip.
- **Dapp (`vitest`)**: `parseTipCommand` matrix incl. **integer/string amount
  formatting** (`5.1`, `0.25`, `10`, `0.00000001`, `>8dp`, garbage) proving no
  float drift; the §3.1 tokenizer round-trips receiver/amount/note; `MessageFeed`
  badges only `text` startsWith `/tip ` **and** `id > TIP_BADGE_MIN_ID`, and never
  `v-html`.
- **E2E (`tests/e2e`, mock wallet)**: a tip send produces a single
  `eosio.token::transfer` to the contract with the `/tip …` memo and the parsed
  quantity; a `/tip ` row above the boundary renders the badge; one below does not.

## 8. Out of scope (YAGNI)

- No tip accounting / leaderboard tables (row stays `id, sender, text, sent_at`).
- No skim/fee — the contract forwards the full amount and keeps nothing.
- No confirm modal — the wallet popup shows the transfer (amount + destination)
  before signing.
- No client-side balance pre-check — the atomic on-chain revert handles it.

## 9. Verified against source / on-chain (proof log)

- Ultra `eosio.token` sponsors new balance-row RAM itself → tips don't bill the
  chatroom: `eosio.token.cpp:158-167`.
- UOS has no active transfer tax → forward of full `quantity` succeeds:
  mainnet `tokenconfig`/`UOS` empty; scope proven via `stat`/`UOS` supply, 2026-08-12.
- Self-notification of the forward is absorbed: `chatroom.cpp:7` (`from==self`
  early-return) vs `eosio.token.cpp:90` (`require_recipient(from)`).
- Exact-equality amount check is sound: symbol pinned at `chatroom.cpp:13`, then
  `asset::operator==` reduces to int64 amount.
- No-stranded-funds by atomicity; inline `send()` runs post-handler (review M2).
- Bad receiver strings revert in the `name(string_view)` constructor / `is_account`.
- Upgrade-boundary forgery is real without the id gate: `chatroom.cpp:14-16`,
  `:63-70` store any postage memo verbatim with no prefix reservation today.
