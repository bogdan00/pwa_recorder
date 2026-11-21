import { createServer } from 'node:http';
import { parseEncryptionKey } from './crypto.ts';
import { createAuthBrokerHandler, parseAllowedOrigins } from './handler.ts';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const port = Number(process.env.PORT || '8080');
const googleClientId = requireEnv('GOOGLE_CLIENT_ID');
const googleClientSecret = requireEnv('GOOGLE_CLIENT_SECRET');
const encryptionKey = parseEncryptionKey(requireEnv('TOKEN_ENCRYPTION_KEY'));
const allowedOrigins = parseAllowedOrigins(
  process.env.ALLOWED_ORIGINS || 'https://bogdan00.github.io',
);

if (allowedOrigins.length === 0) {
  throw new Error('ALLOWED_ORIGINS must include at least one allowed origin.');
}

const handler = createAuthBrokerHandler({
  googleClientId,
  googleClientSecret,
  encryptionKey,
  allowedOrigins,
});

const server = createServer((req, res) => {
  void handler(req, res).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(
    `StoryTape OAuth token broker listening on :${port} (${allowedOrigins.length} allowed origin${allowedOrigins.length === 1 ? '' : 's'})`,
  );
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
