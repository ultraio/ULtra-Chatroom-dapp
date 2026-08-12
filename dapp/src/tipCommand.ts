// Client-side mirror of the contract's /tip grammar (chatroom.cpp parse_tip /
// parse_uos, design spec §3.1/§3.2). Pure + vitest-pinned so it can't drift from
// what the chain accepts. It exists for early, friendly validation and to build
// the exact quantity/memo the contract will re-check — the contract is still the
// authority. The quantity is derived from the amount with STRING math (never
// parseFloat) so the memo's amount and the transferred amount are byte-identical.
import { TIP_PREFIX, UOS_SYMBOL, MAX_MESSAGE_LENGTH } from './config';
import { byteLength } from './chatMath';

const UOS_PRECISION = 8;
// eosio account name charset, ≤12 chars (KB 01 §2). Mirrors the contract's
// name{} construction, which reverts on anything outside this.
const NAME_RE = /^[.1-5a-z]{1,12}$/;
// Same as the contract: ^[0-9]+(\.[0-9]{1,8})?$ — no sign, no leading/trailing
// dot, at most 8 fractional digits.
const AMOUNT_RE = /^[0-9]+(\.[0-9]{1,8})?$/;

export interface ParsedTip {
  ok: boolean;
  receiver?: string;
  amount?: string;
  quantity?: string; // "5.00000000 UOS"
  memo?: string; // canonical "/tip <receiver> <amount> [note]"
  error?: string;
}

/** True while the draft is (or is becoming) a tip command — used for routing + the hint. */
export function isTipCommand(raw: string): boolean {
  return raw.trimStart().startsWith(TIP_PREFIX);
}

interface Tokens {
  receiver: string;
  amount: string;
  note: string;
}

// Identical tokenization to the contract's parse_tip: after the "/tip " prefix,
// split receiver + amount on runs of ASCII spaces; note is the verbatim
// remainder (leading spaces trimmed, interior preserved).
function tokenize(afterPrefix: string): Tokens {
  let s = afterPrefix;
  const skip = () => {
    s = s.replace(/^ +/, '');
  };
  const take = (): string => {
    const i = s.indexOf(' ');
    if (i === -1) {
      const t = s;
      s = '';
      return t;
    }
    const t = s.slice(0, i);
    s = s.slice(i);
    return t;
  };
  skip();
  const receiver = take();
  skip();
  const amount = take();
  skip();
  return { receiver, amount, note: s };
}

export function parseTipCommand(raw: string, self: string): ParsedTip {
  // Keep leading detection but drop trailing whitespace (the note never keeps it).
  const trimmed = raw.trimStart().replace(/\s+$/, '');
  if (!trimmed.startsWith(TIP_PREFIX)) {
    return { ok: false, error: 'Usage: /tip <account> <amount> [note]' };
  }
  const { receiver, amount, note } = tokenize(trimmed.slice(TIP_PREFIX.length));

  if (!receiver || !amount) {
    return { ok: false, error: 'Usage: /tip <account> <amount> [note]' };
  }
  if (!NAME_RE.test(receiver)) {
    return { ok: false, error: `“${receiver}” is not a valid Ultra account name.` };
  }
  if (receiver === self) {
    return { ok: false, error: "You can't tip yourself." };
  }
  if (!AMOUNT_RE.test(amount)) {
    return { ok: false, error: 'Enter a valid amount — digits with up to 8 decimals (e.g. 5 or 2.5).' };
  }
  const quantity = toQuantity(amount);
  if (isZeroQuantity(quantity)) {
    return { ok: false, error: 'Tip must be greater than zero.' };
  }
  const memo = note ? `${TIP_PREFIX}${receiver} ${amount} ${note}` : `${TIP_PREFIX}${receiver} ${amount}`;
  if (byteLength(memo) > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Tip is too long — the whole line must fit ${MAX_MESSAGE_LENGTH} bytes.` };
  }
  return { ok: true, receiver, amount, quantity, memo };
}

// Decimal string -> "<int>.<frac8> UOS" using pure string math (no IEEE float):
// split on '.', strip leading zeros from the integer part, right-pad the
// fraction to 8 digits. `amount` is assumed to already match AMOUNT_RE.
function toQuantity(amount: string): string {
  const [intRaw, fracRaw = ''] = amount.split('.');
  const int = intRaw.replace(/^0+(?=\d)/, ''); // strip leading zeros, keep a lone 0
  const frac = (fracRaw + '0'.repeat(UOS_PRECISION)).slice(0, UOS_PRECISION);
  return `${int}.${frac} ${UOS_SYMBOL}`;
}

function isZeroQuantity(quantity: string): boolean {
  const digits = quantity.split(' ')[0].replace('.', '');
  return /^0+$/.test(digits);
}

// Read-side split of a stored /tip row, for feed rendering. Trusts the contract
// guarantee that a stored "/tip " row is a real forwarded tip (the caller also
// gates on the id high-water-mark before badging). Returns null for non-tips.
export function parseTipMessage(text: string): { receiver: string; amount: string; note: string } | null {
  if (!text.startsWith(TIP_PREFIX)) return null;
  const { receiver, amount, note } = tokenize(text.slice(TIP_PREFIX.length));
  if (!receiver || !amount) return null;
  return { receiver, amount, note };
}
