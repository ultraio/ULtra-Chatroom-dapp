# Social Feed (Phase 1) — Design

**Status:** Approved design, pre-implementation
**Date:** 2026-08-11
**Scope:** Phase 1 of the Ultra social/chat dapp. Builds on the existing
onchain Chatroom (`github.com/ultraio/ULtra-Chatroom-dapp`).

---

## 1. Scope

New contract `ultra.chat` on a **fresh account** (the chatroom at
`1aa2aa3aa4eo` stays live and untouched). Phase 1 delivers:

- **Open chat rooms** — keyed by `room_id`, anyone can post, free.
- **Social feed** — posts + comments (a comment is a post with a parent), free.
- **Like + tip** — the *only* path that requires UOS.

**Dropped from earlier drafts:** membership-gated groups, P2P direct messages,
IPFS/Pinata. **Deferred to Phase 2:** rewards-pool distribution (monthly top-3,
≥200 engagement gate). The 10% pool cut on like/tip (see §7) is the funding it
will draw on.

**Design pillars:** least friction, minimal RAM, no third-party dependency.

---

## 2. Locked decisions

1. **Dedicated free actions for all content** (`postmsg`, `post`), **not**
   token transfers. Two reasons: (a) no payment friction; (b) it dodges the
   256-byte memo cap that `eosio.token::transfer` enforces (see §3). A custom
   action's `string` param is bounded only by the 512 KB tx-NET ceiling.
2. **Content lives in the block log**, never copied into RAM. Only compact
   *pointers/indices* go into state. No third-party storage — BPs and any
   self-hosted full-log node serve the content.
3. **Like/tip is the only UOS path.** Transfer ≥1 UOS to `ultra.chat`, memo
   `like|<post_id>` or `tip|<post_id>` (tiny, well under 256 B). Split **90%
   owner / 10% pool**. Like = exactly 1 UOS, **one per account** (dedup),
   free `unlike`, re-like pays again. Tip = ≥1 UOS, repeatable, → `tips_total`.
4. **Engagement = likes + comments** (equal weight); tips tracked separately.
5. **No cooldown** — loosened for engagement. Anti-DoS is a generous daily cap
   only (free actions bill RAM to the contract). Read disambiguation is
   structural, not rate-limit-based (see §6.3).
6. **Two storage strategies:** chat = packed block-delta entries (no per-message
   row); posts = one light row per post (needed for mutable like/comment/tip
   counters + ranking).
7. **Auto-approval-ready:** discrete named actions with simple params, so the
   upcoming wallet permissionless-signing feature can bind each to a dedicated
   custom permission + rate limit (see §8).

---

## 3. Verified chain facts (measured 2026-08-11, Ultra mainnet / source)

- **`eosio.token::transfer` hard-caps the memo at 256 bytes.** `check(
  memo.size() <= 256, "memo has more than 256 bytes")` —
  `spring/eosio.contracts/contracts/eosio.token/src/eosio.token.cpp:96`. This
  is why content uses dedicated actions, and why the like/tip memo stays tiny.
- **A dedicated action's params are bounded only by tx NET:**
  `max_transaction_net_usage = 524288` (512 KB), `max_block_net_usage =
  1048576` (1 MB). So a `post` body can be up to ~hundreds of KB.
- **Contract can self-record its inclusion block number:**
  `eosio::current_block_number()` → intrinsic `get_block_num()`, verified at
  `eosio.cdt/libraries/eosiolib/contracts/eosio/system.hpp:90`.
