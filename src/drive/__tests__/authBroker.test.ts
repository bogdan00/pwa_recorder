// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decryptRefreshToken,
  encryptRefreshToken,
  parseEncryptionKey,
} from '../../../auth-broker/crypto';
import {
  createAuthBrokerHandler,
  parseAllowedOrigins,
} from '../../../auth-broker/handler';

async function startTestBroker(
  fetchImpl: typeof globalThis.fetch,
  overrides?: {
    allowedOrigins?: string[];
    googleClientId?: string;
    googleClientSecret?: string;
    encryptionKey?: Buffer;
  },
): Promise<{ server: Server; baseUrl: string; key: Buffer; clientId: string }> {
  const key = overrides?.encryptionKey ?? randomBytes(32);
  const clientId = overrides?.googleClientId ?? 'test-client-id.apps.googleusercontent.com';
  const handler = createAuthBrokerHandler(
    {
      googleClientId: clientId,
      googleClientSecret: overrides?.googleClientSecret ?? 'super-secret-value',
      encryptionKey: key,
      allowedOrigins: overrides?.allowedOrigins ?? ['https://bogdan00.github.io'],
    },
    fetchImpl,
  );

  const server = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    key,
    clientId,
  };
}

describe('Cloud Run stateless OAuth token broker (auth-broker)', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop()!;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    vi.restoreAllMocks();
  });

  it('encrypts and decrypts refresh tokens with AES-256-GCM, unique IVs, and clientId AAD binding', () => {
    const rawBase64 = randomBytes(32).toString('base64');
    const key = parseEncryptionKey(rawBase64);
    expect(key.length).toBe(32);

    const hexKey = parseEncryptionKey(key.toString('hex'));
    expect(hexKey.equals(key)).toBe(true);

    expect(() => parseEncryptionKey('too-short')).toThrow(/32 bytes/);

    const env1 = encryptRefreshToken('1//refresh-token-abc', key, 'client-a');
    const env2 = encryptRefreshToken('1//refresh-token-abc', key, 'client-a');
    expect(env1).not.toBe(env2); // random IV every encryption
    expect(env1.startsWith('v1.')).toBe(true);
    expect(env1).not.toContain('refresh-token-abc');

    expect(decryptRefreshToken(env1, key, 'client-a')).toBe('1//refresh-token-abc');
    expect(decryptRefreshToken(env1, key, 'client-b')).toBeNull(); // wrong AAD
    expect(decryptRefreshToken(env1, randomBytes(32), 'client-a')).toBeNull(); // wrong key

    // Tampered ciphertext rejected
    const parts = env1.split('.');
    parts[3] = `${parts[3].slice(0, -2)}AA`;
    expect(decryptRefreshToken(parts.join('.'), key, 'client-a')).toBeNull();
  });

  it('serves /healthz without Origin and enforces strict ALLOWED_ORIGINS on /auth/*', async () => {
    expect(
      parseAllowedOrigins(' https://bogdan00.github.io/ , http://localhost:5173 '),
    ).toEqual(['https://bogdan00.github.io', 'http://localhost:5173']);

    const { server, baseUrl } = await startTestBroker(vi.fn());
    servers.push(server);

    const healthRes = await fetch(`${baseUrl}/healthz`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ ok: true });

    // Missing Origin rejected
    const noOriginRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedRefreshToken: 'v1.a.b.c' }),
    });
    expect(noOriginRes.status).toBe(403);

    // Disallowed Origin rejected on both OPTIONS and POST
    const evilOpt = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    expect(evilOpt.status).toBe(403);

    // Allowed Origin succeeds on CORS preflight
    const okOpt = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://bogdan00.github.io' },
    });
    expect(okOpt.status).toBe(204);
    expect(okOpt.headers.get('access-control-allow-origin')).toBe(
      'https://bogdan00.github.io',
    );
  });

  it('exchanges auth code, refreshes silently with encrypted refresh token, rotates if Google rotates, and revokes on sign-out', async () => {
    const upstreamCalls: Array<{ url: string; body: string }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = String(init?.body ?? '');
      upstreamCalls.push({ url, body });

      if (url.includes('/token') && body.includes('grant_type=authorization_code')) {
        return new Response(
          JSON.stringify({
            access_token: 'ya29.initial-access',
            expires_in: 3600,
            refresh_token: '1//google-refresh-secret-1',
            scope: 'https://www.googleapis.com/auth/drive',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/token') && body.includes('grant_type=refresh_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'ya29.refreshed-access',
            expires_in: 3599,
            refresh_token: '1//google-refresh-secret-2',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/revoke')) {
        return new Response('', { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 400 });
    }) as unknown as typeof globalThis.fetch;

    const { server, baseUrl, key, clientId } = await startTestBroker(mockFetch);
    servers.push(server);

    // 1. Exchange authorization code
    const exchangeRes = await fetch(`${baseUrl}/auth/exchange`, {
      method: 'POST',
      headers: {
        Origin: 'https://bogdan00.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: '4/0auth-code-xyz' }),
    });
    expect(exchangeRes.status).toBe(200);
    expect(exchangeRes.headers.get('cache-control')).toBe('no-store');
    const exchangeText = await exchangeRes.text();
    expect(exchangeText).not.toContain('super-secret-value');
    expect(exchangeText).not.toContain('google-refresh-secret-1');
    const exchanged = JSON.parse(exchangeText) as {
      accessToken: string;
      expiresIn: number;
      encryptedRefreshToken: string;
    };
    expect(exchanged.accessToken).toBe('ya29.initial-access');
    expect(exchanged.expiresIn).toBe(3600);
    expect(
      decryptRefreshToken(exchanged.encryptedRefreshToken, key, clientId),
    ).toBe('1//google-refresh-secret-1');
    expect(upstreamCalls[0].body).toContain('redirect_uri=postmessage');
    expect(upstreamCalls[0].body).toContain('client_secret=super-secret-value');

    // 2. Refresh silently using encrypted envelope
    const refreshRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        Origin: 'https://bogdan00.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        encryptedRefreshToken: exchanged.encryptedRefreshToken,
      }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as {
      accessToken: string;
      expiresIn: number;
      encryptedRefreshToken?: string;
    };
    expect(refreshed.accessToken).toBe('ya29.refreshed-access');
    expect(refreshed.expiresIn).toBe(3599);
    expect(refreshed.encryptedRefreshToken).toBeTruthy();
    expect(
      decryptRefreshToken(refreshed.encryptedRefreshToken!, key, clientId),
    ).toBe('1//google-refresh-secret-2');
    expect(upstreamCalls[1].body).toContain(
      'refresh_token=1%2F%2Fgoogle-refresh-secret-1',
    );

    // 3. Revoke decrypted refresh token on sign-out
    const revokeRes = await fetch(`${baseUrl}/auth/revoke`, {
      method: 'POST',
      headers: {
        Origin: 'https://bogdan00.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        encryptedRefreshToken: refreshed.encryptedRefreshToken,
      }),
    });
    expect(revokeRes.status).toBe(200);
    expect(upstreamCalls[2].url).toContain('/revoke');
    expect(upstreamCalls[2].body).toContain(
      'token=1%2F%2Fgoogle-refresh-secret-2',
    );
  });

  it('distinguishes permanent invalid_grant (401) from transient Google 5xx (502)', async () => {
    let mode: 'revoked' | 'upstream_500' = 'revoked';
    const mockFetch = vi.fn(async () => {
      if (mode === 'revoked') {
        return new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Internal error', { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const { server, baseUrl, key, clientId } = await startTestBroker(mockFetch);
    servers.push(server);

    const envelope = encryptRefreshToken('1//some-refresh', key, clientId);

    // Revoked grant -> 401 invalid_grant
    const revokedRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        Origin: 'https://bogdan00.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ encryptedRefreshToken: envelope }),
    });
    expect(revokedRes.status).toBe(401);
    expect(await revokedRes.json()).toMatchObject({ error: 'invalid_grant' });

    // Transient 5xx -> 502 upstream_error (client must preserve refresh token)
    mode = 'upstream_500';
    const transientRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        Origin: 'https://bogdan00.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ encryptedRefreshToken: envelope }),
    });
    expect(transientRes.status).toBe(502);
    expect(await transientRes.json()).toMatchObject({ error: 'upstream_error' });

    // Corrupted envelope -> 401 invalid_grant without calling Google
    const badRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        Origin: 'https://bogdan00.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ encryptedRefreshToken: 'v1.bad.envelope.here' }),
    });
    expect(badRes.status).toBe(401);
  });
});
