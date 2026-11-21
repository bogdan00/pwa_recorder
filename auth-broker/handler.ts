import type { IncomingMessage, ServerResponse } from 'node:http';
import { decryptRefreshToken, encryptRefreshToken } from './crypto.ts';

const DEFAULT_GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const MAX_BODY_BYTES = 8 * 1024;
const MAX_TOKEN_FIELD_LENGTH = 4096;

export interface AuthBrokerConfig {
  googleClientId: string;
  googleClientSecret: string;
  encryptionKey: Buffer;
  allowedOrigins: string[];
  googleTokenUrl?: string;
  googleRevokeUrl?: string;
}

interface GoogleOAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  corsOrigin?: string,
): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    Vary: 'Origin',
    'X-Content-Type-Options': 'nosniff',
  };
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Max-Age'] = '86400';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_BODY_BYTES) {
      return { ok: false, status: 413, error: 'payload_too_large' };
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return { ok: true, data: {} };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'invalid_json' };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
}

function readStringField(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const value = data[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TOKEN_FIELD_LENGTH) return null;
  return trimmed;
}

/**
 * Creates a stateless HTTP request handler for StoryTape's Google OAuth token broker.
 *
 * Privacy invariants:
 * - Zero database, zero session store, zero token logging.
 * - Never calls Google Drive APIs or touches user audio/files.
 * - Refresh tokens are always returned AES-256-GCM encrypted with a server-only key.
 */
export function createAuthBrokerHandler(
  config: AuthBrokerConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const allowedSet = new Set(
    config.allowedOrigins.map((origin) => origin.trim().replace(/\/+$/, '')),
  );
  const googleTokenUrl = config.googleTokenUrl ?? DEFAULT_GOOGLE_TOKEN_URL;
  const googleRevokeUrl = config.googleRevokeUrl ?? DEFAULT_GOOGLE_REVOKE_URL;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method || 'GET').toUpperCase();
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;

    // Cloud Run health check (no Origin header expected)
    if (pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) {
      if (method === 'HEAD') {
        res.writeHead(200, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    const originHeader =
      typeof req.headers.origin === 'string'
        ? req.headers.origin.trim().replace(/\/+$/, '')
        : '';

    if (!originHeader || !allowedSet.has(originHeader)) {
      sendJson(res, 403, { error: 'origin_not_allowed' });
      return;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': originHeader,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      });
      res.end();
      return;
    }

    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' }, originHeader);
      return;
    }

    if (
      pathname !== '/auth/exchange' &&
      pathname !== '/auth/refresh' &&
      pathname !== '/auth/revoke'
    ) {
      sendJson(res, 404, { error: 'not_found' }, originHeader);
      return;
    }

    const parsedBody = await readJsonBody(req);
    if (!parsedBody.ok) {
      sendJson(res, parsedBody.status, { error: parsedBody.error }, originHeader);
      return;
    }

    if (pathname === '/auth/exchange') {
      const code = readStringField(parsedBody.data, 'code');
      if (!code) {
        sendJson(
          res,
          400,
          { error: 'missing_code', message: 'Authorization code is required.' },
          originHeader,
        );
        return;
      }

      try {
        const tokenRes = await fetchImpl(googleTokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: config.googleClientId,
            client_secret: config.googleClientSecret,
            redirect_uri: 'postmessage',
          }),
        });

        const payload = (await tokenRes.json().catch(() => ({}))) as GoogleOAuthTokenResponse;
        if (!tokenRes.ok || !payload.access_token) {
          const status =
            payload.error === 'invalid_grant'
              ? 401
              : tokenRes.status >= 500
                ? 502
                : 400;
          sendJson(
            res,
            status,
            {
              error: payload.error || 'exchange_failed',
              message:
                payload.error_description ||
                'Could not exchange Google authorization code.',
            },
            originHeader,
          );
          return;
        }

        const encryptedRefreshToken = payload.refresh_token
          ? encryptRefreshToken(
              payload.refresh_token,
              config.encryptionKey,
              config.googleClientId,
            )
          : undefined;

        sendJson(
          res,
          200,
          {
            accessToken: payload.access_token,
            expiresIn: payload.expires_in ?? 3600,
            ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
            ...(payload.scope ? { scope: payload.scope } : {}),
          },
          originHeader,
        );
      } catch {
        sendJson(
          res,
          502,
          {
            error: 'upstream_error',
            message: 'Unable to reach Google OAuth token server.',
          },
          originHeader,
        );
      }
      return;
    }

    if (pathname === '/auth/refresh') {
      const envelope = readStringField(parsedBody.data, 'encryptedRefreshToken');
      if (!envelope) {
        sendJson(
          res,
          400,
          {
            error: 'missing_refresh_token',
            message: 'encryptedRefreshToken is required.',
          },
          originHeader,
        );
        return;
      }

      const refreshToken = decryptRefreshToken(
        envelope,
        config.encryptionKey,
        config.googleClientId,
      );
      if (!refreshToken) {
        sendJson(
          res,
          401,
          {
            error: 'invalid_grant',
            message: 'Stored refresh token is invalid. Please reconnect Google Drive.',
          },
          originHeader,
        );
        return;
      }

      try {
        const tokenRes = await fetchImpl(googleTokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: config.googleClientId,
            client_secret: config.googleClientSecret,
          }),
        });

        const payload = (await tokenRes.json().catch(() => ({}))) as GoogleOAuthTokenResponse;
        if (!tokenRes.ok || !payload.access_token) {
          const isRevoked =
            payload.error === 'invalid_grant' ||
            tokenRes.status === 400 ||
            tokenRes.status === 401;
          sendJson(
            res,
            isRevoked ? 401 : 502,
            {
              error: isRevoked ? 'invalid_grant' : 'upstream_error',
              message:
                payload.error_description ||
                (isRevoked
                  ? 'Google Drive authorization expired or was revoked. Please reconnect.'
                  : 'Google OAuth service is temporarily unavailable.'),
            },
            originHeader,
          );
          return;
        }

        const rotatedRefreshToken = payload.refresh_token
          ? encryptRefreshToken(
              payload.refresh_token,
              config.encryptionKey,
              config.googleClientId,
            )
          : undefined;

        sendJson(
          res,
          200,
          {
            accessToken: payload.access_token,
            expiresIn: payload.expires_in ?? 3600,
            ...(rotatedRefreshToken
              ? { encryptedRefreshToken: rotatedRefreshToken }
              : {}),
          },
          originHeader,
        );
      } catch {
        sendJson(
          res,
          502,
          {
            error: 'upstream_error',
            message: 'Unable to reach Google OAuth token server.',
          },
          originHeader,
        );
      }
      return;
    }

    // POST /auth/revoke
    const envelope = readStringField(parsedBody.data, 'encryptedRefreshToken');
    const accessToken = readStringField(parsedBody.data, 'accessToken');
    const tokenToRevoke =
      (envelope
        ? decryptRefreshToken(envelope, config.encryptionKey, config.googleClientId)
        : null) || accessToken;

    if (tokenToRevoke) {
      try {
        await fetchImpl(googleRevokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tokenToRevoke }),
        });
      } catch {
        // Best-effort revocation; client still clears local credentials
      }
    }

    sendJson(res, 200, { ok: true }, originHeader);
  };
}
