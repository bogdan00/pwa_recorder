# AGENTS.md — StoryTape Engineering & Agent Conventions

This document defines the working agreements, architecture standards, and quality gates for **StoryTape** (`bogdan00/pwa_recorder`), a mobile-first, offline-capable React + TypeScript + Vite Progressive Web App deployed to GitHub Pages at `/pwa_recorder/`.

---

## 1. CUJ-First & ADR-Backed Development Workflow

StoryTape separates **what users experience** ([`cuj/`](./cuj/README.md)) from **what system invariants the architecture upholds** ([`adr/`](./adr/README.md)):

| Artifact | Purpose | When to Create or Update |
| --- | --- | --- |
| **CUJ** (`cuj/CUJ-XX-<slug>.md`) | Documents **user-facing behavior**: flows, screens, controls, edge cases, and acceptance criteria. | Any time you add a feature, alter UI controls/workflows, change user-visible states, or modify acceptance criteria. |
| **ADR** (`adr/ADR-XX-<slug>.md`) | Documents **architectural decisions & system invariants**: storage contracts, audio/rendering pipelines, OAuth/security boundaries, sync merge rules, or CI/testing guarantees. | Any time you introduce, change, relax, or supersede a technical invariant the system supports (e.g., changing IndexedDB schema/serialization, adding a backend, altering Drive OAuth scope or merge semantics, changing canvas/worklet threading, or modifying CI parity gates). |
| **Both CUJ + ADR** | Feature changes *both* user behavior and an underlying invariant. | Update/create both documents and **cross-link** them (`**Related ADRs:**` in the CUJ header and `**Related CUJs:**` in the ADR header). |

### Step-by-Step Workflow
1. **Start with the CUJ and/or ADR before coding.**
   - **User-facing change → CUJ**: Create `cuj/CUJ-XX-<slug>.md` or update the relevant existing CUJ, and register it in [`cuj/README.md`](./cuj/README.md) with priority (`P0`/`P1`) and 1-to-1 E2E spec mapping.
   - **System invariant / architecture change → ADR**: Create `adr/ADR-XX-<slug>.md` (with `Status`, `Context`, `Decision`, `System Invariants`, `Consequences & Trade-offs`, and `Related CUJs`) or supersede/amend the existing ADR, and register it in [`adr/README.md`](./adr/README.md).
   - **Cross-link** related CUJs and ADRs whenever a user journey depends on a specific architectural invariant (broken links and unregistered docs are caught automatically by `src/__tests__/repoInvariants.test.ts`).
2. **Write or update automated E2E coverage for every CUJ.**
   - Every CUJ must have a matching Playwright spec under `e2e/cuj-XX-<slug>.spec.ts` exercising the production bundle (`/pwa_recorder/`) at mobile phone viewport (`390×844` @ 2x DPR, touch enabled).
3. **Fix defects in application code, never weaken tests.**
   - If an E2E test uncovers a race condition, stale state, UI glitch, or sync defect, fix the underlying app code and keep the assertion strict.
4. **Update unit tests alongside domain changes.**
   - Pure logic (audio timeline, encoding, Drive sync merge, share link parsing, IndexedDB storage, PWA install prompt) belongs under `src/**/__tests__/*.test.ts(x)` and runs via Vitest.

---

## 2. Testing & E2E Standards

- **Zero fixed sleeps or arbitrary delays.**
  - Do **not** use `page.waitForTimeout(...)`, `setTimeout(...)`, or blind `recordMs` waits in `e2e/` (automatically enforced by `src/__tests__/repoInvariants.test.ts`).
  - Always wait reactively on observable page conditions: Playwright auto-waiting locators, `expect(locator)`, `expect.poll(...)`, live DOM timer progression (`waitForStudioTimer` in `e2e/helpers.ts`), telemetry output, or IndexedDB state.
