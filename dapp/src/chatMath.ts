// Pure helpers mirrored 1:1 against the contract's own rules (KB 05 §5 "math
// mirror" pattern) — kept tiny and vitest-pinned so UI validation can never
// silently drift from what the chain will actually accept/reject.
import { MAX_MESSAGE_LENGTH } from './config';
import type { ChatMessage } from './chatClient';

export interface ValidationResult {
  ok: boolean;
  text: string;
  error?: string;
}

export function validateMessage(raw: string): ValidationResult {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, text, error: 'Message cannot be empty.' };
  if (text.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, text, error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters).` };
  }
  return { ok: true, text };
}

// Append only rows whose on-chain id we don't already have, deduping within the
// fresh batch too. Every message has a unique table id, so id-presence is the
// whole identity check. This is what keeps the feed correct when two poll ticks
// overlap (the 1s interval + the post-send @sent trigger): both can fetch the
// same fresh row before either appends, and without this the row lands twice.
// Returns the SAME array reference when nothing is new, so an idle poll doesn't
// trigger needless reactive re-renders.
export function mergeNewMessages(existing: ChatMessage[], fresh: ChatMessage[]): ChatMessage[] {
  const seen = new Set(existing.map((m) => m.id));
  const additions: ChatMessage[] = [];
  for (const m of fresh) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    additions.push(m);
  }
  return additions.length ? [...existing, ...additions] : existing;
}

// Rewrites the raw on-chain check() text (see contracts/chatroom's
// COOLDOWN_SECONDS assert) into copy that reads like a terminal command's
// own error, rather than exposing the contract's internal wording verbatim.
export function friendlyChainError(raw: string): string {
  if (raw.includes('sending too fast')) {
    return 'Not so fast, wait at least 5 seconds between messages.';
  }
  return raw;
}

// Ultra account names are already opaque, ≤12-char base32 identifiers (KB 01
// §2) — there's no long hex address to truncate. We just surface it as-is.
export function shortenAddress(account: string): string {
  return account;
}

// Antelope RPC returns time_point_sec as "YYYY-MM-DDTHH:MM:SS" with no
// trailing Z, but it IS UTC — append it before parsing or every browser in a
// non-UTC timezone renders the wrong local time.
// 24h time-only, terminal-log-line style — the date is dropped deliberately
// (this is a live scrolling feed, not an archive view); falls back to a full
// date only when the message is old enough that bare HH:MM:SS would mislead.
export function formatTimestamp(sentAt: string): string {
  const iso = sentAt.endsWith('Z') ? sentAt : `${sentAt}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return sentAt;
  const isToday = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...(isToday ? {} : { year: 'numeric', month: '2-digit', day: '2-digit' }),
  });
}
