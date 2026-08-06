import { describe, it, expect } from 'vitest';
import {
  validateMessage,
  shortenAddress,
  formatTimestamp,
  mergeNewMessages,
  byteLength,
  commitFailureReason,
  friendlyChainError,
} from '../chatMath';
import type { ChatMessage } from '../chatClient';
import { MAX_MESSAGE_LENGTH } from '../config';

const msg = (id: number): ChatMessage => ({ id, sender: 's', text: `m${id}`, sent_at: '2026-08-05T00:00:00' });

describe('validateMessage', () => {
  it('rejects an empty message', () => {
    expect(validateMessage('').ok).toBe(false);
  });

  it('rejects a message that is only whitespace', () => {
    expect(validateMessage('   ').ok).toBe(false);
  });

  it('trims surrounding whitespace from an otherwise valid message', () => {
    const result = validateMessage('  gm ultra  ');
    expect(result.ok).toBe(true);
    expect(result.text).toBe('gm ultra');
  });

  it('accepts a message exactly at the cap', () => {
    const atLimit = 'y'.repeat(MAX_MESSAGE_LENGTH);
    expect(validateMessage(atLimit).ok).toBe(true);
  });

  it('rejects a message one character over the cap', () => {
    const tooLong = 'x'.repeat(MAX_MESSAGE_LENGTH + 1);
    const result = validateMessage(tooLong);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too long/i);
  });

  // Bug: the UI counted UTF-16 code units (.length) but the contract counts
  // UTF-8 bytes (memo.size()). 65 emoji = 130 units (looked fine) = 260 bytes
  // (chain reverts). Validation must count the bytes the chain will see.
  it('rejects 65 emoji even though its .length is well under the cap', () => {
    const emoji = '😀'.repeat(65);
    expect(emoji.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH); // 130 UTF-16 units
    expect(byteLength(emoji)).toBeGreaterThan(MAX_MESSAGE_LENGTH); // 260 UTF-8 bytes
    expect(validateMessage(emoji).ok).toBe(false);
  });

  it('accepts emoji that fit within the byte cap', () => {
    const emoji = '😀'.repeat(64); // 256 bytes exactly
    expect(byteLength(emoji)).toBe(MAX_MESSAGE_LENGTH);
    expect(validateMessage(emoji).ok).toBe(true);
  });
});

describe('byteLength', () => {
  it('counts ASCII as one byte each', () => {
    expect(byteLength('gm')).toBe(2);
  });

  it('counts a 4-byte emoji as four bytes (not the 2 that .length reports)', () => {
    expect('😀'.length).toBe(2);
    expect(byteLength('😀')).toBe(4);
  });

  it('counts a 2-byte accented char as two bytes', () => {
    expect(byteLength('é')).toBe(2);
  });
});

describe('commitFailureReason (push-success != committed)', () => {
  const hash = { transactionHash: 'abc' };

  it('returns null for a cleanly executed transaction', () => {
    expect(
      commitFailureReason({ status: 'success', data: { ...hash, processed: { receipt: { status: 'executed' } } } }),
    ).toBeNull();
  });

  it('returns null when the wallet reports success with no receipt at all', () => {
    expect(commitFailureReason({ status: 'success', data: hash })).toBeNull();
  });

  it('surfaces a non-success wallet status', () => {
    expect(commitFailureReason({ status: 'error', message: 'nope' })).toBe('nope');
  });

  it('names a declined transaction from code 4001', () => {
    expect(commitFailureReason({ status: 'error', code: 4001 })).toMatch(/declined/i);
  });

  // The core bug: broadcast succeeded (status success + hash) but the contract
  // reverted the cooldown assert — the failure only lives in the receipt.
  it('detects an on-chain revert reported inside a "success" response', () => {
    const reason = commitFailureReason({
      status: 'success',
      data: {
        ...hash,
        processed: {
          receipt: { status: 'hard_fail' },
          except: {
            message: 'assertion failure',
            details: [{ message: 'assertion failure with message: chatroom: sending too fast, wait 5 seconds between messages' }],
          },
          error_code: 10,
        },
      },
    });
    expect(reason).toMatch(/sending too fast/);
    // and it flows through the humanizer the UI shows
    expect(friendlyChainError(reason as string)).toMatch(/wait at least 5 seconds/i);
  });

  it('flags a receipt whose status is not "executed" even without an except', () => {
    expect(
      commitFailureReason({ status: 'success', data: { ...hash, processed: { receipt: { status: 'expired' } } } }),
    ).toMatch(/did not execute/i);
  });

  it('flags a partially-signed transaction', () => {
    expect(commitFailureReason({ status: 'success', data: { ...hash, unsignedAuth: ['a@active'] } })).toMatch(/partially signed/i);
  });
});

describe('shortenAddress', () => {
  it('returns Ultra account names unchanged (already short, opaque names)', () => {
    expect(shortenAddress('1aa2aa3aa4aa')).toBe('1aa2aa3aa4aa');
  });
});

describe('formatTimestamp', () => {
  it('parses a time_point_sec string as UTC even without a trailing Z', () => {
    const formatted = formatTimestamp('2026-07-27T12:00:00');
    expect(formatted).not.toBe('2026-07-27T12:00:00');
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('falls back to the raw string if parsing fails', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});

describe('mergeNewMessages', () => {
  it('appends genuinely new rows in order', () => {
    expect(mergeNewMessages([msg(0)], [msg(1), msg(2)])).toEqual([msg(0), msg(1), msg(2)]);
  });

  // The core bug: two overlapping polls both fetch the same fresh row before
  // either has appended, so the same on-chain id arrives twice.
  it('drops a fresh row whose id is already present (concurrent-poll dup)', () => {
    expect(mergeNewMessages([msg(0)], [msg(0)])).toEqual([msg(0)]);
  });

  it('dedups repeats within the fresh batch itself', () => {
    expect(mergeNewMessages([], [msg(0), msg(0), msg(1)])).toEqual([msg(0), msg(1)]);
  });

  it('returns the SAME array reference when nothing is new (no reactive churn)', () => {
    const existing = [msg(0), msg(1)];
    expect(mergeNewMessages(existing, [msg(1)])).toBe(existing);
  });
});
