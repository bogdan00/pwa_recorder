# ADR-11: Two-Tier Formal Verification (Shared Specs, Explicit-State Model Checking & Z3 SMT Proofs)

- **Status:** Accepted
- **Date:** 2026-11-21
- **Related CUJs:** [CUJ-01](../cuj/CUJ-01-book-management.md), [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-03](../cuj/CUJ-03-scrub-preview-punchin.md), [CUJ-04](../cuj/CUJ-04-chapter-management.md), [CUJ-05](../cuj/CUJ-05-audiobook-player.md), [CUJ-06](../cuj/CUJ-06-library-browsing-themes.md), [CUJ-07](../cuj/CUJ-07-quality-and-devices.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md)
- **Related ADRs:** [ADR-02](./ADR-02-indexeddb-arraybuffer-storage-and-drafts.md), [ADR-03](./ADR-03-off-main-thread-pcm-capture-and-timeline.md), [ADR-05](./ADR-05-client-side-drive-oauth-and-conflict-safe-sync.md), [ADR-06](./ADR-06-shared-folder-unlock-with-google-picker.md), [ADR-07](./ADR-07-vanilla-css-token-theming-and-mobile-ergonomics.md), [ADR-08](./ADR-08-persistent-player-and-media-session.md), [ADR-09](./ADR-09-strict-local-to-ci-verification-parity.md)

## Context
StoryTape already enforces strong example-based Vitest unit tests and multi-profile Playwright CUJ E2E coverage ([ADR-09](./ADR-09-strict-local-to-ci-verification-parity.md)). However, example-based tests only verify the specific scenarios a human thought to script. Three classes of high-impact bugs routinely slip past example-based tests:

1. **Multi-step state-machine corner cases**: Unanticipated action sequences (for example, `record → pause → seek(0) → trimToPlayhead → undoLastTrim`, which originally left `RecordingEngine` in `phase === 'idle'` with non-zero audio duration!).
2. **Distributed concurrency & tie-breaking bugs**: Two co-narrators syncing offline edits in arbitrary interleavings or with identical `updatedAt` timestamps, which violates CRDT commutativity unless tie-breaking induces a strict total order.
3. **Unbounded arithmetic & boundary invariants**: Frame-index clamping, splice/fade gain bounds, and non-finite (`NaN`/`±Infinity`) inputs across arbitrary sample rates, durations, and channel counts.

At the same time, formal methods tools fail in practice when they either (a) slow down everyday `npm test` watch loops, or (b) verify a disconnected specification that silently drifts away from the shipping TypeScript implementation (*the spec-to-code gap*).

## Decision
Adopt a **Two-Tier, Shared-Specification Formal Verification Architecture** under [`src/formal/`](../src/formal/README.md):

