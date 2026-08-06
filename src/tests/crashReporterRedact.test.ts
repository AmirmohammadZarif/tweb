import {describe, expect, test} from 'vitest';
import {redact, redactValue} from '@lib/debug/redact';

// The crash reporter uploads the log ring buffer to the CRM. The CRM already
// holds every ticket message, so conversation text is not newly exposed — but
// credentials are NOT in the CRM, and leaking one there would turn a debugging
// aid into a credential leak. These tests pin that boundary.
describe('crashReporter redact', () => {
  test('redacts bearer tokens', () => {
    const out = redact('Authorization: Bearer 91|dR7kQmXpLz0aBcDeFgHiJkLmNoPqRsTuVwXyZ123');
    expect(out).not.toContain('dR7kQmXpLz0aBcDeFgHiJkLmNoPqRsTuVwXyZ123');
    expect(out).toContain('<redacted>');
  });

  test('redacts labelled secrets regardless of separator or case', () => {
    expect(redact('auth_key=abc123def456')).toContain('<redacted>');
    expect(redact('API_HASH: 8da85b0d5bfe62527e')).toContain('<redacted>');
    expect(redact('otp = 11111')).toContain('<redacted>');
    expect(redact('password:hunter2')).toContain('<redacted>');
  });

  test('redacts long hex blobs (MTProto auth keys, file references)', () => {
    const key = 'a3f21c9b4e7d0182a3f21c9b4e7d0182a3f21c9b4e7d0182';
    expect(redact('key=' + key)).not.toContain(key);
    expect(redact('saw ' + key + ' in transit')).toContain('<redacted:hex>');
  });

  test('leaves ordinary diagnostic text intact', () => {
    const line = 'setBubbleAgentTag failed for mid 4821 on peer 777000';
    expect(redact(line)).toBe(line);
    // Short hex (a colour, a chunk hash fragment) is not a credential.
    expect(redact('theme #a3f21c applied')).toBe('theme #a3f21c applied');
  });

  test('redactValue walks nested structures and arrays', () => {
    const out = redactValue({
      peerId: 777000,
      nested: {token: 'Bearer 91|dR7kQmXpLz0aBcDeFgHiJkLmNoPqRs'},
      list: ['auth_key=deadbeefcafe', 'plain text']
    });

    expect(JSON.stringify(out)).not.toContain('dR7kQmXpLz0aBcDeFgHiJkLmNoPqRs');
    expect(out.list[1]).toBe('plain text');
    expect(out.peerId).toBe(777000);
  });

  test('redactValue stops at the depth bound instead of recursing forever', () => {
    const cyclic: any = {level: 1};
    cyclic.self = cyclic;
    expect(() => redactValue(cyclic)).not.toThrow();
  });

  test('redactValue preserves non-string primitives', () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBe(null);
    expect(redactValue(true)).toBe(true);
  });
});
