# Chatroom `/tip` command — design

- **Date:** 2026-08-12
- **Status:** Approved (brainstorming) — ready for implementation plan
- **Scope:** Add a `/tip <receiver> <amount> [note]` command to the on-chain
  chatroom. Sending it transfers UOS to `receiver` **and** records the message
  in the feed, in one atomic on-chain transaction, with the tip made
  **contract-verified** so a recorded tip can never be faked.

---

## 1. Motivation

The chatroom's message model is: a message is an `eosio.token::transfer` of a
fixed "postage" amount (`0.00000001 UOS`) to the contract, whose memo IS the
message text (`contracts/chatroom/src/chatroom.cpp` `on_transfer`).

A tip should move real UOS to a third party and also show up in the feed. The
naive design bundles two independent `transfer` actions client-side (tip →
receiver, postage → contract). It was rejected because it is **fakeable**: the
contract is not a party to the tip transfer, so it cannot tell a postage
message that says *"tipped 5 UOS to bob"* from one that actually paid bob.
Anyone hand-crafting a raw transaction (bypassing the dapp UI) could post the
receipt text with **no tip attached**. Chat text being unverifiable in general,
the fix is to make the *tip receipt specifically* unforgeable.

The only way to guarantee "a tip message ⇒ the funds moved" is to make the
**contract itself** move the money: the user transfers to the chatroom, and the
chatroom forwards the payment to the receiver in the same transaction, recording
the message only after the forward succeeds.

## 2. Trust model — the reserved-prefix invariant

The contract **reserves the `/tip ` memo prefix**. Any inbound transfer whose
memo starts with `/tip ` is forced down the tip path, which:

1. requires a valid `receiver`, a well-formed `amount`, and a `note`;
2. requires the **stated amount to equal the amount actually received**
   (`parse_uos(amount) == quantity`);
3. forwards the full `quantity` to `receiver` via an inline transfer;
4. only then records the memo as a message row.

Any of these failing reverts the whole transaction. Therefore:

> **A stored message beginning with `/tip ` is, by contract construction,
> always a real forwarded tip whose displayed amount equals the amount paid.**

A normal postage message **cannot impersonate** a tip: if it carries a `/tip …`
memo, the contract routes it to the tip path and the amount check fails
(`postage ≠ stated amount`), reverting. This is what lets the dapp badge/prettify
`/tip ` rows purely by prefix, with **no new table columns and no accounting** —
the message row stays exactly the shape it is today (`id, sender, text, sent_at`).

## 3. Contract changes (`contracts/chatroom`)

Single `on_transfer` handler, single `messages.a` table — no schema change.

```
on_transfer(from, to, quantity, memo):
  if from == self or to != self: return          # unchanged: inbound only,
                                                  #   ignores our own forward
  check first_receiver == eosio.token             # unchanged
  check quantity.symbol == UOS                     # unchanged
  check 0 < memo.size() <= MAX_MSG_LEN             # unchanged (256 bytes)
  check not banned(from)                           # unchanged
  ...cooldown + daily flood control...             # unchanged, applies to tips too

  if memo starts with "/tip ":                     # NEW tip branch
      (receiver, amount_str, note) = parse_tip(memo)
      check is_account(receiver)
      check receiver != from and receiver != self
      check parse_uos(amount_str) == quantity      # stated == received  (§1 requirement)
      inline eosio.token::transfer(
          self -> receiver, quantity,
          note.empty() ? "Tip via Ultra Chat" : note)   # needs eosio.code
  else:                                            # normal message, unchanged
      check quantity.amount == POSTAGE_AMOUNT

  emplace message { id, sender: from, text: memo, sent_at: now }   # verbatim, unchanged
  ...retention prune...                            # unchanged
```

### 3.1 Memo grammar

`/tip <receiver> <amount> [note]`

- `receiver` — token 2: a legal eosio/Ultra account name (`[.1-5a-z]{1,12}`).
- `amount` — token 3: a plain decimal (`5`, `5.5`, `0.25`), **≤ 8 decimal
  places** (UOS precision). No symbol suffix in the memo.
- `note` — the remainder (may be empty).

The whole memo is stored verbatim as the message text, so the feed shows the
literal command; the dapp prettifies it at render (§4.4). Example stored text:
`/tip bob 5 gg well played`.

### 3.2 `parse_uos` (contract-side, C++)

Parse the decimal `amount_str` into an `int64` at 8-decimal fixed point and
build an `asset{value, UOS_SYM}`; compare `== quantity`. Rules:

- reject empty / non-numeric / negative / more than 8 fractional digits;
- reject overflow;
- the equality check (not `>=`) guarantees the receiver gets exactly the number
  shown in the message and the contract keeps nothing.

`amount` may be any positive value (there is deliberately **no** lower bound tied
to `POSTAGE_AMOUNT`; a tip of `0.00000001` is legal and simply forwards a dust
amount). The postage `== POSTAGE_AMOUNT` assert now applies **only** to the
non-tip branch.

### 3.3 No stranded funds

