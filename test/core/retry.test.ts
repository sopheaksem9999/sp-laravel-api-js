import { describe, expect, it } from 'vitest';
import { createRequester } from '../../src/core/request';

describe('Transient request retry', () => {
  it('retries idempotent GET on 503 up to maxAttempts and succeeds on recovery', async () => {
    let attempts = 0;
    const fetch: typeof globalThis.fetch = async () => {
      attempts++;
      if (attempts < 3) {
        return new Response(JSON.stringify({ message: 'Service Unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const request = createRequester({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxAttempts: 3, backoffMs: 10, jitter: false },
    });

    const result = await request<{ ok: boolean }>({ method: 'GET', path: '/items' });
    expect(result.data).toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it('does not retry POST requests by default', async () => {
    let attempts = 0;
    const fetch: typeof globalThis.fetch = async () => {
      attempts++;
      return new Response(JSON.stringify({ message: 'Bad Gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    };

    const request = createRequester({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxAttempts: 3, backoffMs: 10 },
    });

    await expect(request({ method: 'POST', path: '/items', body: { name: 'foo' } })).rejects.toMatchObject({
      status: 502,
    });
    expect(attempts).toBe(1);
  });

  it('retries POST when explicitly opted in via request options', async () => {
    let attempts = 0;
    const fetch: typeof globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(JSON.stringify({ message: 'Gateway Timeout' }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, data: { id: 1 } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };

    const request = createRequester({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxAttempts: 2, backoffMs: 10 },
    });

    const result = await request<{ id: number }>({
      method: 'POST',
      path: '/items',
      body: { name: 'foo' },
      retry: true,
    });
    expect(result.data).toEqual({ id: 1 });
    expect(attempts).toBe(2);
  });

  it('does not retry on 4xx client errors like 400 or 404', async () => {
    let attempts = 0;
    const fetch: typeof globalThis.fetch = async () => {
      attempts++;
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    const request = createRequester({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxAttempts: 3, backoffMs: 10 },
    });

    await expect(request({ method: 'GET', path: '/items/missing' })).rejects.toMatchObject({
      status: 404,
    });
    expect(attempts).toBe(1);
  });

  it('retries on network TypeError when networkErrors is true', async () => {
    let attempts = 0;
    const fetch: typeof globalThis.fetch = async () => {
      attempts++;
      if (attempts < 2) {
        throw new TypeError('Failed to fetch');
      }
      return new Response(JSON.stringify({ success: true, data: 'recovered' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const request = createRequester({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxAttempts: 2, backoffMs: 10, jitter: false },
    });

    const result = await request<string>({ method: 'GET', path: '/items' });
    expect(result.data).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('cancels immediately and rejects when AbortSignal aborts during retry backoff', async () => {
    let attempts = 0;
    const controller = new AbortController();

    const fetch: typeof globalThis.fetch = async () => {
      attempts++;
      // Trigger abort while the requester is sleeping in backoff
      setTimeout(() => controller.abort(new Error('User cancelled')), 15);
      return new Response(JSON.stringify({ message: 'Service Unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    };

    const request = createRequester({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxAttempts: 3, backoffMs: 2000, jitter: false },
    });

    await expect(
      request({ method: 'GET', path: '/items', signal: controller.signal }),
    ).rejects.toThrow('User cancelled');
    expect(attempts).toBe(1);
  });
});