### 1. Single Source of Truth — Shared Expression IR (`exprIr.ts`) & Declarative Specs (`src/formal/specs/`)
Define transition systems, algebraic laws, and safety invariants **once** using a typed declarative Expression IR ([`exprIr.ts`](../src/formal/core/exprIr.ts)) evaluated concretely in Tier 1 and compiled verbatim into Z3 SMT in Tier 2 ([`z3ExprCompiler.ts`](../src/formal/core/z3ExprCompiler.ts)) — making Tier-1 ↔ Tier-2 drift structurally impossible:
- [`syncMergeSpec.ts`](../src/formal/specs/syncMergeSpec.ts): Two-Phase Set (`2P-Set`) tombstone + total-order LWW-Register CRDT merge algebra and Google Drive access-role decision lattice (`owner` / `writer` / `reader`) in Shared IR.
- [`studioStateMachineSpec.ts`](../src/formal/specs/studioStateMachineSpec.ts): Recording Studio labeled transition system (LTS) over `(phase, duration, playhead, micActive, trackProcessorActive, workletActive, outputCtxRunning, previewActive, canUndoTrim, undoDuration, hasDraft)` in Shared IR.
- [`settingsLifecycleSpec.ts`](../src/formal/specs/settingsLifecycleSpec.ts): Studio Settings modal, segmented tabs (`recording` / `drive` / `app`), collapsible Advanced Audio disclosure, stacked Theme Switcher overlay, and live microphone test lifecycle LTS in Shared IR.
- [`pcmTimelineSpec.ts`](../src/formal/specs/pcmTimelineSpec.ts): PCM audio timeline mathematical contract (closed-interval frame clamping, exact extraction lengths, 1-step truncate/undo invertibility, raised-cosine fade bounds, storage-block conservation, crash-recovery peak reconciliation).
- [`audioDspAndQualitySpec.ts`](../src/formal/specs/audioDspAndQualitySpec.ts): Software AGC & soft-clipper mathematical contract (gain bounds, strict headroom separation `peakCeiling < SOFT_CLIP_THRESHOLD`, compressor-yield monotonicity, silence non-pumping, soft-clipper `1:1` identity & `-1 dBFS` ceiling) plus Recording Quality Monitor severity join-semilattice (`good < warn < critical`), non-masking of `critical` during warm-up, and bounded glitch-log memory.
- [`storageAndShareSpec.ts`](../src/formal/specs/storageAndShareSpec.ts): IndexedDB `ArrayBuffer` persistence invariants, cascade deletion, `#/join?...` share-link encode/parse round-trip contract, and audiobook player queue LTS.

### 2. Tier 1 — Always-On Executable Verification (`npm test`, ~1–2s, zero WASM overhead)
Runs on every `npm test` and `npm run test:watch` invocation directly against **real production TypeScript code**:
- **Explicit-State BFS Model Checker & Automated Conformance Engine ([`modelChecker.ts`](../src/formal/core/modelChecker.ts))**: Exhaustively explores *every* reachable state and transition in the finite canonical abstraction, verifies every safety invariant and reachability goal, and runs **`verifyConformance`** — automatically replaying maximal BFS-harvested traces against real production implementations ([`RecordingEngine`](../src/audio/recordingEngine.ts), [`PlayerProvider`](../src/player/PlayerContext.tsx), [`SettingsSheet`](../src/views/SettingsSheet.tsx) + [`useMicTest`](../src/hooks/useMicTest.ts)) while probing **both enabled transitions (positive conformance) and disabled actions (negative guard verification)** to close the spec-to-code gap.
- **Exhaustive Universal Quantifier & Algebraic Law Verifier ([`algebra.ts`](../src/formal/core/algebra.ts))**: Exhaustively checks Idempotence, Commutativity, Associativity (Join-Semilattice laws), Invertibility, Monotonicity, and truth tables over complete small-scope domains.
- **Systemic Anti-Drift Repository Invariants ([`repoInvariants.test.ts`](../src/__tests__/repoInvariants.test.ts))**: Enforces that every `create*Lts` spec has `verifyConformance` against real production code and that stateful/CRDT Z3 suites compile from shared specs via `z3ExprCompiler.ts`.

