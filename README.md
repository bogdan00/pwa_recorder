# StoryTape

[![Deploy](https://github.com/bogdan00/pwa_recorder/actions/workflows/deploy.yml/badge.svg)](https://github.com/bogdan00/pwa_recorder/actions/workflows/deploy.yml)

Mobile-first, offline-capable Progressive Web App for recording, sharing, and listening to handmade audiobooks — built with React, TypeScript, and Vite with zero backend.

**Live App:** https://bogdan00.github.io/pwa_recorder/

## Highlights

- **Offline-first recording studio** — `AudioWorklet` PCM capture, 60fps scrubbable waveform, punch-in re-recording, tail trim with undo, and crash-safe IndexedDB drafts.
- **Quality & microphone lab** — Granular AAC/Opus/WAV settings, optional device-local 32-bit Float WAV masters, and a blind A/B Quality Lab (from any chapter or Settings Test Mic) to find your bitrate sweet spot.
- **Minimalistic player** — Persistent mini-player, speed control, sleep timer with fade-out, saved resume positions, and lock-screen Media Session controls.
- **Google Drive sync & family sharing** — Client-side sync (`drive.file` scope) with co-narrator conflict-safe merging, read-only listener mode, and 1-tap invite links.

## Development

```bash
npm install
npm run dev        # Start local dev server
npm run precheck   # Typecheck, Vitest, production build, and Playwright E2E
```

A versioned pre-push hook (`.githooks/pre-push`) is configured automatically via `npm install` and runs `npm run precheck` before pushing.

## Deployment (GitHub Pages)

Pushes to `main` build, test, stamp a UTC deploy version (`YYYY_MM_DD_HH_MM`), and deploy via [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml).

Optional GitHub Actions repository variables (**Settings → Secrets and variables → Actions → Variables**):

| Variable | Purpose |
| --- | --- |
| `VITE_BASE_PATH` | Subpath prefix (defaults to `/pwa_recorder/`) |
| `VITE_GOOGLE_CLIENT_ID` | Google Cloud OAuth 2.0 Web Client ID (`drive.file` scope) |
| `VITE_GOOGLE_API_KEY` | Google Picker API key for unlocking shared Drive folders |

## Documentation

- [Customer User Journeys (`cuj/`)](./cuj/README.md) — User-facing specs mapped 1-to-1 to Playwright E2E suites.
- [Architectural Decision Records (`adr/`)](./adr/README.md) — System invariants and technical decisions.
- [Engineering Conventions (`AGENTS.md`)](./AGENTS.md) — Workflow, architecture boundaries, and CI parity gates.
