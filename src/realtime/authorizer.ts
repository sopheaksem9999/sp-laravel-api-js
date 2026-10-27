import type { ApiAuth } from '../core/create-api';

/**
 * Authentication payload returned by Pusher / Reverb channel authorization.
 */
export interface PusherAuthData {
  auth: string;
  channel_data?: string;
  shared_secret?: string;
}

/**
 * Callback passed by Pusher/Echo to authorize a channel.
 */
export type PusherAuthorizerCallback = (
  error: Error | null,
  authData: PusherAuthData | null,
) => void;

/**
 * Structural interface matching a Pusher-JS authorizer.
 */
export interface PusherAuthorizer {
  authorize(socketId: string, callback: PusherAuthorizerCallback): void;
}

/**
 * Options for `echoPusherAuthorizer`.
 */
export interface EchoPusherAuthorizerOptions {
  /**
   * The broadcasting authorization endpoint. Default: `'/broadcasting/auth'`.
   */
  authEndpoint?: string;
  /**
   * Injectable fetch implementation. Default: `globalThis.fetch`.
   */
  fetch?: typeof fetch;
}

/**
 * Returns an Echo authorizer factory for Pusher-protocol broadcasters (Laravel Reverb,
 * Pusher Channels, Soketi, laravel-websockets) that routes authorization through the
 * client's `ApiAuth` token and automatically retries once on 401.
 */
export function echoPusherAuthorizer(
  auth: ApiAuth,
  options: EchoPusherAuthorizerOptions = {},
): (channel: { name: string }, options?: unknown) => PusherAuthorizer {
  const endpoint = options.authEndpoint ?? '/broadcasting/auth';
  const fetchFn = options.fetch ?? globalThis.fetch;

  return (channel) => ({
    authorize(socketId, callback) {
      const run = async (): Promise<void> => {
        const doRequest = async (headers: Record<string, string>) => {
          return fetchFn(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...headers,
            },
            body: JSON.stringify({ socket_id: socketId, channel_name: channel.name }),
          });
        };

        try {
          let headers = await auth.getHeaders();
          let res = await doRequest(headers);

          if (res.status === 401 && typeof auth.handleUnauthorized === 'function') {
            const retried = await auth.handleUnauthorized({ headers });
            if (retried) {
              headers = await auth.getHeaders();
              res = await doRequest(headers);
            }
          }

          if (!res.ok) {
            callback(new Error(`Broadcasting auth failed with status ${res.status}`), null);
            return;
          }

          const data = (await res.json()) as PusherAuthData;
          callback(null, data);
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)), null);
        }
      };

      run();
    },
  });
}
