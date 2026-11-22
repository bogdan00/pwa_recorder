# ADR-09: Strict Local-to-CI E2E Parity, Network Fence, `4×` Slow-CPU Testing & Repo Invariants

- **Status:** Accepted
- **Date:** 2026-11-20
- **Related CUJs:** All CUJs ([`cuj/README.md`](../cuj/README.md))

## Context
Two classes of defects previously passed local verification and failed only after pushing to GitHub Actions:
1. **Offline-vs-online network drift**: Unstubbed third-party `<head>` requests (`accounts.google.com/gsi/client`, `fonts.googleapis.com`) failed silently behind a restricted local sandbox proxy, then loaded live over the internet on GitHub Actions runners and clobbered mocks or shifted layouts.
2. **Fast-CPU vs slow/contended-CPU timing drift**: Real-time `requestAnimationFrame` scrub momentum and audio timer flows passed on an unthrottled local CPU, then hit race conditions on contended 2-vCPU GitHub Actions runners (mirroring real slower mobile phones).
Additionally, config drift (`reuseExistingServer: true`, `forbidOnly: false` locally vs `retries: 1` in CI) masked flakes and risked testing stale builds.

## Decision
Make **local pre-push verification strictly match or exceed GitHub Actions CI**:
- **Mandatory shared Playwright fixture ([`e2e/fixtures.ts`](../e2e/fixtures.ts))**: Every `e2e/cuj-*.spec.ts` must import `{ test, expect }` from `./fixtures`, which enforces:
  1. **External network fence**: Deterministically neutralizes static `<head>` assets (`fonts.googleapis.com`, `fonts.gstatic.com`, `accounts.google.com/gsi/client`) so online CI never touches the public internet, and **aborts + fails loudly** on any other unstubbed external URL immediately locally.
  2. **Global mobile viewport overflow & iOS focus-zoom fence**: Continuously monitors `window.scrollX`, `documentElement.scrollWidth`, shell/sheet containers, header controls, and visible text form controls (`input`, `textarea`, `select` computed `font-size >= 16px` to prevent iOS Safari focus auto-zoom) on settled animation frames across every screen and state visited in any E2E test, failing automatically on any violation.
  3. **Zero uncaught `pageerror`**: Fails any test that triggers an uncaught runtime exception.
  4. **Configurable CDP CPU throttling**: Attaches `Emulation.setCPUThrottlingRate` when `cpuThrottleRate > 1`.
- **Multi-profile Playwright projects ([`playwright.config.ts`](../playwright.config.ts))**: Run all CUJ specs in `mobile` (`390×844` @ 2× DPR, `1×` CPU), run layout/header/sheet-dense CUJs (`CUJ-01`, `CUJ-06`, `CUJ-08`, `CUJ-09`) in `mobile-compact` (`360×740` narrow Android/small-phone viewport), **and** run real-time audio/waveform/scrub CUJs (`CUJ-02`, `CUJ-03`) in `mobile-slow-cpu` (`4×` CPU slowdown) with `retries: 0`, `forbidOnly: true`, and fresh production preview server (`reuseExistingServer: false` under `PRECHECK=1` and `CI=true`). On Linux, `mobile-slow-cpu` launches Chromium through [`e2e/single-cpu-chromium.sh`](../e2e/single-cpu-chromium.sh) (`taskset -c <worker % nproc>`) so all threads inside each throttled browser share a single vCPU while parallel workers still spread across cores, avoiding a Chromium Linux `ThreadCPUThrottler::HandleSignal` (`SIGUSR2`) cross-vCPU unsigned-underflow bug that otherwise stalls renderers for `42.95s` (`0xFFFFFFFF / 100 µs`).
- **Headless Chrome recording performance & audio-integrity gate ([`scripts/perfCheck.mjs`](../scripts/perfCheck.mjs))**: Run `npm run test:perf` against the production `dist/` bundle in an isolated headless Chromium instance (390×844 @ 3× mobile DPR, fed a real 440 Hz sine PCM stream via `--use-file-for-fake-audio-capture`, with the same offline external-network fence and Linux `single-cpu-chromium.sh` pinning under `4×` CPU throttling). Enforces strict non-regression budgets on BOTH unthrottled (`1×`) and slow-mobile (`4×` CPU) profiles:
  - Direct `MediaStreamTrackProcessor` capture (or off-main-thread `AudioWorklet` fallback; `scriptProcessor === 0`, zero worklet/capture errors) with zero `'playback'` `AudioContext` latencyHint calls (`playbackLatencyHintCalls === 0`),
  - Opt-in iOS looping `<audio>` keepalive stays OFF by default (`loopingAudioPlayCalls === 0`),
  - Canvas DPR capped `<= 2` even on 3× DPR phones,
  - Zero 60 Hz CSS `RecalcStyle` thrashing (`<= 25/sec`) and bounded layout cadence (`<= 20/sec`),
  - Sustained smooth rendering (`>= 52 fps` @ `1×` CPU, `>= 38 fps` @ `4×` single-vCPU; `p95` frame time `<= 25 ms` @ `1×`, `<= 52 ms` @ `4×`; `<= 2` / `<= 5` stalls `> 50 ms`) with zero playhead freeze/jump frames (`playheadStallFrames === 0` @ `1×`, `<= 2` @ `4×`; `playheadJumpFrames === 0`),
  - Healthy capture chunk delivery (`maxChunkIntervalMs <= 120 ms` @ `1×`, `<= 180 ms` @ `4×`) and continuous captured PCM with zero silent dropout runs (`zeroRuns === 0`) **and** zero phase/step-discontinuity clicks (`stepClicks === 0`, catching both HPF-ringing 10 ms underruns and 480-sample overflow drops),
  - OLED Blackout Mode suspends canvas `rAF` drawing while audio capture continues uninterrupted,
  - **Live Regression-Detection Canary & Pre-Submit Scorecard**: Injects the exact pre-fix regressions (60 Hz `.record-btn-halo` `pulse-ring` `RecalcStyle` animation + unconditional looping keepalive `<audio>`) into a throwaway page, proves `evaluateProfileResults` catches and fails on both, and prints a full benefit/budget scorecard at the end of `npm run precheck` (and appends it to `$GITHUB_STEP_SUMMARY` in GitHub Actions).