- **`get_block` returns action data decoded as JSON** for accounts whose ABI
  the node has (it will have `ultra.chat`'s). Fallback: decode the hex with the
  ABI client-side. Reading content is a plain chain API call, not a
  history/Hyperion dependency.
- **Block-log retention is node-dependent** (of 5 endpoints: block 1 served by
  `api.mainnet.ultra.io`, `ultra.eosphere.io`, `api.ultra.eossweden.org`;
  pruned by `ultra.eosrio.io`, `ultra.eosusa.io`). → Content reads must prefer
  the full-log set; self-hosting is the ultimate fallback (see §6.4).
- **Block cadence ≈ 0.5 s**, so 2²⁰ blocks ≈ 6.07 days (the delta window, §5.1).

---

## 4. Contract actions (`ultra.chat`)

| Action | Auth | Cost | Effect |
|---|---|---|---|
| `postmsg(room_id, from, text)` | `from` | free | append a chat message to `room_id`; update `chatidx` |
| `post(from, parent_id, body)` | `from` | free | create a post (`parent_id = NO_PARENT`) or comment; insert `posts.a` row |
| `unlike(post_id)` | `liker` | free | erase `likes.a` row, `post.likes -= 1` |
| *(notify)* `eosio.token::transfer` | — | ≥1 UOS | memo `like\|<id>` or `tip\|<id>` → §7 |
| `ban(account)` / `unban(account)` | `get_self()` | free | carried over; blocks posting/liking |

`NO_PARENT = 0xFFFFFFFFFFFFFFFF` (never a real id). Content (chat text, post
body) travels in the **action data** and is never copied into RAM.

---

## 5. Storage

### 5.1 Chat — packed block-delta index (`chatidx`, scoped per `room_id`)

No per-message row. Each entry points into the block log:

```cpp
struct chat_entry {
   uint64_t          entry_id;     // primary; sequential per room
   uint32_t          start_block;  // block of this entry's first message
   uint16_t          count;        // messages in this entry (≤ 1024)
   std::vector<uint8_t> deltas;     // count × 20-bit: (block − start_block)
};
// scope = room_id.value → each room has its own entry sequence
```

- Each message stores a **20-bit delta** = `current_block_number() -
  start_block`. 20 bits covers 2²⁰ blocks ≈ 6 days.
- An entry **rolls** (new entry, new `start_block`) when it hits **1024
  messages** or a delta would exceed `2²⁰−1` (~6 days), whichever first.
- RAM: 1024 × 20 bits = 2.5 KB/entry → ~2.5 MB per 1 M messages; ~50 entries
  for a year at 1000 msgs/week.
- Multiple messages in one block share a delta value — fine, the block is
  fetched once and yields all of them (see §6.1).

### 5.2 Posts — one light row per post (`posts.a`)

Posts need rows because likes/comments/tips are **mutable counters** used for
ranking (they can't live in a packed array).

```cpp
struct post_v0 {
   uint64_t       id;          // primary; sequential (assigned in exec order)
   name           owner;
   uint64_t       parent_id;   // NO_PARENT = top-level; else the parent post
   uint32_t       likes;       // unique-liker count
   uint32_t       comments;    // direct child count
   uint64_t       tips_total;  // summed tip amount (UOS, 8-dp)
   uint32_t       block_num;   // inclusion block; body lives here
   time_point_sec sent_at;

   uint64_t primary_key()   const { return id; }
   uint64_t by_owner()      const { return owner.value; }
   uint64_t by_parent()     const { return parent_id; }
   uint64_t by_engagement() const { return (uint64_t)likes + comments; }
   uint64_t by_likes()      const { return likes; }
   uint64_t by_comments()   const { return comments; }
   uint64_t by_feed_rank()  const {              // ranked global feed in one scan
      return parent_id == NO_PARENT ? ((uint64_t)likes + comments) : 0;
   }
};
```
~55 B/row + index overhead. 6 secondary indices, all non-unique; they
auto-update on `modify`.

### 5.3 Likes — dedup (`likes.a`)

```cpp
struct like_v0 {
   uint64_t  id;         // primary
   uint64_t  post_id;
   name      liker;
   uint128_t by_pair() const { return ((uint128_t)post_id << 64) | liker.value; }
};
```
`by_pair` unique guard: a second like from the same account reverts the whole
tx (no funds taken). `unlike` erases the row.

---

## 6. Read paths

### 6.1 Chat
Latest entry (highest `entry_id` for the room) → take the last 100 deltas →
`start_block + delta` → `get_block(N)` → collect `ultra.chat::postmsg` actions
where `room_id` matches, in action order. Scroll-up = older deltas, then older
entries, 100 at a time. Distinct block values are fetched once.

### 6.2 Feed
`posts.a` via the relevant index (§9) → for each row, `get_block(block_num)` →
decode its `post` action body. Immutable content is cached by `id`
(persistable to `localStorage`) so each post is fetched once.

### 6.3 Read disambiguation (no cooldown needed)
Two content actions from the same `owner` can land in one block (free, no
cooldown). Resolution:
- **Chat:** none needed — every `postmsg` for the room in that block is taken,
  in action order.
- **Posts:** the contract assigns `id`s in the **same order the block executes
  actions**. So within a block, group `posts.a` rows by `(block_num, owner)`,
  order by `id`, and zip against that owner's `post` actions in the block in
  order. k-th id ↔ k-th action. No extra on-chain field, no rate limit.

### 6.4 Node selection
Content reads (`get_block`) must prefer the **full-log set**
(`api.mainnet.ultra.io`, `ultra.eosphere.io`, `api.ultra.eossweden.org`);
table reads can use any node. Document the self-host fallback.

---

## 7. Payment (like / tip — the only UOS path)

`on_transfer` guards (reuse chatroom's): inbound-only,
`get_first_receiver()==eosio.token`, symbol UOS, sender not banned. Then parse
the memo:

| memo | amount | recipient (90%) | pool (10%) | RAM writes |
|---|---|---|---|---|
| `like\|<post_id>` | **exactly 1 UOS** | owner of post | 0.1 UOS | new `likes.a` (revert if dup); `post.likes += 1` |
| `tip\|<post_id>`  | **≥1 UOS** | owner of post | 10% of amount | `post.tips_total += amount` |

- Split: `pool = amount / 10`, `owner_share = amount − pool` (exact for 1 UOS;
  floor-rounding for arbitrary tips, remainder to pool).
- Owner payment = inline `eosio.token::transfer` from `get_self()` to owner,
  memo `"reward"`; the contract's own `on_transfer` ignores it (guard
  `from==get_self() || to!=get_self()`).
- **Pool = the contract's retained UOS balance**; Phase 2 distributes it. No
  separate accounting row. This is the *sole* pool funding source now that
  posting is free.
- `like`/`tip` require the target post to exist → else `check` reverts, no
  funds moved.
- **Self-like/self-tip** allowed but net-costs the 10% cut; the "farm
  engagement for rewards" vector is a **Phase 2** payout problem (§11).

---

## 8. Auto-approval compatibility (upcoming wallet feature)

The wallet will let a user set auto-approval rules — indexed by
`(account, action)`, with param limits (range / contain / equal), a
frequency/rate limit, and a **dedicated custom permission** it creates and
`linkauth`s to the action. This design is already compatible; nothing to build
contract-side:

- Free content actions (`postmsg`, `post`) are discrete named actions → the
  wallet can `linkauth` a custom permission and auto-approve them. Keeping
  `post` a single action with a `parent_id` param is fine (rules support param
  limits, e.g. `parent_id == NO_PARENT` for a posts-only rule).
- Like/tip is `eosio.token::transfer` → a rule scopes it by `to == ultra.chat`
  + amount range + rate limit.

**Implication kept in mind:** simple, stable action signatures and params so
each maps cleanly to one rule.

---

## 9. Query patterns → indices (the requested query list)

| Requested query | Mechanism |
|---|---|
| by id | primary key |
| by owner | `by_owner` |
| by likes count | `by_likes` (reverse = most-liked) |
| by comments count | `by_comments` |
| by likes + comments | `by_engagement` |
| by commented (parent) id | `by_parent` (`= post_id` → its comments; `= NO_PARENT` → global top-level) |
| ranked global feed | `by_feed_rank` reverse scan (top-level by engagement; comments excluded) |
| newest top-level feed | `by_parent.equal_range(NO_PARENT)` reversed — ties break by primary `id`, so newest top-level first, server-side; also surfaces 0-engagement new posts that `by_feed_rank` sinks |

---

## 10. Frontend (Vue3 + Vite, `dapp/`)

- **Chat view:** default latest 100 (from latest `chatidx` entry), scroll-up
  paginates 100 more; local cache/index; optional manual "import full history".
- **Feed views:** ranked (`by_feed_rank`), newest (`by_parent` @ NO_PARENT),
  single-post + comments (`by_parent`), profile (`by_owner`).
- **Composer:** free `post`/`comment` and `postmsg` (no payment prompt);
  body up to the size cap; image/gif as base64, video as URL.
- **Like/tip:** the only wallet-payment flow — surface "Like · 1 UOS" /
  "Tip · N UOS".
- **New client module:** action assembly; `get_block` fetch + decode + cache;
  the id↔action zip (§6.3); packed-delta decode; index queries.
- **Reuse:** wallet connect, `signAndPush` + `commitFailureReason`
  (broadcast ≠ committed), Ultra brand styling.
- No IPFS / Pinata / Cloudflare Worker.

---

## 11. Anti-abuse & Phase-2 hooks

- Like one-per-account + pay-again-on-re-like makes padding likes costly.
- Comments are free → cheap to pad, but they inflate only the *parent's*
  comment count; the sybil concern is the reward payout, deferred to Phase 2.
- **Free actions bill RAM to the contract account.** A spammer only spends
  their own (limited, free-tier) CPU/NET, so a **generous daily cap** per
  sender is the safety valve; monitor contract RAM. Posts (~55 B) and chat
  (~2.5 B/msg) are cheap, but unbounded.
- **Phase-2 sybil mitigations to decide:** exclude self-engagement from the
  reward tally; weight by distinct funders; cap per-account contribution to a
  post's score.

---

## 12. Out of scope (later)

- Rewards distribution / ≥200 gate / monthly top-3 (Phase 2).
- Membership groups, admin roster, P2P DM (dropped for now).
- Edit/delete (block-log content is immutable; a "delete" would only hide the
  index row).
- Follows, notifications, on-chain search (client-side local search only).

---

## 13. Testing

- **Contract (`ultratests/`):** `postmsg` appends + entry roll at 1024 /
  ~6-day delta; `post`/comment id assignment + parent increment; like dedup +
  revert on double-like; unlike decrement + re-like re-pays; tip accumulates +
  90/10 split (exact at 1 UOS, floor+remainder otherwise); like/tip on missing
  post reverts; banlist blocks post/like; `by_feed_rank` excludes comments;
  packed-delta encode/decode round-trip; id↔action-order zip within a block.
- **Frontend (`vitest`):** action assembly; packed-delta decode; `get_block`
  decode + body parse; id↔action zip; engagement sort; content cache.
- **In-browser (Playwright):** post → feed; chat → appears; like → +1 & 1 UOS
  prompt; tip → tips_total; comment → nested; unlike → −1; scroll-up paging.

---

## 14. Risks / open items

- **NET** for large `post` bodies on Ultra's resource model — validate a
  ~128 KB post pushes cleanly before raising the cap.
- **Contract RAM growth** from free posts/chat — monitor; daily cap as valve.
- **Full-log node availability** for content reads — prefer the retained set,
  document self-host fallback, monitor the 3 endpoints.
- **Contract funding** — RAM (growing tables) + UOS balance (inline reward
  transfers on like/tip).
- **New account + keys** — provision owner/active keys; deploy runbook mirrors
  the chatroom's `DEPLOYMENT.md`.
- **20-bit packing** is the one fiddly bit of contract code (bit-packing across
  byte boundaries) — unit-test the encode/decode thoroughly.
