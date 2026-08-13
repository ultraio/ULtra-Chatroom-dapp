# Security audit — `chatroom` contract (with the `/tip` command)

- **Date:** 2026-08-13
- **Scope:** `contracts/chatroom/src/chatroom.cpp` + `include/chatroom/chatroom.hpp`
  — the `on_transfer` notify handler (message + `/tip`), `ban`/`unban`, and the
  `parse_tip` / `parse_uos_amount` helpers.
- **References:** ultra-agent-kb `12-SMART_CONTRACT_SECURITY.md` (the §6 checklist
  + §5 attack classes), `09-WORKED_EXAMPLE_TIP_JAR.md` (the closest analog — a
  tip contract with an inline forward), `03-SMART_CONTRACT_DEVELOPMENT.md`.
  Token semantics verified against `/home/adam/spring/eosio.contracts/contracts/eosio.token`.
- **Verdict:** **PASS — no critical/high/medium findings.** The money-movement
  and anti-forgery logic is sound. Three informational notes below (all
  fail-safe, none exploitable).

Every claim cites `chatroom.cpp` line numbers as they stand at audit time.

---

## 1. Method

Reviewed against KB 12 §6 (the security checklist) item by item, then against KB
12 §5 (the historical Antelope attack classes), then a business-logic pass on the
tip invariant. Each conclusion is backed by the contract source and, where a
runtime property is claimed, by a passing `ultratest2` case run on a real local
chain (`ultratests/chatroom/chatroom.tip.spec.ts`, 18 cases).

## 2. Checklist review (KB 12 §6)

| # | Checklist item | Status | Evidence |
|---|---|---|---|
| 1 | Auth names the right account; never `get_self()` for user spends | ✅ | `ban`/`unban` gate on `require_auth(get_self())` (owner-only moderation, `chatroom.cpp:158,168`); the tip forward moves only the funds the tipper just sent in the same tx (see §4). |
| 2 | Inline-only helper actions self-guard with `get_sender()` | ✅ N/A | There are no inline-callable helper actions. The only inline is `eosio.token::transfer` (external, self-authorized via `eosio.code`). |
| 3 | `on_notify` handlers carry no `require_auth` | ✅ | `on_transfer` has none; authorization is the static binding + the §3 receiver guards. |
| 4 | Inbound value three-part guard (`from!=self` → `to==self` → first-receiver) | ✅ | `chatroom.cpp:7` (`from==self \|\| to!=self` → return) + `chatroom.cpp:82` (`get_first_receiver()==TOKEN_CONTRACT`). Static `on_notify("eosio.token::transfer")` binding, so the first-receiver check is belt-and-suspenders. |
| 5 | Validate symbol+precision; reject unknown memos; reject taxed tokens | ✅ / ⚠️ | `check(quantity.symbol==UOS_SYM)` (`:84`) — `symbol` embeds precision. The token is fixed (`eosio.token`/UOS), not user-registered, so there is no registration boundary to reject taxed tokens at; the latent UOS-tax case is Note A (fail-safe). "Unknown memo" is by design a normal chat message (this is a chat room), so any text is valid. |
| 6 | Fixed-fee handler asserts the **exact** amount (no stranding) | ✅ | Non-tip: `check(quantity.amount==POSTAGE_AMOUNT)` (`:161`). Tip: forwards the **entire** received amount, so nothing is ever kept/stranded (§4); the amount is pinned by `check(parse_uos_amount(...)==quantity)` (`:139`). |
| 7 | A parent can't read an inline's result/state | ✅ | The handler never reads the forward's result or any post-forward state; it relies on transaction atomicity, not on observing the inline (KB 12 §1). |
| 8 | Validate caller-supplied accounts with `is_account`; `find`+check idiom | ✅ | `check(is_account(receiver), …)` before forwarding (`:135`); `senders`/`banned` use `find()` + explicit checks (`:97-101` etc.). |
| 9 | Never read own balance to validate funds | ✅ | The contract never reads its own balance. It forwards `quantity` (the notified amount), bounded by what the tipper sent this tx — see the drain analysis in §4. |
| 10 | Effects before interactions; no re-read expecting an inline's change | ✅ | Ban/flood/state mutations and the message `emplace` all run in the handler body; the forward is queued and runs after (KB 12 §1). Atomic revert covers a failed forward. |
| 11 | User trades take `min_out`/`deadline` | ✅ N/A | A tip has no price/slippage; not a swap. |
| 12 | Signed-message contracts: domain sep + nonce + epoch | ✅ N/A | No off-chain signatures are accepted. |
| 13 | No unpredictable value from on-chain data (RNG) | ✅ N/A | No randomness is used. |
| 14 | No deferred-tx assumptions | ✅ | None used. |
| 15 | u128 intermediates + overflow guards | ✅ | `parse_uos_amount` guards every digit push: `check(amount <= (INT64_MAX - d)/10, "…too large")` (`:70`). No amount multiplication elsewhere (the tip forwards the exact `quantity`). |
| 16 | No admin path moves user funds; pause halts new risk only | ✅ | The only admin actions are `ban`/`unban`; neither moves funds. No pause needed. |
| 17 | Every assert has a negative-path spec | ✅ | 18 `ultratest2` cases cover mismatch, non-numeric, >8dp, trailing/leading dot, multiple dots, missing amount, prefix-only, unknown/​self/​room recipient, non-postage, banned, cooldown, plus the happy paths with on-chain balance-delta assertions. |

