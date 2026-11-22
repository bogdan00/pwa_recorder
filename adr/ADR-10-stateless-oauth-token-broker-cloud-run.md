# ADR-10: Stateless Google Cloud Run OAuth Token Broker & Resilient Zero-Infra Fallback

- **Status:** Accepted
- **Date:** 2026-11-20
- **Related CUJs:** [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md)
- **Related ADRs:** [ADR-01](./ADR-01-zero-backend-offline-first-pwa.md), [ADR-05](./ADR-05-client-side-drive-oauth-and-conflict-safe-sync.md)

## Context
Google's client-side Identity Services Token Model (`google.accounts.oauth2.initTokenClient`) only issues 1-hour access tokens and never issues refresh tokens. Because Google requires `client_secret` on Web OAuth clients even when PKCE is enabled, a static GitHub Pages PWA cannot silently renew expired Google Drive tokens without exposing `client_secret` in public JavaScript. As a result, returning to the app after >1 hour or after a PWA update forced users to manually re-trigger OAuth popups.

At the same time, StoryTape must preserve its core privacy and offline-first invariants ([ADR-01](./ADR-01-zero-backend-offline-first-pwa.md), [ADR-05](./ADR-05-client-side-drive-oauth-and-conflict-safe-sync.md)): zero user database, zero audio or Drive files touching any StoryTape server, and full offline functionality plus clean zero-infra fallback for forks/local development.

## Decision
Introduce an optional, **stateless Google Cloud Run OAuth Token Broker** in [`auth-broker/`](../auth-broker/) paired with dual-mode OAuth support in [`src/drive/googleAuth.ts`](../src/drive/googleAuth.ts):

1. **Zero-database, zero-audio stateless Cloud Run service ([`auth-broker/`](../auth-broker/))**:
   - Built with zero third-party runtime dependencies on Node 22 built-ins (`node:http`, `node:crypto`).
   - Holds only four environment variables/secrets on Cloud Run: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` (32-byte key), and `ALLOWED_ORIGINS`.
   - Exposes three minimal JSON endpoints plus `/healthz`:
     - `POST /auth/exchange`: exchanges a single-use GIS Authorization Code (`redirect_uri: 'postmessage'`) with `https://oauth2.googleapis.com/token`, encrypts the returned Google `refresh_token` with **AES-256-GCM** (random 12-byte IV, authenticated associated data bound to `GOOGLE_CLIENT_ID`), and returns `{ accessToken, expiresIn, encryptedRefreshToken }`.
     - `POST /auth/refresh`: validates the `Origin` header, decrypts `encryptedRefreshToken`, exchanges it with Google for a fresh 1-hour `access_token`, re-encrypts any rotated `refresh_token`, and returns `{ accessToken, expiresIn, encryptedRefreshToken? }`.
     - `POST /auth/revoke`: decrypts `encryptedRefreshToken` (or uses `accessToken`) and revokes it at `https://oauth2.googleapis.com/revoke`.
   - Never persists user data, never logs tokens or secrets, and never accesses Google Drive files or audio.

2. **iOS-ITP-safe client-side encrypted refresh envelope ([`src/drive/googleAuth.ts`](../src/drive/googleAuth.ts))**:
   - Because GitHub Pages (`bogdan00.github.io`) and Cloud Run (`*.run.app`) run on different origins, cross-origin cookies are blocked or purged by Safari/iOS ITP.
   - Instead, the PWA persists `{ accessToken, expiresAt, encryptedRefreshToken, userEmail, userName, wasConnected }` in `localStorage` (`storytape.googleAuth.v1`) and sends `encryptedRefreshToken` in the JSON body to the broker.
   - When `VITE_GOOGLE_AUTH_BROKER_URL` is configured:
     - Initial sign-in uses GIS `initCodeClient({ ux_mode: 'popup', scope: 'drive' })` triggered synchronously inside the tap handler.
     - On app boot / PWA update reload, tab foreground (`visibilitychange`), returning `online`, proactive pre-expiry (~5 minutes before expiry), or transparent HTTP `401` retry in [`src/drive/syncService.ts`](../src/drive/syncService.ts), `googleAuth.ensureValidAccessToken()` silently refreshes via `POST /auth/refresh` (deduplicating concurrent calls) with **zero popups and zero user taps**.
     - Network/5xx refresh failures preserve `encryptedRefreshToken` so offline sessions automatically recover once back online; only `401`/`invalid_grant` (user-revoked grant) clears `encryptedRefreshToken` and transitions cleanly to `'expired'`.

3. **Zero-infra fallback (Option 1 — always available)**:
   - When `VITE_GOOGLE_AUTH_BROKER_URL` is unset (or if a refresh token is revoked), StoryTape falls back to client-side GIS `initTokenClient` with `localStorage` persistence, explicit `{ prompt: '', login_hint }` (never omitting `prompt`), and 1-tap reconnect from the Library header pill, Book top bar, chapter-save toast (`Reconnect & Sync`), and on-demand `cloud_only` chapter playback.

## System Invariants
1. **Zero server-side state or media access**: `auth-broker/` stores no database/sessions, logs no tokens/secrets, and never calls Google Drive APIs; all audio/book sync remains direct browser-to-Google-Drive.
2. **Confidential `client_secret` & authenticated encryption**: `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` exist exclusively in Cloud Run env/Secret Manager; refresh tokens returned to the browser are always AES-256-GCM encrypted with random 12-byte IVs and `client_id` AAD, and every response carries `Cache-Control: no-store`.
3. **Strict origin allowlist**: Every non-health endpoint in `auth-broker/` enforces `ALLOWED_ORIGINS` on both CORS preflight and `POST` requests (rejecting missing/unknown origins with HTTP `403`).
4. **Deduplicated silent refresh + transparent 401 retry**: Concurrent callers share one in-flight `/auth/refresh` request; Drive sync/downloads retry once on `401` after silent refresh before marking a session expired; transient offline/network errors never discard `encryptedRefreshToken`.
5. **Graceful zero-infra parity**: StoryTape must remain 100% functional without `VITE_GOOGLE_AUTH_BROKER_URL` via `localStorage`-persisted GIS tokens and 1-tap `prompt: ''` + `login_hint` reconnect.

## Consequences & Trade-offs
- **Pros:** Users stay signed in to Google Drive indefinitely across every PWA update, restart, and multi-week gap with zero re-login prompts; zero database maintenance; stays within Google Cloud Run's free tier in the same GCP project already used for OAuth; zero audio privacy compromise; clean fallback when unconfigured.
- **Cons:** Enabling silent multi-day refresh requires deploying the ~150-line stateless Cloud Run service once and setting `VITE_GOOGLE_AUTH_BROKER_URL` as a GitHub repository variable.
