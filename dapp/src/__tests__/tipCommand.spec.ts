import { describe, it, expect } from 'vitest';
import { isTipCommand, parseTipCommand, parseTipMessage } from '../tipCommand';

// The dapp mirrors the contract's grammar exactly (see chatroom.cpp parse_tip /
// parse_uos and the design spec §3.1/§3.2). These tests pin that mirror so the
// client can't drift from what the chain will accept, and so the amount the memo
// shows always equals the amount actually transferred.

describe('isTipCommand', () => {
  it('detects a tip command (with a trailing space mid-type)', () => {
    expect(isTipCommand('/tip ')).toBe(true);
    expect(isTipCommand('/tip bob 5')).toBe(true);
    expect(isTipCommand('   /tip bob 5')).toBe(true); // leading space tolerated
  });
  it('does not treat plain text or a bare /tip as a command', () => {
    expect(isTipCommand('hello')).toBe(false);
    expect(isTipCommand('/tips are nice')).toBe(false);
    expect(isTipCommand('/tip')).toBe(false); // no trailing space yet
  });
});

describe('parseTipCommand — valid', () => {
  it('parses receiver, amount, note and builds an 8dp quantity + canonical memo', () => {
    const r = parseTipCommand('/tip bob 5 gg wp', 'alice');
    expect(r.ok).toBe(true);
    expect(r.receiver).toBe('bob');
    expect(r.amount).toBe('5');
    expect(r.quantity).toBe('5.00000000 UOS');
    expect(r.memo).toBe('/tip bob 5 gg wp');
  });

  it('accepts no note', () => {
    const r = parseTipCommand('/tip bob 2', 'alice');
    expect(r.ok).toBe(true);
    expect(r.quantity).toBe('2.00000000 UOS');
    expect(r.memo).toBe('/tip bob 2');
  });

  it('formats a decimal amount to exactly 8 places (string math, no float drift)', () => {
    expect(parseTipCommand('/tip bob 5.5 x', 'alice').quantity).toBe('5.50000000 UOS');
    expect(parseTipCommand('/tip bob 0.1 x', 'alice').quantity).toBe('0.10000000 UOS');
    // 0.1 + 0.2 style values must not drift — string math keeps them exact.
    expect(parseTipCommand('/tip bob 0.3 x', 'alice').quantity).toBe('0.30000000 UOS');
    expect(parseTipCommand('/tip bob 5.1 x', 'alice').quantity).toBe('5.10000000 UOS');
  });

  it('accepts the minimum positive amount', () => {
    expect(parseTipCommand('/tip bob 0.00000001', 'alice').quantity).toBe('0.00000001 UOS');
  });

  it('canonicalizes whitespace but preserves the note interior', () => {
    const r = parseTipCommand('/tip   bob   5.5   gg  wp', 'alice');
    expect(r.ok).toBe(true);
    expect(r.receiver).toBe('bob');
    expect(r.amount).toBe('5.5');
    expect(r.memo).toBe('/tip bob 5.5 gg  wp'); // single sep spaces, note interior kept
  });

  it('normalizes a leading-zero integer part in the quantity', () => {
    expect(parseTipCommand('/tip bob 05 x', 'alice').quantity).toBe('5.00000000 UOS');
  });
});

describe('parseTipCommand — invalid', () => {
  const bad = (raw: string, self = 'alice') => parseTipCommand(raw, self);

  it('rejects a missing amount', () => {
    expect(bad('/tip bob').ok).toBe(false);
    expect(bad('/tip bob').error).toMatch(/usage/i);
  });
  it('rejects a missing receiver and amount', () => {
    expect(bad('/tip ').ok).toBe(false);
  });
  it('rejects an invalid account name (uppercase)', () => {
    expect(bad('/tip BOB 5').ok).toBe(false);
    expect(bad('/tip BOB 5').error).toMatch(/account name/i);
  });
  it('rejects an over-long account name (>12 chars)', () => {
    expect(bad('/tip abcdefghijklm 5').ok).toBe(false);
  });
  it('rejects tipping yourself', () => {
    expect(bad('/tip alice 5', 'alice').ok).toBe(false);
    expect(bad('/tip alice 5', 'alice').error).toMatch(/yourself/i);
  });
  it('rejects a non-numeric amount', () => {
    expect(bad('/tip bob 5abc').ok).toBe(false);
    expect(bad('/tip bob abc').ok).toBe(false);
  });
  it('rejects more than 8 decimal places', () => {
    expect(bad('/tip bob 5.123456789').ok).toBe(false);
  });
  it('rejects a trailing or leading decimal point', () => {
    expect(bad('/tip bob 5.').ok).toBe(false);
    expect(bad('/tip bob .5').ok).toBe(false);
  });
  it('rejects a negative or signed amount', () => {
    expect(bad('/tip bob -5').ok).toBe(false);
    expect(bad('/tip bob +5').ok).toBe(false);
  });
  it('rejects a zero amount', () => {
    expect(bad('/tip bob 0').ok).toBe(false);
    expect(bad('/tip bob 0').error).toMatch(/greater than zero/i);
    expect(bad('/tip bob 0.00000000').ok).toBe(false);
  });
  it('rejects a memo that exceeds the 256-byte cap', () => {
    const r = bad('/tip bob 5 ' + 'x'.repeat(300));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too long/i);
  });
});

// parseTipMessage is the read-side helper used by the feed to render a stored,
// contract-verified /tip row. It trusts the contract's guarantee (the row only
// exists because a matching amount was forwarded), so it just splits for display.
describe('parseTipMessage (feed rendering)', () => {
  it('splits a stored tip row into receiver/amount/note', () => {
    expect(parseTipMessage('/tip bob 5 gg wp')).toEqual({ receiver: 'bob', amount: '5', note: 'gg wp' });
  });
  it('handles a note-less tip', () => {
    expect(parseTipMessage('/tip bob 2')).toEqual({ receiver: 'bob', amount: '2', note: '' });
  });
  it('returns null for a non-tip message', () => {
    expect(parseTipMessage('just a normal message')).toBeNull();
  });
});