- **Deterministic unit tests for `rAF`/async races**: Pair real-time animation & audio state transitions with controlled Vitest unit/component tests (e.g., [`src/components/__tests__/WaveformCanvas.test.tsx`](../src/components/__tests__/WaveformCanvas.test.tsx)).
- **Automated repository invariant enforcement ([`src/__tests__/repoInvariants.test.ts`](../src/__tests__/repoInvariants.test.ts))**: Fail `npm test` immediately if any CUJ spec imports raw `@playwright/test`, uses `waitForTimeout`/`setTimeout`, breaks 1-to-1 `cuj/CUJ-XX-*.md` ↔ `e2e/cuj-XX-*.spec.ts` ↔ `cuj/README.md` mapping, leaves an `adr/ADR-XX-*.md` unregistered in `adr/README.md`, breaks 1-to-1 `src/styles/themes/<id>.css` isolation, drops `test:perf` / `test:formal` parity between `package.json` and `deploy.yml`, or introduces mobile overflow CSS footguns (bare `1fr 1fr` grids or `overflow-x: hidden` on `html`/`body`).
- **Unified & targeted pre-push & CI gates**: Run `npm run precheck` automatically via [`.githooks/pre-push`](../.githooks/pre-push) and run the exact same checks on both `push` and `pull_request` to `main` in [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). For docs-only pushes touching exclusively `README.md`, `AGENTS.md`, `cuj/**`, or `adr/**`, `.githooks/pre-push` runs the fast `repoInvariants.test.ts` check (~2s, still validating CUJ/ADR cross-links and registries) and `deploy.yml` skips redundant builds/Pages deploys via `paths-ignore` (`workflow_dispatch` remains available anytime).

## System Invariants
1. **Zero unstubbed external traffic in E2E & perf gates**: All browser tests run against the exact same deterministic local network envelope offline and in CI.
2. **Zero horizontal viewport overflow (`>= 360px`) & zero iOS focus-zoom inputs (`< 16px`)**: Every screen, sheet, and sync state visited across E2E tests stays strictly within `[0, innerWidth]`, and every visible focusable text `<input>`, `<textarea>`, and `<select>` maintains computed `font-size >= 16px`.
3. **Zero fixed sleeps in E2E**: Only reactive Playwright assertions (`expect`, `expect.poll`, DOM timer progression) are permitted.
4. **Zero retries (`retries: 0`)**: Flakes are treated as defects and fixed at the root rather than hidden behind retries.
5. **Local gate ≥ CI gate**: Anything that can fail CI due to missing mocks, `.only`, stale builds, narrow-phone overflow, slow-CPU timing races, or recording FPS/audio regressions fails locally before `git push`.
6. **Verified 60fps & glitch-free recording budgets**: `npm run test:perf` runs in both `npm run precheck` (local pre-push) and `.github/workflows/deploy.yml` (CI), failing automatically on janky rendering, `RecalcStyle` thrashing, keepalive regressions, or PCM dropouts.

## Consequences & Trade-offs
- **Pros:** Eliminates "passed locally, failed on GitHub Actions" surprises; exposes slow-phone UX and recording performance regressions before users hit them; makes CI faster by cutting out real network fetches and worker thrashing.
- **Cons:** Adding `mobile-slow-cpu` and `test:perf` adds ~40–50s to `precheck` (well worth deterministic slow-device and 60fps/audio-integrity protection).
