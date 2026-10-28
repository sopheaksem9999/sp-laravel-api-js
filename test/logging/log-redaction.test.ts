import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redactBody, redactHeaders, redactUrl } from '../../src/logging/internal';

interface Vectors {
  headers: { name: string; input: { headers: Record<string, string>; tenantHeader: string | null }; expected: Record<string, string> }[];
  bodies: { name: string; input: unknown; expected: unknown }[];
  urls: { name: string; input: string; expected: string }[];
}

// Shared with sp-laravel-api-dart (same file, byte for byte).
const vectors = JSON.parse(readFileSync(new URL('../vectors/log-redaction.json', import.meta.url), 'utf8')) as Vectors;

describe('log redaction vectors', () => {
  it('has vectors for headers, bodies and urls', () => {
    expect(vectors.headers.length).toBeGreaterThan(30);
    expect(vectors.bodies.length).toBeGreaterThan(60);
    expect(vectors.urls.length).toBeGreaterThan(25);
  });

  describe('headers', () => {
    for (const v of vectors.headers) {
      it(v.name, () => {
        expect(redactHeaders(v.input.headers, v.input.tenantHeader)).toEqual(v.expected);
      });
    }
  });

  describe('bodies', () => {
    for (const v of vectors.bodies) {
      it(v.name, () => {
        expect(redactBody(v.input)).toEqual(v.expected);
      });
    }
  });

  describe('urls', () => {
    for (const v of vectors.urls) {
      it(v.name, () => {
        expect(redactUrl(v.input)).toBe(v.expected);
      });
    }
  });

  it('redacts a Headers instance (lower-case names)', () => {
    const h = new Headers({ Authorization: 'Bearer x', Accept: 'application/json', 'X-Company-ID': '5' });
    expect(redactHeaders(h, 'X-Company-ID')).toEqual({
      authorization: '<redacted>',
      accept: 'application/json',
      'x-company-id': '<redacted>',
    });
  });

  it('does not mutate its input', () => {
    const body = { a: { password: 'p' }, list: [{ token: 't' }] };
    redactBody(body);
    expect(body).toEqual({ a: { password: 'p' }, list: [{ token: 't' }] });
  });

  it('describes binary, multipart and stream bodies without reading them', () => {
    expect(redactBody(new Uint8Array(7))).toBe('<7 bytes>');
    expect(redactBody(new ArrayBuffer(12))).toBe('<12 bytes>');
    expect(redactBody(new FormData())).toBe('<multipart>');
    expect(redactBody(new Blob(['abc']))).toBe('<multipart>');
    expect(redactBody(new ReadableStream())).toBe('<stream>');
    expect(redactBody(new URLSearchParams({ password: 'p', a: '1' }))).toBe('password=<redacted>&a=1');
  });

  it('truncates a large object after redaction', () => {
    const out = redactBody({ password: 'p', big: 'x'.repeat(5000) });
    expect(typeof out).toBe('string');
    expect((out as string).length).toBe(2048 + '…[truncated]'.length);
    expect(out as string).not.toContain('"p"');
  });

  it('honours a custom maxBodyLength', () => {
    expect(redactBody('abcdefgh', 4)).toBe('abcd…[truncated]');
    expect(redactBody({ a: 'x'.repeat(50) }, 10)).toBe('{"a":"xxxx…[truncated]');
  });

  it('does not split a surrogate pair at the cut', () => {
    const out = redactBody('a'.repeat(2047) + '\u{1F600}' + 'b') as string;
    expect(out).toBe('a'.repeat(2047) + '…[truncated]');
  });
});