`chatroom.hpp:38-41` warns the contract has **no withdraw action** — anything it
keeps is permanent. The tip branch keeps **zero**: the forward is an inline
action in the same transaction, so if the forward asserts (e.g. `receiver`
doesn't exist) the whole transaction reverts and the sender's funds never
leave. There is no code path where the contract accepts a tip and retains it.
The existing `from == self` early-return already prevents the inline forward
from re-entering the handler.

### 3.4 Header comment update

The `POSTAGE_AMOUNT` comment (`chatroom.hpp:38-41`) currently justifies
rejecting larger transfers ("a bundled tip action … fails loudly instead of
getting silently stranded"). Update it: larger transfers are now accepted **only**
on the `/tip ` path and are always forwarded in the same tx, never stranded.

### 3.5 Deployment impact

- **New requirement: `eosio.code`.** The contract now sends an inline action, so
  the contract account's `active` permission must include the
  `<contract>@eosio.code` authority. `DEPLOYMENT.md:255` currently states the
  opposite ("no `eosio.code` permission"); update that step and add the
  `cleos set account permission … active` command to grant it before/with the
  redeploy of `1aa2aa3aa4eo`.
- **Table-compatible.** `messages.a` / `senders.a` / `banned.a` are unchanged, so
  re-deploying over the live contract is non-breaking (same as prior upgrades,
  `DEPLOYMENT.md:83`).

## 4. Dapp changes (`dapp/src`)

The dapp sends **one** action — `transfer(me → contract, <amount> UOS,
memo="/tip …")` — and does client-side parsing only for early validation/UX. The
contract is the authority.

### 4.1 `config.ts`

- `TIP_PREFIX = '/tip '`.

### 4.2 New `tipCommand.ts` (pure, vitest-pinned — mirrors `chatMath.ts`)

- `isTipCommand(raw): boolean` — draft starts with `/tip ` after trim-left.
- `parseTipCommand(raw): { ok; receiver; amount; quantity; memo; error? }`
  - validates receiver name (`[.1-5a-z]{1,12}`), not self;
  - validates amount: positive, numeric, ≤ 8 dp; formats `quantity` to
    `"X.XXXXXXXX UOS"` (exact 8 dp) so the on-chain transfer amount matches what
    the contract will parse from the memo;
  - rebuilds the canonical `memo` (`/tip <receiver> <amount> <note>`) that is
    both sent as the transfer memo and stored as the message;
  - enforces `byteLength(memo) <= MAX_MESSAGE_LENGTH` (reuses `chatMath.byteLength`);
  - returns a clear `error` string per failure (usage, bad name, bad amount, too
    many decimals, self-tip, note too long).
- The client mirror is advisory (better errors before signing); the contract
  re-checks everything.

### 4.3 `chatClient.ts`

- `buildTipAction(from, permission, quantity, memo)` → single-action array:
  `eosio.token::transfer(from → CONTRACT_ACCOUNT, quantity, memo)`. Sits next to
  `buildSendMessageAction`; `POSTAGE_QUANTITY` is not used here (the tip amount
  is the transfer amount).

### 4.4 `MessageInput.vue`

- In `send()`: if `isTipCommand(draft)`, `parseTipCommand` → on error set
  `error.value` and stop; else `buildTipAction` → existing `signAndPush` →
  clear draft / `emit('sent')`. Non-tip path unchanged.
- Byte counter (`remaining`) counts the canonical tip `memo` when in tip mode
  (so the cap reflects what's actually stored), the raw draft otherwise.
- A one-line hint shows `/tip <account> <amount> [note]` usage while the draft is
  a tip command.

### 4.5 `MessageFeed.vue` — prettify verified tips

- Rows whose `text` starts with `/tip ` are rendered with a 💸 "tip" badge and a
  human line `tipped <amount> UOS to @<receiver> — <note>` (parsed from the
  stored text). Safe by §2: only real forwarded tips can have this prefix.
- All other rows render exactly as today.

### 4.6 `chatMath.ts` `friendlyChainError`

- Map `overdrawn balance` → "You don't have enough UOS to send that tip."
- Map unknown-receiver assert → "That account doesn't exist."
- Existing mappings unchanged.

## 5. Edge cases

| Input / situation | Result |
|---|---|
| `/tip bob 5 gg` (valid, bob exists, funded) | bob receives `5 UOS`; message `/tip bob 5 gg` recorded; feed shows badged tip |
| `/tip bob 5` (no note) | forward memo defaults to `"Tip via Ultra Chat"`; message recorded |
| receiver doesn't exist | inline forward asserts → whole tx reverts → no funds move, no message |
| stated amount ≠ transferred amount (hand-crafted tx) | contract amount check fails → revert (this is the anti-fake guarantee) |
| insufficient balance | tx reverts on chain → friendly error, no message |
| `/tip` with missing receiver/amount | client shows usage error; never signed |
| amount with > 8 decimals | client + contract reject |
| `receiver == sender` | rejected (client + contract) |
| memo > 256 bytes | rejected (client + contract) — same cap as normal messages |
| normal message beginning with `/tip ` | not possible — reserved; routed to tip path and rejected unless it is a real tip |
| tip while on 5s cooldown / over daily cap | reverts like any message (flood control runs before the tip branch) |

## 6. Testing

- **Contract (`ultratests/chatroom`)**: valid tip forwards exact amount + records
  message; stated≠received reverts; unknown receiver reverts (no funds move);
  self-tip reverts; >8dp reverts; normal postage message with `/tip ` memo
  reverts; normal (non-tip) messages still require exact postage; cooldown still
  applies to tips; no funds retained by the contract after a tip.
- **Dapp (`vitest`)**: `parseTipCommand` matrix — valid, no-note, bad name,
  non-numeric/zero/negative amount, >8dp, self-tip, over-long memo, 8dp amount
  formatting; `MessageFeed` prettify parsing of a `/tip ` row.
- **E2E (`tests/e2e`, mock wallet)**: a tip send produces a single
  `eosio.token::transfer` to the contract with the `/tip …` memo and the
  parsed quantity; feed renders the badge.

## 7. Out of scope (YAGNI)

- No tip accounting / leaderboard tables (message stays the plain
  `id, sender, text, sent_at` row).
- No skim/fee — the contract forwards the full amount and keeps nothing.
- No confirm modal — the wallet popup already shows the transfer (amount +
  contract destination) before signing.
- No client-side balance pre-check — the atomic on-chain revert handles it.