### 3. Tier 2 — Unbounded Mathematical $\forall$-Proofs via Z3 SMT (`npm run test:formal`, pre-push & CI)
Runs via dedicated Node Vitest configuration ([`vitest.formal.config.ts`](../vitest.formal.config.ts)) using `z3-solver` (WebAssembly `devDependency`, 0 bytes in production PWA bundle), wired into `npm run precheck` ([`.githooks/pre-push`](../.githooks/pre-push)) and GitHub Actions ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)):
- **Proof by Refutation (`UNSAT`) ([`z3Prover.ts`](../src/formal/core/z3Prover.ts))**: Compiles shared IR specs via [`z3ExprCompiler.ts`](../src/formal/core/z3ExprCompiler.ts) and refutes $\neg P(x)$ over **unbounded** integers, reals, and Booleans. `unsat` constitutes a mathematical proof that $\forall x,\, P(x)$ holds with zero counterexamples at any scale; `sat` prints a concrete counterexample model.
- **Inductive Invariant Proofs**: Proves safety for arbitrarily long execution traces ($n \to \infty$) in two SMT queries:
  1. **Base Case**: $\forall s.\ \mathrm{Init}(s) \implies \mathrm{Inv}(s)$
  2. **Inductive Step**: $\forall s, a, s'.\ \mathrm{Inv}(s) \land \mathrm{Step}(s, a, s') \implies \mathrm{Inv}(s')$
- **Pragmatic scope boundary**: Z3 is applied to subsystems with unbounded algebraic/stateful invariants (Drive sync CRDT & non-interference, Studio state machine & capture-backend exclusion, Settings modal/tab/mic-test lifecycle, PCM timeline arithmetic, Software AGC/soft-limiter stability, and Quality Monitor severity lattice). Browser-API, FFT DSP, and string-parsing contracts remain in Tier 1 executable proofs, deterministic DSP unit tests, E2E specs, and `scripts/perfCheck.mjs`.

## System Invariants
1. **CRDT Convergence & Tombstone Permanence**: Multi-user Drive sync merge forms a Join-Semilattice (Idempotent, Commutative, Associative) under deterministic total-order LWW tie-breaking (including `coverUpdatedAt`); once tombstoned in `deletedRecordingIds`, a recording ID can never be resurrected by any future merge sequence.
2. **Read-Only Listener Non-Interference**: Whenever `accessRole === 'reader'` (resolved from Drive capabilities or fallback), zero Drive write/rename/upload mutations are ever performed.
3. **Studio State-Machine Safety, Capture-Backend Exclusion & Zero Duplex Contention**: Across *all* reachable states (finite BFS, automated positive+negative `RecordingEngine` conformance, and unbounded Z3 induction):
   - $0 \le \text{playheadMs} \le \text{durationMs}$
   - $\neg(\text{trackProcessorActive} \land \text{workletActive})$ and $\text{micActive} \iff (\text{trackProcessorActive} \lor \text{workletActive}) \iff (\text{phase} = \text{recording})$
   - $\text{trackProcessorActive} \implies \neg\text{outputCtxRunning}$ (even after `record → pause → playPreview → resume/punchIn`, Chromium direct-track capture never leaves an `AudioContext` output stream running alongside mic capture)
   - $\text{previewActive} \iff (\text{phase} = \text{playing})$ and $\neg(\text{micActive} \land \text{previewActive})$ (strict mutual exclusion)
   - $(\text{phase} = \text{playing}) \implies (\text{durationMs} > 0)$
   - $(\text{phase} = \text{idle}) \implies (\text{durationMs} = 0 \land \text{playheadMs} = 0)$
   - $(\text{phase} = \text{recording}) \implies (\text{playheadMs} = \text{durationMs})$ (enforced by guarding `seekToMs` during recording)
   - Mid-await `discard()` / `pause()` / `dispose()` during `beginMicCapture` invalidates `captureEpoch`, cancels any pending `MediaStreamTrackProcessor` reader, and stops any late-arriving `MediaStream` tracks cleanly.
4. **PCM Audio Conservation & Invertibility**: `msToFrame`, `truncateAtFrame`, and `extractChannelData` stay strictly within $[0, \text{totalFrames}]$ for all IEEE-754 inputs (including `NaN`/`±Infinity`); `truncateAtFrame` followed by `undoTruncate` is bit-for-bit invertible; `buildStorageBlocks` → `loadFromChunks` preserves exact frame counts and sample values and reconciles stale persisted peaks; raised-cosine fade gain lies in $[0, 1]$ with zero amplitude at cut boundaries.
5. **Software AGC Stability, Soft-Limiter Ceiling & Quality-Monitor Severity Lattice**:
   - $\text{peakCeiling} < \text{SOFT\_CLIP\_THRESHOLD}$ (`0.56 < 0.7071`), AGC gain remains strictly in $[\text{minGain}, \text{maxGain}]$, never increases while `compressorReductionDb <= -1.5 dB`, and holds constant during silence; `softLimitSample(x)` is exact identity for $|x| \le \text{SOFT\_CLIP\_THRESHOLD}$ and bounded by $|\text{softLimitSample}(x)| \le \text{SOFT\_CLIP\_CEILING}$ for all finite inputs.
   - Quality monitor severity aggregation forms a bounded Join-Semilattice (`good < warn < critical`), warm-up `listening` never masks an active `critical` fault, glitch logs remain strictly bounded (`<= 30` entries), and opening/closing the diagnostics sheet is non-interfering with active recording.
6. **Storage, Queue & Share-Link Contracts**: IndexedDB `ArrayBuffer` round-trips preserve exact bytes and MIME types; project deletion cascades cleanly with zero orphan records; `buildJoinShareUrl` → `parseJoinInviteInput` is a faithful round-trip across all valid invites; real `PlayerProvider` enforces bounded queue indices, guarded `expandPlayer`/`setSleepTimer`, and `seek` finiteness.
7. **Settings Modal, Tab & Mic-Test Lifecycle Safety**: Across *all* reachable states (finite BFS, automated positive+negative `SettingsSheet` + `useMicTest` conformance, and unbounded Z3 induction over `openCount ∈ ℤ≥0`):
   - $\text{micTestActive} \implies (\text{open} \land \text{tab} = \text{recording})$ and $\neg\text{open} \implies \neg\text{micTestActive}$ (zero mic stream leaks across tab switches or modal closes, including mid-await `MicLevelTester.start()` cancellation)
   - $\text{themeSwitcherOpen} \implies \neg\text{micTestActive}$ and $(\text{open} \land \text{themeSwitcherOpen}) \implies (\text{tab} = \text{app})$
   - $\text{advancedOpen} \implies (\text{open} \land \text{tab} = \text{recording})$
8. **Local-to-CI Formal Verification Parity ([ADR-09](./ADR-09-strict-local-to-ci-verification-parity.md))**: `npm run precheck` (enforced by `.githooks/pre-push`) and `.github/workflows/deploy.yml` both execute `npm test` (Tier 1) **and** `npm run test:formal` (Tier 2).

## Consequences & Trade-offs
- **Real defects caught & fixed during adoption & audit**:
  1. `RecordingEngine.undoLastTrim()` failed to restore `phase` back to `'paused'` after undoing a trim-to-zero, violating `phase === 'idle' => durationMs === 0`.
  2. `RecordingEngine.seekToMs()` lacked a `phase === 'recording'` guard, `finalizeAndEncode()` paused the mic before checking its non-empty timeline precondition (caught by automated negative guard probing!), and `beginMicCapture()` lacked an async `captureEpoch` cancellation token against mid-await `discard()`/`pause()`.
  3. `PlayerContext` lacked loaded-book guards on `expandPlayer`/`setSleepTimer` and a finiteness guard on `seek`.
  4. `syncService.ts` lacked deterministic equal-timestamp LWW tie-breaking for metadata and `coverUpdatedAt`.
  5. `PcmTimeline` lacked IEEE-754 finiteness guards (`NaN`/`±Infinity`) and crash-recovery peak reconciliation in `loadFromChunks`.
  6. `googleAuth.ts` checked build-time `VITE_GOOGLE_AUTH_BROKER_URL` before runtime `window.__STORYTAPE_AUTH_BROKER_URL__`, breaking CI E2E parity when GitHub Actions injected the Cloud Run broker URL.
  7. `useMicTest.ts` lacked a prior-tester teardown on re-entrant `start()` and a post-await tester identity guard, allowing mid-await tab switches or modal closes to fire stale `onStarted()` callbacks or clobber newer sessions.
- **Pros:** Zero Tier-1 ↔ Tier-2 spec drift (Single IR), zero spec-to-code drift (automated positive+negative `verifyConformance`), fast everyday feedback (~1–2s in `npm test`), mathematical $\forall$-certainty on pre-push/CI, and zero production bundle overhead (`z3-solver` is dev-only).
- **Cons:** Adds `z3-solver` (~30 MB WASM) to `devDependencies` and ~3–5 seconds to `npm run precheck` and CI.
