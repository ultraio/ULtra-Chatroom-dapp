import { describe, it, expect } from 'vitest';
import { validateMessage, shortenAddress, formatTimestamp } from '../chatMath';
import { MAX_MESSAGE_LENGTH } from '../config';

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
