# Emoji picker in the message composer — design

**Date:** 2026-08-06
**Status:** Approved, ready to implement

## Goal

Add a modern emoji picker to the chat composer: a 😀 button opens a searchable
picker; selecting an emoji inserts it into the message at the cursor. Emoji are
raw Unicode and go straight into the on-chain memo, so this is purely a UI
affordance over the existing send path.

## Library choice

`emoji-picker-element` (Nolan Lawson) — a lightweight, accessible,
framework-agnostic Web Component. Emoji data lives in a **separate JSON**
(`emoji-picker-element-data`), loaded async and IndexedDB-cached, so the main
bundle stays small. Chosen over `vue3-emoji-picker` (bundles ~100–200KB of data
into the main JS) and `emoji-mart` (React-first, heavy).

The default `dataSource` is a jsdelivr CDN URL. We override it to a
**locally-bundled** copy of the JSON so nothing is fetched off-origin — keeps
the dapp self-contained and CSP-safe, matching the repo's lean, 3-dep ethos.

## Interaction with the 256-byte cap

The composer already validates message length in **UTF-8 bytes** (`byteLength`,
matching the contract's `check(memo.size() <= 256)`), and each emoji is ~4
bytes. Inserting via the picker therefore reuses the existing byte counter and
over-limit disable logic unchanged. The only addition is a **byte guard**: an
insert that would exceed 256 bytes is a no-op (the counter flashes), so the
picker can never build a message the chain would reject.

## Architecture

Changes are localized to the composer plus one pure helper and two small config
touches — no new component files (the picker *is* the third-party element).

- **`chatMath.ts`** — new pure `insertAtCaret(text, insert, start, end)`
  returning `{ text, caret }`. Splices `insert` into `text`, replacing any
  selection `[start, end)`, and reports the new caret position (just past the
  inserted text). Pure + vitest-pinned, like the other helpers.
- **`vite.config.ts`** — `@vitejs/plugin-vue` `template.compilerOptions`
  `isCustomElement: (tag) => tag === 'emoji-picker'` so Vue / `vue-tsc` treat
  `<emoji-picker>` as a custom element (no compile warning).
- **`MessageInput.vue`**
  - `import 'emoji-picker-element'` (auto-registers the element).
  - `import dataUrl from 'emoji-picker-element-data/en/emojibase/data.json?url'`;
    bind `:data-source="dataUrl"`.
  - A 😀 toggle button left of Send, disabled when `!connected || busy`.
  - A popover above the composer holding `<emoji-picker>`, shown when open.
  - Track the input's `selectionStart/End` on input/select/click.
  - On `emoji-click`, take `event.detail.unicode`, run `insertAtCaret`, apply
    only if within the byte cap, update `draft`, then on `nextTick` restore the
    caret and refocus the input.
  - Ultra brand tokens set as CSS custom props on `<emoji-picker>`
    (`--background`, `--border-color`, accent `#7A29FF`, warm dark surfaces).

## Data flow

```
click 😀  → toggle popover open
type/search in picker (its own UI, shadow DOM)
click emoji → emoji-click{detail.unicode}
           → insertAtCaret(draft, unicode, selStart, selEnd) → {text, caret}
           → if byteLength(text) <= 256: draft = text
           → nextTick: input.setSelectionRange(caret, caret); input.focus()
```

Picker stays **open** after a pick (multi-insert, Slack-style). Closes on:
toggle button, outside-click (document listener that ignores clicks inside the
picker/button), or Escape.

## Error / edge handling

- Over-byte-cap insert → no-op + counter flash; never produces an invalid draft.
- Not connected / busy → emoji button disabled (mirrors the input).
- Selection replaced correctly (insert over a highlighted range).
- Caret restored after Vue's controlled-value update (needs `nextTick`).

## Testing

- Unit (vitest, `chatMath.spec.ts`): `insertAtCaret` at start / middle / end,
  replacing a selection, caret position correctness, and the byte-guard no-op.
- `vue-tsc --noEmit` + `vite build` clean.
- Manual QA of the popover (open/close/insert/caret) against the dark theme.
- The Web Component itself is third-party and not unit-tested.

## Out of scope (YAGNI)

Skin-tone persistence, recents/frequently-used, custom emoji, Twemoji image
rendering (we use native system-font emoji — zero image weight, and the memo is
Unicode regardless).
