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

// The contract caps the memo with `check( memo.size() <= 256 )`, and C++
// std::string::size() counts UTF-8 BYTES, not code points. JS String.length
// counts UTF-16 code units, so it under-counts every non-ASCII char (an emoji
// is 2 units but 4 bytes) — validating on .length silently lets a message the
// chain will reject sail through and revert. Measure the exact same unit the
// contract does so the mirror can't drift.
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function validateMessage(raw: string): ValidationResult {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, text, error: 'Message cannot be empty.' };
  if (byteLength(text) > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      text,
      error: `Message too long (max ${MAX_MESSAGE_LENGTH} bytes — emoji and accented characters count as several each).`,
    };
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

// Shape of the wallet SDK's signTransaction response we actually depend on.
// `processed` is the on-chain execution receipt — present when the wallet
// broadcast the tx — and is the ONLY authority on whether the message
// committed (see commitFailureReason).
export interface SignResult {
  status?: string;
  code?: number;
  message?: string;
  data?: {
    transactionHash?: string;
    unsignedAuth?: string[];
    processed?: {
      receipt?: { status?: string } | null;
      except?: { message?: string; details?: Array<{ message?: string }> } | null;
      error_code?: number | null;
    } | null;
  };
}

// Antelope buries the assert text ("...sending too fast, wait 5 seconds...")
// under except.details[].message, falling back to except.message.
function exceptText(except: NonNullable<NonNullable<SignResult['data']>['processed']>['except']): string {
  if (!except) return 'The transaction was rejected on chain.';
  const detail = except.details?.map((d) => d?.message).filter(Boolean).join('; ');
  return detail || except.message || 'The transaction was rejected on chain.';
}

// A wallet "success" only means the transaction was accepted for broadcast —
// NOT that it committed (push-success != committed). A tx that reverts on
// chain (e.g. the 5s cooldown assert) still comes back status:'success' with a
// transactionHash; the failure lives in the execution receipt. Returns a
// human-facing reason when the tx did not commit, or null when it did. Kept
// pure + vitest-pinned for the same reason validateMessage is.
export function commitFailureReason(res: SignResult): string | null {
  if (res.status !== 'success') {
    return res.message || (res.code === 4001 ? 'You declined the transaction.' : 'Transaction failed.');
  }
  if (res.data?.unsignedAuth?.length) return 'Transaction was only partially signed.';
  const processed = res.data?.processed;
  if (processed) {
    if (processed.except != null || processed.error_code != null) return exceptText(processed.except);
    const status = processed.receipt?.status;
    if (status && status !== 'executed') return `The transaction did not execute (status: ${status}).`;
  }
  return null;
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