## 3. Attack-class review (KB 12 §5)

- **Fake token / fake deposit (EOSBet 2018):** defeated by `get_first_receiver()
  == TOKEN_CONTRACT` (`:82`) + explicit symbol check (`:84`). ✅
- **Forged receipt / bystander notification (EOSBet 2018):** defeated by
  `to == get_self()` / `from != get_self()` (`:7`). ✅
- **Inline-ordering staleness / "reentrancy-like":** the forward is queued and
  the handler reads no post-forward state; its self-notification (`chatroom` as
  `from`) is absorbed by the `from == get_self()` early return (`:7`), so the
  outbound transfer cannot re-enter and corrupt in-flight state. A hostile
  recipient contract can only initiate a *fresh* transfer, subject to every guard
  again. No transient lock row is needed because the contract expects nothing
  back (unlike a flash loan). ✅
- **Balance-inference drain:** the contract never validates via its own balance;
  see §4. ✅
- **On-chain RNG / deferred-tx / signature replay:** not applicable (no RNG, no
  deferred tx, no signed messages). ✅
- **Asset/integer overflow:** guarded in `parse_uos_amount` (`:70`). ✅
- **Fee-on-transfer / taxed-token desync (BLOCK-2584):** Note A.

## 4. Business-logic soundness

**The tip invariant** — *"a stored `/tip …` row (above the client's id
high-water-mark) is always a real forwarded tip whose displayed amount equals the
amount paid"* — holds by construction:

1. The `/tip ` prefix forces the tip path (`:130`); a normal postage message
   cannot impersonate a tip because the amount check (`:139`) fails for a
   postage-sized transfer (proven: the *anti-fake* ultratest case).
2. `parse_uos_amount(memo) == quantity` (`:139`) ties the displayed amount to the
   amount actually received.
3. The full `quantity` is forwarded to the recipient (`:143-147`), and the
   message row is committed in the same atomic transaction — any failure
   (bad recipient, overdrawn, parse error) reverts the whole tx, so a row can
   only exist if the funds moved.

**No fund drain / no stranding.** The forward amount equals the amount the tipper
sent *this* transaction (`quantity`), and with no UOS tax the contract receives
exactly that. So a tip is balance-neutral for the contract: it receives `X` and
forwards `X`, keeping **0** (proven: the *room keeps 0* balance-delta assertion).
An attacker cannot extract the contract's accumulated postage dust, because the
forward is bounded by their own deposit — sending `X` can only forward `X`. The
receiver's new balance-row RAM is sponsored by `eosio.token` itself
(`eosio.token.cpp:165`, "BLOCK-641"), not the chatroom, so tipping never drains
the contract's RAM either; a tip costs exactly one message row, same as any
message, bounded by the 1000-row retention window.

**Flood control & retention** apply uniformly: the tip branch sits *after* the
ban + 5s-cooldown + 50/day checks, and a tip writes one message row that
participates in the same prune loop. A reverted tip rolls back the `senders`
modify, so it consumes no cooldown/quota (proven: the *erin* case).

## 5. Findings (all informational — none require a code change)

**A. Latent dependency: UOS must not carry a transfer tax.** Ultra's
`eosio.token` supports a per-symbol tax/burn (`eosio.token.cpp:98-138`); under an
active config the contract would receive `quantity − tax` while the notification
still reports `quantity`, so the forward of the full `quantity` would revert with
`overdrawn balance`. **Verified inactive on mainnet (2026-08-13):**
`get_table_rows(eosio.token, scope=UOS, tokenconfig)` is empty. This is
**fail-safe** — if UOS is ever taxed, tips *revert*, they do not mis-pay or
drain. Documented in the design spec §3.5; no action needed unless UOS tax is
ever enabled, in which case the tip forward must switch to the received delta.

**B. Tipping a system account is permitted.** `/tip eosio 5` (or any funded
system account) passes `is_account` and irreversibly moves the *tipper's own*
funds. This is user error on funds the tipper authorized, not a contract flaw;
the dapp mitigates by warning on obvious system-account recipients. No contract
change warranted (the on-chain layer cannot distinguish an intended gift from a
mistake).

**C. Malformed recipient names revert with the CDT's generic message.**
Constructing `name{parts.receiver}` from an invalid charset (e.g. uppercase, via
a hand-crafted transaction) asserts inside the eosio `name` constructor rather
than hitting a `chatroom:`-prefixed message. The outcome is still a clean revert
with no state change; the dapp validates names client-side so UI users never hit
it. Cosmetic only.

## 6. Conclusion

The `chatroom` contract with the `/tip` command satisfies every applicable item
on the KB 12 §6 checklist and is not exposed to any of the KB 12 §5 attack
classes. The tip design keeps zero funds, cannot be forged into a fake receipt,
and reverts atomically on every failure path. **No vulnerabilities found; the
business logic is sound.** The three notes above are fail-safe properties to be
aware of, not defects.
