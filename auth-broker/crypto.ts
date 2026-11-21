import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const AES_KEY_BYTES = 32;

/**
 * Parses a 32-byte AES-256-GCM key from either a 64-char hex string or base64/base64url string.
 */
export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required.');
  }

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    key = Buffer.from(normalized, 'base64');
  }

  if (key.length !== AES_KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly ${AES_KEY_BYTES} bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/**
 * Encrypts a Google OAuth refresh token into a stateless, authenticated AES-256-GCM envelope.
 * Binds `aad` (the OAuth client ID) so ciphertexts cannot be replayed across clients.
 */
export function encryptRefreshToken(
  refreshToken: string,
  key: Buffer,
  aad: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(refreshToken, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypts and authenticates an encrypted refresh token envelope.
 * Returns null if the envelope is malformed, tampered with, or encrypted with a different key/AAD.
 */
export function decryptRefreshToken(
  envelope: string,
  key: Buffer,
  aad: string,
): string | null {
  if (typeof envelope !== 'string') return null;
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    return null;
  }

  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');

    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
      return null;
    }

    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');

    return plaintext.length > 0 ? plaintext : null;
  } catch {
    return null;
  }
}
