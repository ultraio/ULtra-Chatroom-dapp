# Social Feed (Phase 1) — Design

**Status:** Approved design, pre-implementation
**Date:** 2026-08-11
**Scope:** Phase 1 of the Ultra social/chat dapp. Builds on the existing
onchain Chatroom (`github.com/ultraio/ULtra-Chatroom-dapp`).

---

## 1. Scope

The full social dapp is decomposed into three phases:

| Phase | Scope | Status |
|---|---|---|
| **1 — Social feed core** *(this doc)* | posts + comments + likes, block-data content, on-chain index with owner/parent/engagement indices, 1-UOS-per-action payment routing (owner + pool) | designing |
| 2 — Rewards pool | monthly top-3 distribution, ≥200 engagement gate, 10% of pool | later |
| 3 — Groups & DM | open groups (reuse banlist), membership groups (admin roster), P2P DMs — all as *scoped posts* | later |

**Unifying model:** everything is a *post*. A comment is a post with
`parent_id` set. (Groups/DMs in Phase 3 add a `scope`/`recipient` to the same
row.) This collapses the feature list into **one contract with one posts table
+ a small likes table**.

Phase 1 does **not** implement: rewards distribution, groups, membership, or
DMs. It does lay the foundations they need (engagement index, payment→pool
accrual).

---

## 2. Locked decisions

1. **New contract account.** Deploy the social contract on a fresh account.
   The existing chatroom at `1aa2aa3aa4eo` stays live and untouched (it can
   become "one open group" in Phase 3). No migration, no risk to the demo.
2. **Fee = 1.00000000 UOS** per paid action (contract constant, tunable). Not
   the chatroom's dust postage.
3. **Fee routing:** like & comment → **0.9 UOS to the post owner, 0.1 UOS to
   the pool**; create-post → **1.0 UOS to the pool** (no owner to pay).
   "Influencer gets money directly" = the inline transfer to the owner.
4. **Content storage = block-data**, not IPFS. The post body travels in the
   transfer memo (≤256 KB) and lives permanently in the chain's block log.
   Only a ~60-byte index row goes into RAM. **No third-party dependency** —
   BPs and any self-hosted full-log node serve the content.
   - *Rejected:* IPFS+Pinata. Public-readable but **not permanent** — if the
     pin lapses the content disappears. A hosted pin is a centralized point of
     failure; if we accept that, a plain server would be simpler. Block-data
     keeps the only dependency on the chain itself.
5. **Like = one per account per post.** Unlike is a free action that removes
   the like; re-liking pays again. Makes rank-buying expensive.
6. **Engagement = likes + comments** (equal weight). Feeds ranking and the
   Phase-2 ≥200 gate.
