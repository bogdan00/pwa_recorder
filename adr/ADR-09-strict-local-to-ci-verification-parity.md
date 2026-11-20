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
  2. **Global mobile viewport overflow fence**: Continuously monitors `window.scrollX`, `documentElement.scrollWidth`, shell/sheet containers, and header controls on settled animation frames across every screen and state visited in any E2E test, failing automatically on any horizontal overflow.
  3. **Zero uncaught `pageerror`**: Fails any test that triggers an uncaught runtime exception.
  4. **Configurable CDP CPU throttling**: Attaches `Emulation.setCPUThrottlingRate` when `cpuThrottleRate > 1`.
- **Multi-profile Playwright projects ([`playwright.config.ts`](../playwright.config.ts))**: Run all CUJ specs in `mobile` (`390×844` @ 2× DPR, `1×` CPU), run layout/header/sheet-dense CUJs (`CUJ-01`, `CUJ-06`, `CUJ-08`, `CUJ-09`) in `mobile-compact` (`360×740` narrow Android/small-phone viewport), **and** run real-time audio/waveform/scrub CUJs (`CUJ-02`, `CUJ-03`) in `mobile-slow-cpu` (`4×` CPU slowdown) with `retries: 0`, `forbidOnly: true`, and fresh production preview server (`reuseExistingServer: false` under `PRECHECK=1` and `CI=true`).
- **Deterministic unit tests for `rAF`/async races**: Pair real-time animation & audio state transitions with controlled Vitest unit/component tests (e.g., [`src/components/__tests__/WaveformCanvas.test.tsx`](../src/components/__tests__/WaveformCanvas.test.tsx)).
- **Automated repository invariant enforcement ([`src/__tests__/repoInvariants.test.ts`](../src/__tests__/repoInvariants.test.ts))**: Fail `npm test` immediately if any CUJ spec imports raw `@playwright/test`, uses `waitForTimeout`/`setTimeout`, breaks 1-to-1 `cuj/CUJ-XX-*.md` ↔ `e2e/cuj-XX-*.spec.ts` ↔ `cuj/README.md` mapping, leaves an `adr/ADR-XX-*.md` unregistered in `adr/README.md`, breaks 1-to-1 `src/styles/themes/<id>.css` isolation, or introduces mobile overflow CSS footguns (bare `1fr 1fr` grids or `overflow-x: hidden` on `html`/`body`).
- **Unified & targeted pre-push & CI gates**: Run `npm run precheck` automatically via [`.githooks/pre-push`](../.githooks/pre-push) and run the exact same checks on both `push` and `pull_request` to `main` in [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). For docs-only pushes touching exclusively `README.md`, `AGENTS.md`, `cuj/**`, or `adr/**`, `.githooks/pre-push` runs the fast `repoInvariants.test.ts` check (~2s, still validating CUJ/ADR cross-links and registries) and `deploy.yml` skips redundant builds/Pages deploys via `paths-ignore` (`workflow_dispatch` remains available anytime).

## System Invariants
1. **Zero unstubbed external traffic in E2E**: All E2E specs run against the exact same deterministic local network envelope offline and in CI.
2. **Zero horizontal viewport overflow (`>= 360px`)**: Every screen, sheet, and sync state visited across E2E tests stays strictly within `[0, innerWidth]`.
3. **Zero fixed sleeps in E2E**: Only reactive Playwright assertions (`expect`, `expect.poll`, DOM timer progression) are permitted.
4. **Zero retries (`retries: 0`)**: Flakes are treated as defects and fixed at the root rather than hidden behind retries.
5. **Local gate ≥ CI gate**: Anything that can fail CI due to missing mocks, `.only`, stale builds, narrow-phone overflow, or slow-CPU timing races fails locally before `git push`.

## Consequences & Trade-offs
- **Pros:** Eliminates "passed locally, failed on GitHub Actions" surprises; exposes slow-phone UX bugs before users hit them; makes CI faster (~1m20s) by cutting out real network fetches and worker thrashing.
- **Cons:** Adding the `mobile-slow-cpu` project adds ~25–35s to local `precheck` (well worth the deterministic slow-device coverage).
