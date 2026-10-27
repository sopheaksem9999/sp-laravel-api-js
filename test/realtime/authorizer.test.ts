import { describe, expect, it, vi } from 'vitest';
import type { ApiAuth } from '../../src';
import { echoPusherAuthorizer } from '../../src/realtime';

describe('echoPusherAuthorizer', () => {
  it('sends POST to /broadcasting/auth with socket_id, channel_name and auth headers', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ auth: 'test-key:test-signature' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const auth: ApiAuth = {
      getHeaders: async () => ({ Authorization: 'Bearer valid-token' }),
    };

    const authorizerFactory = echoPusherAuthorizer(auth, { fetch: fakeFetch as typeof fetch });
    const authorizer = authorizerFactory({ name: 'private-tenant.5' });

    const callback = vi.fn();
    authorizer.authorize('123.456', callback);

    await new Promise((r) => setTimeout(r, 10));

    expect(capturedUrl).toBe('/broadcasting/auth');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers).toMatchObject({
      Authorization: 'Bearer valid-token',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      socket_id: '123.456',
      channel_name: 'private-tenant.5',
    });
    expect(callback).toHaveBeenCalledWith(null, { auth: 'test-key:test-signature' });
  });

  it('retries once with fresh headers when receiving 401 and handleUnauthorized returns true', async () => {
    let attempt = 0;
    let token = 'expired-token';

    const fakeFetch = async (): Promise<Response> => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify({ message: 'Unauthenticated' }), { status: 401 });
      }
      return new Response(JSON.stringify({ auth: 'test-key:fresh-signature' }), { status: 200 });
    };

    const auth: ApiAuth = {
      getHeaders: async () => ({ Authorization: `Bearer ${token}` }),
      handleUnauthorized: vi.fn(async () => {
        token = 'fresh-token';
        return true;
      }),
    };

    const authorizer = echoPusherAuthorizer(auth, { fetch: fakeFetch as typeof fetch })({
      name: 'private-tenant.1',
    });

    const callback = vi.fn();
    authorizer.authorize('soc-1', callback);

    await new Promise((r) => setTimeout(r, 10));

    expect(attempt).toBe(2);
    expect(auth.handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, { auth: 'test-key:fresh-signature' });
  });

  it('fails with error and does not loop if second attempt is also 401', async () => {
    let attempt = 0;
    const fakeFetch = async (): Promise<Response> => {
      attempt++;
      return new Response(JSON.stringify({ message: 'Still Unauthenticated' }), { status: 401 });
    };

    const auth: ApiAuth = {
      getHeaders: async () => ({ Authorization: 'Bearer bad-token' }),
      handleUnauthorized: vi.fn(async () => true),
    };

    const authorizer = echoPusherAuthorizer(auth, { fetch: fakeFetch as typeof fetch })({
      name: 'private-tenant.1',
    });

    const callback = vi.fn();
    authorizer.authorize('soc-1', callback);

    await new Promise((r) => setTimeout(r, 10));

    expect(attempt).toBe(2);
    expect(auth.handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    const [err, data] = callback.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('status 401');
    expect(data).toBeNull();
  });

  it('calls callback with error on non-ok status or HTML 500 error page', async () => {
    const fakeFetch = async (): Promise<Response> => {
      return new Response('<html>500 Internal Server Error</html>', {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      });
    };

    const auth: ApiAuth = {
      getHeaders: async () => ({ Authorization: 'Bearer token' }),
    };

    const authorizer = echoPusherAuthorizer(auth, { fetch: fakeFetch as typeof fetch })({
      name: 'private-tenant.1',
    });

    const callback = vi.fn();
    authorizer.authorize('soc-1', callback);

    await new Promise((r) => setTimeout(r, 10));

    expect(callback).toHaveBeenCalledTimes(1);
    const [err, data] = callback.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('status 500');
    expect(data).toBeNull();
  });

  it('calls callback with error when network request rejects', async () => {
    const fakeFetch = async (): Promise<Response> => {
      throw new Error('Network offline');
    };

    const auth: ApiAuth = {
      getHeaders: async () => ({ Authorization: 'Bearer token' }),
    };

    const authorizer = echoPusherAuthorizer(auth, { fetch: fakeFetch as typeof fetch })({
      name: 'private-tenant.1',
    });

    const callback = vi.fn();
    expect(() => authorizer.authorize('soc-1', callback)).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));

    expect(callback).toHaveBeenCalledTimes(1);
    const [err, data] = callback.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Network offline');
    expect(data).toBeNull();
  });

  it('respects custom authEndpoint', async () => {
    let requestedUrl = '';
    const fakeFetch = async (url: string | URL): Promise<Response> => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ auth: 'ok' }), { status: 200 });
    };

    const auth: ApiAuth = {
      getHeaders: async () => ({}),
    };

    const authorizer = echoPusherAuthorizer(auth, {
      authEndpoint: 'https://api.example.com/api/v2/broadcasting/auth',
      fetch: fakeFetch as typeof fetch,
    })({ name: 'private-tenant.1' });

    authorizer.authorize('soc-1', vi.fn());
    await new Promise((r) => setTimeout(r, 10));

    expect(requestedUrl).toBe('https://api.example.com/api/v2/broadcasting/auth');
  });
});