7. **No pruning of posts** (unlike the chatroom's rolling 1000). Posts are the
   product and must persist. RAM grows with post + like count (see §10).

---

## 3. Verified chain facts (measured 2026-08-11, Ultra mainnet)

- **Contract can self-record its inclusion block number.** CDT exposes
  `eosio::current_block_number()` → intrinsic `get_block_num()` ("the current
  block number" = the block being produced). Verified in
  `eosio.cdt/libraries/eosiolib/contracts/eosio/system.hpp:90`. This removes
  the block-data chicken-and-egg — no off-chain indexer needed.
- **`get_block` returns the memo decoded as JSON** (`data.memo`) for standard
  actions like `eosio.token::transfer`. Reading content back is a plain chain
  API call, not a history/Hyperion dependency.
- **Size envelope:** `max_transaction_net_usage = 524288` (512 KB/tx),
  `max_block_net_usage = 1048576` (1 MB/block). A 256 KB post fits in one tx /
  one block.
- **Block-log retention is node-dependent.** Of the 5 configured endpoints,
  block 1 is served by `api.mainnet.ultra.io`, `ultra.eosphere.io`,
  `api.ultra.eossweden.org`; **pruned** by `ultra.eosrio.io` (partial) and
  `ultra.eosusa.io` (aggressive). → The dapp must read content from a
  **full-block-log node** (see §7); reads pin to the retained set, with
  self-hosting always available as the ultimate fallback.

---

## 4. Data model (contract tables)

All tables scoped to `get_self()`, RAM billed to `get_self()` (notify-context
rule — an unprivileged contract may only bill its own account in `on_notify`).

### 4.1 `posts.a` — the one table that is everything

```cpp
struct post_v0 {
   uint64_t       id;          // primary; contract-assigned, sequential
   name           owner;       // author
   uint64_t       parent_id;   // NO_PARENT (sentinel) = top-level post;
                               // else = the post this comments on
   uint32_t       likes;       // unique-liker count (see likes.a)
   uint32_t       comments;    // direct child count
   uint32_t       block_num;   // inclusion block; content lives in this block
   time_point_sec sent_at;

   uint64_t primary_key()   const { return id; }
   uint64_t by_owner()      const { return owner.value; }
   uint64_t by_parent()     const { return parent_id; }
   uint64_t by_engagement() const { return (uint64_t)likes + comments; }
   uint64_t by_likes()      const { return likes; }
   uint64_t by_comments()   const { return comments; }
   // Ranked global feed in one server-side reverse scan: top-level posts keyed
   // by engagement, comments collapsed to 0 so they sink out of the feed.
   uint64_t by_feed_rank()  const {
      return parent_id == NO_PARENT ? ((uint64_t)likes + comments) : 0;
   }
};
```

Secondary indices (multi_index supports up to 16; we use 6):
`by_owner`, `by_parent`, `by_engagement`, `by_likes`, `by_comments`,
`by_feed_rank`. All non-unique. On `modify` (a like/comment changes counts)
the affected indices update automatically.

`NO_PARENT` sentinel = `0xFFFFFFFFFFFFFFFF` (`UINT64_MAX`) — never a real
`id`, so top-level posts share one bucket queryable via `by_parent`.

### 4.2 `likes.a` — one-like-per-account dedup

```cpp
struct like_v0 {
   uint64_t id;         // primary; available_primary_key()
   uint64_t post_id;    // secondary: by_post
   name     liker;      // secondary: by_liker (for "did I like this?")
   // composite unique guard: by_pair = (post_id << 64 | liker) as uint128
   uint128_t by_pair()  const { return ((uint128_t)post_id << 64) | liker.value; }
};
```

Uniqueness enforced by a `uint128` secondary index on `(post_id, liker)` —
`emplace` after checking `by_pair` has no match; a duplicate like reverts the
whole tx (no payment taken). Unlike erases the row.

*(Sender flood-control table `senders.a` carried over from the chatroom
contract, unchanged — see §8.)*

---

## 5. Memo command grammar

One transfer = one signed user action. The memo carries both the routing
header and (for post/comment) the opaque content body:

```
post|<json-body>                 create a top-level post
comment|<parent_id>|<json-body>  create a comment on <parent_id>
like|<post_id>                   like <post_id>
```

- Contract parses only the header (`cmd`, and `parent_id`/`post_id`). The
  `<json-body>` is **opaque** — never copied into RAM, only left in the block.
- `<json-body>` = `{ "text": string, "images": [base64…], "videoUrl": string }`.
  All fields optional; the frontend validates shape.
- Delimiter `|`. `cmd` = substring up to the first `|`. For `comment`,
  `parent_id` = between first and second `|`; body = remainder. For `post`,
  body = remainder after the first `|`. For `like`, `post_id` = remainder.
- **Free action** (no transfer, no body): `unlike(post_id)` — a direct
  contract action, `require_auth(liker)`.

---

## 6. Payment routing (inside `on_transfer`)

Guards first (reuse chatroom's): inbound-only, `get_first_receiver() ==
eosio.token`, symbol == UOS, **`quantity.amount == FEE`** (1e8), sender not
banned, flood-control pass. Then dispatch on `cmd`:

| cmd | recipient of 0.9 UOS | pool cut (retained) | RAM writes |
|---|---|---|---|
| `post` | — (whole 1.0 UOS to pool) | 1.0 UOS | new `posts.a` row, `parent_id = NO_PARENT` |
| `comment` | owner of `parent_id` | 0.1 UOS | new `posts.a` row `parent_id=P`; `parent.comments += 1` |
| `like` | owner of `post_id` | 0.1 UOS | new `likes.a` row; `post.likes += 1` |

Mechanics:
- **Split is exact** (1e8 divides evenly): `OWNER_SHARE = 90000000`,
  `POOL_CUT = 10000000`.
- Owner payment = **inline `eosio.token::transfer`** from `get_self()` to
  owner, `0.9 UOS`, memo `"reward"`. Authorized by `get_self()`'s active
  permission. The contract's own `on_transfer` ignores it (existing guard:
  `from == get_self() || to != get_self()` → return).
- **Pool = the contract's retained UOS balance.** The 0.1 (or full 1.0 for
  posts) simply stays; Phase 2 distributes it. No separate accounting row.
- **`comment`/`like` require the target to exist** — look up `parent_id`/
  `post_id` in `posts.a`; missing → `check` fails → whole tx reverts, no funds
  moved.
- **Self-like / self-comment** is allowed but net-costs the pool cut (you pay
  0.1 to like your own post). The larger "farm engagement to win rewards"
  concern is a **Phase 2** problem (sybil resistance on the payout), noted in
  §11.

---

## 7. Content read/write flow

**Write** (browser): build memo → wallet signs one `eosio.token::transfer` of
1 UOS to the contract → contract stamps `block_num = current_block_number()`
into the new row. The browser already holds the body, so it renders its own
post optimistically.

**Read** (feed): fetch `posts.a` rows (cheap, via the relevant index) → for
each row, `get_block(block_num)` → find the `eosio.token::transfer` to the
contract **from `owner`** → decode `data.memo` → strip header → parse body.
- `(block_num, owner)` is **unique** because per-sender cooldown (§8)
  guarantees ≤1 content action per sender per block.
- Reads must target a **full-block-log node**. Config: reorder `nodeUrls` so
  content reads prefer the retained set (`api.mainnet.ultra.io`,
  `ultra.eosphere.io`, `api.ultra.eossweden.org`); table reads can use any.
- **Caching:** block content is immutable — the frontend caches decoded bodies
  by `id` (and can persist to `localStorage`) so a post is fetched once.
- **Batching:** multiple posts in the same block need only one `get_block`.

---

## 8. Flood control & limits (carried from chatroom, now load-bearing)

- **Per-sender cooldown** (5 s) + **daily cap** (50/day) via `senders.a`.
  Cooldown now also guarantees the `(block_num, owner)` read-uniqueness in §7,
  so it is structural, not just anti-spam.
- **Post size:** hard cap **256 KB** memo (contract `check`), practical
  default **128 KB** — a 256 KB tx is heavy on NET and frequent posting can
  exhaust an account's NET allowance. Constant, tunable.
- **Banlist** (`banned.a`) + `ban`/`unban` owner actions carried over
  unchanged; a banned account can neither post, comment, nor like (rejected in
  `on_transfer`, reverting the transfer — no funds taken).

---

## 9. Frontend changes (Vue3 + Vite, `dapp/`)

- **New views:** feed (ranked list via `by_feed_rank`), single-post +
  comments (via `by_parent`), profile (via `by_owner`), composer with
  image/gif upload (base64 into body) + video-URL field.
- **New client module** for: memo assembly (`post|…`, `comment|…`, `like|…`),
  `get_block` content fetch + decode + cache, engagement/feed queries against
  the secondary indices.
- **Reuse:** wallet connect, `signAndPush` + `commitFailureReason` (broadcast
  ≠ committed), `byteLength` UTF-8 cap, dedup-on-merge, Ultra brand styling.
- **Payment UX:** each like/comment/post is a 1 UOS transfer — the wallet
  prompt shows it. Surface the fee clearly ("Like · 1 UOS").
- No IPFS, no Pinata, no Cloudflare Worker (block-data has no upload broker).

---

## 10. Query patterns → indices (the requested query list)

| Requested query | Mechanism |
|---|---|
| by id | primary key |
| by owner | `by_owner` secondary |
| by likes count | `by_likes` secondary (reverse scan = most-liked) |
| by comments count | `by_comments` secondary |
| by likes+comments | `by_engagement` secondary |
| by commented (parent) id | `by_parent` secondary (`= post_id` → its comments; `= NO_PARENT` → global top-level) |
| ranked global feed | `by_feed_rank` reverse scan (top-level by engagement; comments excluded) |
| newest top-level feed | `by_parent.equal_range(NO_PARENT)` reversed — ties within one secondary-key bucket break by primary `id`, so reverse iteration yields newest top-level posts first, server-side, no client filter. (This also covers brand-new 0-engagement posts, which `by_feed_rank` sinks to the tail.) |

**RAM budget note:** ~60 B per post row + index overhead; ~40 B per like row
(incl. the `uint128` pair index). 100 k posts + 1 M likes ≈ tens of MB of RAM
billed to the contract account — fine for a demo, budget-worthy at scale. The
contract account must stay RAM- and (for inline transfers) balance-funded.

---

## 11. Anti-abuse & Phase-2 hooks

- One-like-per-account + pay-again-on-re-like makes padding likes costly.
- Comments cost 1 UOS each; padding comments is costly and pays the target
  owner, not the farmer.
- **Self-engagement farming for rewards** is unresolved here by design — it
  belongs to Phase 2's payout, where eligibility (≥200) meets sybil
  resistance. Candidate mitigations to decide in Phase 2: exclude
  self-likes/self-comments from the reward engagement tally; weight by distinct
  funders; cap per-account contribution to a post's reward score.

---

## 12. Out of scope (later phases)

- Rewards pool distribution, ≥200 gate, monthly top-3 (Phase 2).
- Groups (open + membership), admin roster, DMs (Phase 3).
- Edit/delete of posts (block-data content is immutable by nature; a "delete"
  would only hide the index row).
- Notifications, follows, search.

---

## 13. Testing

- **Contract (`ultratests/`):** memo parsing (each cmd + malformed);
  fee-amount rejection; payment split (owner 0.9 / pool 0.1; post 1.0 pool);
  like dedup + revert on double-like; unlike decrement + re-like re-pays;
  comment increments parent; existence checks revert cleanly; banlist blocks
  all three; `by_feed_rank` excludes comments. Prune-window override pattern
  from the chatroom applies where counts are driven.
- **Frontend (`vitest`):** memo assembly round-trip; `get_block` decode + body
  parse; `(block_num, owner)` selection; engagement sort; content cache.
- **In-browser (Playwright):** post → appears in feed; like → count +1, 1 UOS
  prompt; comment → nested; unlike → count −1; profile/parent views.

---

## 14. Risks / open items

- **NET allowance** for large posts on Ultra's resource model — validate a
  128 KB post pushes cleanly from a normally-funded account before raising the
  cap.
- **Full-log node availability** — reads depend on the retained set; document
  the self-host fallback and monitor the 3 retained endpoints.
- **Contract account funding** — RAM (growing tables) + UOS balance (inline
  reward transfers). Must be provisioned and monitored.
- **New account provisioning + keys** — owner/active keys for the new social
  account; deployment runbook mirrors the chatroom's `DEPLOYMENT.md`.
