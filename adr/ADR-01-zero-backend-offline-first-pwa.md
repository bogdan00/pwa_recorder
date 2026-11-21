# ADR-01: Zero-Backend Offline-First Subpath PWA & Install Experience

- **Status:** Accepted
- **Date:** 2026-11-19
- **Related CUJs:** [CUJ-01](../cuj/CUJ-01-book-management.md), [CUJ-06](../cuj/CUJ-06-library-browsing-themes.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md)

## Context
StoryTape is a personal/family audiobook recorder and player used primarily on mobile phones (iOS Safari and Android Chrome) at bedtime, often with poor or no network connectivity. Hosting a custom backend would add operational cost, privacy liability for family audio recordings, and single points of failure. GitHub Pages provides free static HTTPS hosting under a repository subpath (`/pwa_recorder/`).

## Decision
Build StoryTape as a **zero-backend, offline-first Progressive Web App** using React + TypeScript + Vite + `vite-plugin-pwa`, deployed statically to GitHub Pages at `/pwa_recorder/`:
- **Subpath-first build & routing**: Configure `base: '/pwa_recorder/'` for production/preview builds in [`vite.config.ts`](../vite.config.ts), use hash routing (`#/book/:id`, `#/record/:id`, `#/join?...`) in [`src/App.tsx`](../src/App.tsx) so static hosting never 404s on deep links, and resolve all static assets (`icons/`, `audio/pcm-capture-worklet.js`) via `import.meta.env.BASE_URL`.
- **Service Worker precaching**: Precache app shell, icons, and the AudioWorklet module via Workbox (`vite-plugin-pwa`, `registerType: 'prompt'`), and emit `.nojekyll` during CI deploy.
- **Public OAuth verification pages**: Ship static [`public/privacy.html`](../public/privacy.html), [`public/terms.html`](../public/terms.html), and Google Search Console verification metadata in [`index.html`](../index.html).
- **Early PWA install capture**: Initialize [`src/pwa/installPrompt.ts`](../src/pwa/installPrompt.ts) in [`src/main.tsx`](../src/main.tsx) before React mounts so Chromium's `beforeinstallprompt` event is never missed, invoke `prompt()` synchronously inside tap handlers, persist banner dismissals for 14 days while retaining a Settings install action, and provide a guided 2-step **Add to Home Screen** sheet ([`src/components/IosInstallGuideModal.tsx`](../src/components/IosInstallGuideModal.tsx)) for iOS/iPadOS Safari.

## System Invariants
1. **Zero data backend dependency**: Every core capability (creating books, recording, editing, encoding, playback, direct Drive sync, family sharing) works purely client-side without any StoryTape database or media server; an optional stateless OAuth token broker ([ADR-10](./ADR-10-stateless-oauth-token-broker-cloud-run.md)) may be configured solely to refresh Google OAuth tokens silently.
2. **Subpath integrity**: `manifest.webmanifest` (`id`, `start_url`, `scope` = `/pwa_recorder/`, `display` = `standalone`), `audio/pcm-capture-worklet.js`, icons, `privacy.html`, and `terms.html` must always resolve cleanly under `/pwa_recorder/`.
3. **Standalone-aware install UX**: Install banners never appear when running in standalone mode (`display-mode: standalone` or `navigator.standalone === true`).

## Consequences & Trade-offs
- **Pros:** Zero user-data server maintenance, complete user data ownership, works offline immediately after first load, installable on both Android and iOS.
- **Cons:** Hash URLs (`#/...`) are required for deep links on static GitHub Pages; without the optional stateless OAuth token broker ([ADR-10](./ADR-10-stateless-oauth-token-broker-cloud-run.md)), client-side Google OAuth access tokens expire after 1 hour.
