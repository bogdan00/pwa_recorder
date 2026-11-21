# StoryTape Stateless OAuth Token Broker (Google Cloud Run)

A zero-dependency, zero-database Node 22 Cloud Run service that keeps StoryTape signed in to Google Drive indefinitely across PWA updates and multi-day gaps — without ever storing user data or touching audio files.

## Privacy & Security Model
- **Zero database / zero state**: Stores nothing on disk or in memory.
- **Zero Drive/audio access**: Never calls Google Drive APIs; audio and books continue to sync directly from your browser to your Google Drive.
- **Confidential secrets**: `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` live exclusively in Cloud Run / Secret Manager.
- **AES-256-GCM refresh envelopes**: Google's long-lived `refresh_token` is encrypted with a server-only 256-bit key (random 12-byte IV, `GOOGLE_CLIENT_ID` AAD) and stored client-side in `localStorage` so iOS Safari standalone PWAs (ITP) never lose sessions.
- **Strict origin allowlist**: Every `/auth/*` request verifies the `Origin` header against `ALLOWED_ORIGINS`.

## One-Time Deploy to Google Cloud Run

Run from the repository root inside the same GCP project as your OAuth Client ID:

### 1. Generate a 32-byte encryption key
```bash
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

### 2. Deploy to Cloud Run (free tier eligible, scales to zero)
```bash
gcloud run deploy storytape-auth-broker \
  --source ./auth-broker \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 3 \
  --memory 128Mi \
  --cpu 1 \
  --set-env-vars "GOOGLE_CLIENT_ID=<YOUR_CLIENT_ID>,GOOGLE_CLIENT_SECRET=<YOUR_CLIENT_SECRET>,TOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY},ALLOWED_ORIGINS=https://bogdan00.github.io"
```
*(Recommended for production: store `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` in Google Secret Manager and attach them via `--set-secrets`.)*

### 3. Connect StoryTape's GitHub Pages build to the broker
In GitHub → **Settings → Secrets and variables → Actions → Variables**, add:

- `VITE_GOOGLE_AUTH_BROKER_URL` = `https://storytape-auth-broker-<hash>-uc.a.run.app` (the Service URL printed by `gcloud run deploy`, without a trailing slash)

Trigger a deploy (or push to `main`). StoryTape will automatically switch to the Authorization Code + silent refresh flow while keeping the zero-infra GIS fallback intact if the variable is ever unset.

## Endpoints
- `GET /healthz` — Cloud Run readiness/liveness probe (`200 { "ok": true }`)
- `POST /auth/exchange` — Exchanges a GIS popup authorization `code` (`redirect_uri: "postmessage"`) for `{ accessToken, expiresIn, encryptedRefreshToken }`
- `POST /auth/refresh` — Decrypts `encryptedRefreshToken` and returns a fresh `{ accessToken, expiresIn, encryptedRefreshToken? }`
- `POST /auth/revoke` — Decrypts and revokes the Google token on Sign Out