- **Always use the strict E2E fixture (`e2e/fixtures.ts`) — never raw `@playwright/test`.**
  - Every `e2e/cuj-*.spec.ts` must import `{ test, expect }` from `./fixtures` (enforced by `src/__tests__/repoInvariants.test.ts`).
  - `e2e/fixtures.ts` enforces:
    1. **External network fence**: aborts and fails any unstubbed request outside `127.0.0.1`/`localhost` so missing third-party mocks fail immediately offline instead of only failing on online CI runners.
    2. **Global mobile viewport overflow fence**: continuously checks settled layout frames across every screen and sheet visited in any E2E test and fails automatically on horizontal overflow (`scrollX !== 0`, `scrollWidth > clientWidth`, or controls/sheets outside `[0, innerWidth]`).
    3. **Zero uncaught `pageerror`**: any uncaught runtime exception fails the test automatically.
    4. **Multi-profile mobile parity**: `playwright.config.ts` runs all specs in `mobile` (`390×844`), layout/header-dense specs (`CUJ-01`, `CUJ-06`, `CUJ-08`, `CUJ-09`) in `mobile-compact` (`360×740`), and timing/animation-sensitive specs (`CUJ-02`, `CUJ-03`) in `mobile-slow-cpu` (`4×` CPU slowdown) with `retries: 0` and fresh preview server (`PRECHECK=1`).
- **Unit-test real-time animation & async state races deterministically.**
  - Any `requestAnimationFrame` loop, scrub momentum, timer, or async audio/sync transition must have a deterministic Vitest unit/component test (e.g., `src/components/__tests__/WaveformCanvas.test.tsx`) in addition to CUJ E2E coverage.
- **Parallelize to the maximum.**
  - Keep every `test(...)` block self-contained with isolated browser state so `playwright.config.ts` (`fullyParallel: true`, multi-worker execution) runs specs concurrently without cross-test coupling.
  - Split large CUJs into independent parallel `test(...)` blocks whenever flows don't depend on each other (see `e2e/cuj-08-*.spec.ts` and `e2e/cuj-09-*.spec.ts`).
- **Verify against the production build.**
  - Playwright serves `dist/` via `vite preview` at `/pwa_recorder/`, matching GitHub Pages subpath behavior. Always run `npm run precheck` before pushing.

---

## 3. Architecture & Code Organization

Enforce clear separation of concerns across layers—avoid putting audio DSP, IndexedDB transactions, or Drive REST calls directly inside React view components:

- `src/types/models.ts` — Canonical TypeScript interfaces for books, recordings, drafts, settings, playback progress, and Drive manifests.
- `src/storage/` — Local persistence:
  - `db.ts`: IndexedDB wrapper. **Always store binary blobs as `{ buffer: ArrayBuffer, type: string }` and reconstruct `Blob` on read** to avoid iOS Safari WebKit / `fake-indexeddb` structured-clone bugs.
  - `settings.ts`: `localStorage` persistence, theme resolution, and build-time env defaults (`VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY`).
- `src/audio/` & `public/audio/` — Audio capture, timeline, encoding, quality presets, and device selection:
  - Keep real-time PCM capture off the main thread in `public/audio/pcm-capture-worklet.js` (~25ms flush cadence, 50 peaks/sec).
  - Route `AudioWorkletNode` (`numberOfOutputs: 1`) through a unity `GainNode(1)` to `ctx.destination` while `pcm-capture-worklet.js` outputs only an inaudible ultrasonic Nyquist keepalive (`±1e-5` / `-100 dBFS`, never copying mic audio to output) while active. This pulls frames reliably on iOS Safari WebKit AND prevents Chromium's 30-second `SilentSinkSuspender` from switching to `FakeAudioWorker` and dropping 10ms capture chunks. Use `AudioContext({ latencyHint: 'playback' })`, align `getUserMedia` sample rate to `ctx.sampleRate`, and guard `ctx.audioWorklet.addModule()` once per `AudioContext`.
  - Keep `RecordingEngine` lifecycle subscriptions separate from draft-loading effects; never clear active UI listeners inside async `dispose()`.
- `src/drive/` — Client-side Google Drive integration (zero backend):
  - `googleAuth.ts`: Google Identity Services OAuth using the narrow `drive.file` scope.
  - `driveClient.ts`: REST API v3 client (folders, resumable binary uploads, multipart JSON, Permissions API, capabilities inspection).
  - `googlePicker.ts`: Lazy-loaded Google Picker for unlocking shared Drive folders cleanly under `drive.file`.
  - `shareUtils.ts`: `#/join?...` invite link builder/parser, Drive URL extraction, clipboard & Web Share API helpers.
  - `syncService.ts`: Two-way sync engine.
