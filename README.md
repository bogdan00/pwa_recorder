# StoryTape — Mobile Audiobook Recorder & Player PWA

**StoryTape** is a mobile-first, offline-capable Progressive Web App designed for recording and listening to handmade audiobooks. Organize books with custom covers and metadata, record chapters with an interactive drag-to-scrub waveform studio, dial in studio-grade audio settings and microphones, listen in a minimalistic bedtime player, and sync everything cleanly into your Google Drive folder.

---

## Features

- **Project-Based Audiobook Library**: Create book projects with cover art (photo library or camera), title, author, narrator, dedication, language, description, and tags. Browse with search, tag filters, sorting, and **Continue Listening**.
- **Mobile Recording Studio**:
  - Big tactile **Start / Pause** button (`88px`) + smaller **Stop** button (`54px`) positioned in the thumb zone.
  - Real-time 60fps retina scrolling waveform driven by a 32-bit Float `AudioWorklet`.
  - **Pause → Drag-to-Scrub → Preview Play**: Drag the waveform smoothly with inertia to scroll back and listen to the last bit recorded.
  - **Safe Append + Optional Punch-In**: Tapping Record resumes safely at the end; when scrubbed back, a contextual **Re-record from MM:SS** pill lets you trim and re-record cleanly with a 15ms crossfade splice (plus 1-step Undo trim).
  - **Full Stop Name Prompt**: Prompts for the recording name (pre-filled with `Chapter N`) and optional notes before saving.
  - **Crash-Safe Draft Recovery**: Flushes 2-second Float32 PCM blocks to IndexedDB so interrupted sessions can be recovered.
- **Studio Audio Quality & Microphone Settings**:
  - Quick presets (`Voice Compact`, `Audiobook Standard`, `Studio Raw 320k`, `Master Archival WAV`) + full granular controls: Format (`Auto`, `M4A AAC`, `WebM Opus`, `WAV Lossless`), Sample Rate (`16`–`96 kHz`), Bitrate (`32`–`510 kbps`, VBR/CBR), WAV Bit Depth (`16`/`24`/`32-bit Float`), Mono/Stereo, Input Gain (`0.5×`–`2.5×`), 80 Hz Rumble Filter, Soft Anti-Clip Limiter, and individual browser DSP toggles.
  - Multi-microphone selector with permission unlock, live hot-plug updates, unplug fallback, and a built-in **Test Mic** dB level meter.
- **Minimalistic Audiobook Player**:
  - Floating mini-player + serene full-screen Now Playing sheet with waveform scrub bar, `-15s`/`+15s`, chapter auto-advance, playback speed (`0.75×`–`1.5×`), bedtime **Sleep Timer** (`10m`/`15m`/`30m`/`End of Chapter` with soft fade-out), saved resume positions, and iOS/Android lock-screen Media Session controls.
- **Offline-First Google Drive Sync & Multi-User Family Sharing**:
  - Stores every book in its own tidy Drive subfolder (`project.json`, `cover.jpg`, `01 - Chapter Name.m4a`) via Google Drive REST API v3 Resumable Uploads (`drive.file` scope).
  - Share either your entire **Family Library** or an individual **Book** directly in-app: invite collaborators by email as **Co-Narrator** (record & listen) or **Listener** (read-only), toggle *"Anyone with the link can listen"*, send a 1-tap `#/join?...` invite link (with Google Picker folder unlock), merge concurrent multi-narrator chapters safely with per-chapter attribution (`Read by Mom` / `Read by Dad`), and share individual chapters via native mobile Share Sheet.

---

## Local Development

```bash
npm install
npm run dev
```

Run checks & tests:

```bash
npm run typecheck   # TypeScript strict check
npm test            # Vitest unit & component tests
npm run build       # Production PWA build (dist/)
npm run test:e2e    # Parallel Playwright CUJ E2E tests against production build
npm run precheck    # Full pre-submit gate (all four steps above)
```

### Customer User Journeys (CUJ) & Pre-Submit Hook

- Every core user journey is documented under [`cuj/`](./cuj/README.md) (`CUJ-01` through `CUJ-09`) and covered by parallel reactive Playwright E2E specs under `e2e/`.
- A versioned Git pre-push hook (`.githooks/pre-push`) is automatically enabled during `npm install` (via `prepare` → `git config core.hooksPath .githooks`). Every `git push` runs `npm run precheck` and blocks pushing if typecheck, unit tests, production build, or any CUJ E2E test fails.
- To activate the hook manually without reinstalling: `git config core.hooksPath .githooks`.

---

## Deploying to GitHub Pages

This repository includes an automated workflow at `.github/workflows/deploy.yml` configured for **`https://bogdan00.github.io/pwa_recorder/`**:

1. Push to `main`.
2. In your GitHub repo, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
3. *(Optional)* To pre-configure your Google OAuth Client ID at build time, add a repository variable under **Settings → Secrets and variables → Actions → Variables**:
   - Name: `VITE_GOOGLE_CLIENT_ID`
   - Value: your Google Cloud OAuth 2.0 Web Client ID
4. Every push to `main` automatically runs typecheck + unit tests + production PWA build + parallel Playwright CUJ E2E tests before deploying to GitHub Pages.

---

## One-Time Google Drive OAuth Setup (~2 min)

StoryTape is a pure client-side PWA with no backend server and uses the narrow `drive.file` scope:

1. Open [Google Cloud Console](https://console.cloud.google.com/), create a free project, and enable the **Google Drive API**.
2. Go to **APIs & Services → OAuth consent screen**, pick **External** (Testing mode), and add your Google email under **Test users**.
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID** (**Web application**).
4. Under **Authorized JavaScript origins**, add:
   - `https://bogdan00.github.io` *(origin only — no `/pwa_recorder/` path)*
   - `http://localhost:5173` *(optional, for local dev)*
5. Copy the generated Client ID into **Settings → Google Drive** inside StoryTape (or set `VITE_GOOGLE_CLIENT_ID` in GitHub Actions Variables).

---

## Pinning on Mobile (PWA)

- **iPhone / iPad (Safari)**: Visit `https://bogdan00.github.io/pwa_recorder/` → tap **Share** → **Add to Home Screen**.
- **Android (Chrome)**: Visit `https://bogdan00.github.io/pwa_recorder/` → tap **⋮ Menu** → **Install app** / **Add to Home screen**.