- `src/player/` — Persistent `PlayerContext` managing audio playback, saved resume progress, sleep timer fade-out, and Media Session API lock-screen controls.
- `src/views/` & `src/components/` — Screen views and reusable UI components with co-located **Vanilla CSS** stylesheets.

---

## 4. Performance, Sync & Mobile PWA Invariants

### Rendering & Audio Smoothness
- **No layout thrashing or style recalculation in `requestAnimationFrame` loops.**
  - Cache CSS theme tokens once via `MutationObserver` on `data-theme` (never call `getComputedStyle()` per frame).
  - Cache canvas logical dimensions via `ResizeObserver` (never call `getBoundingClientRect()` per frame).
- **Decouple 60/120fps canvas animation from React state.**
  - Drive live waveform drawing directly from `RecordingEngine.getLiveRenderState()` inside `rAF` with smooth sub-chunk playhead interpolation; throttle React UI snapshots (`emit()`) during recording/playback to ~15Hz for timer display only.
- **Batch Canvas 2D draw calls** by fill/stroke style (a handful of `fill()`/`stroke()` calls per frame rather than per-bar draws).
- **Cancel scrub momentum immediately** whenever recording phase leaves `'paused'`.

### Offline-First & Multi-User Drive Sync
- **Always pull and merge before pushing** in `syncService.ts`:
  - Merge chapter lists by `recording.id` so concurrent co-narrators never overwrite each other.
  - Track deletions via `deletedRecordingIds` tombstones to prevent deleted chapters from resurrecting.
  - Preserve per-chapter `recordedBy` narrator attribution.
- **Enforce read-only Listener protection (`accessRole === 'reader'`)**:
  - Hide or disable record, edit, reorder, and delete UI for read-only shared books/libraries.
  - Skip all Drive upload/rename/write calls for read-only folders.
- **Do not gate silent background sync on `navigator.onLine`** (it is unreliable behind proxies/VPNs); attempt silent sync when an access token is valid and fall back gracefully on network failure.
- **Keep OAuth/GCP credentials out of end-user UI**:
  - Do not expose OAuth Client ID inputs, API key inputs, or Google Cloud Console setup/Testing-mode instructions in the app UI. Manage OAuth configuration via build defaults / repository variables (`VITE_GOOGLE_CLIENT_ID`).

### Styling, Mobile Ergonomics & GitHub Pages Subpath
- **Vanilla CSS only** (no TailwindCSS or CSS-in-JS). Use semantic tokens in `src/styles/tokens.css` & `src/styles/global.css` (zero hardcoded palette borders or ambient glows) supporting all 10 curated themes in `src/styles/themes.ts` (defaulting to **Pitch OLED**).
- **iOS Safari / Mobile PWA gestures**:
  - Call `googleAuth.requestSignIn()` and `AudioContext.resume()` synchronously inside click/tap handlers so iOS standalone PWAs don't block popups or audio playback.
  - Design for `100dvh`, safe-area insets, and thumb-zone controls.
- **Subpath integrity (`/pwa_recorder/`)**:
  - Resolve static assets (`icons/`, `audio/pcm-capture-worklet.js`, etc.) relative to `import.meta.env.BASE_URL`.
  - Preserve `public/privacy.html`, `public/terms.html`, and the Google Search Console verification meta tag in `index.html`.

---

## 5. Pre-Submit Hook & CI Gate

Before pushing any change to `main`, **all checks must pass**:

```bash
npm run precheck   # typecheck -> vitest unit tests -> production build -> parallel Playwright CUJ E2E
```

- **Local Git hook**: [`.githooks/pre-push`](./.githooks/pre-push) automatically runs `npm run precheck` on every `git push` (configured via `prepare` → `git config core.hooksPath .githooks`), using a fast `repoInvariants.test.ts`-only path for docs-only pushes (`README.md`, `AGENTS.md`, `cuj/**`, `adr/**`). Never bypass the hook with `--no-verify`.
- **GitHub Actions CI**: [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) runs `typecheck`, Vitest, production build, and parallel Playwright CUJ E2E tests before deploying to GitHub Pages (skipping docs-only commits via `paths-ignore`).
