# ADR-11: Two-Tier Formal Verification (Shared Specs, Explicit-State Model Checking & Z3 SMT Proofs)

- **Status:** Accepted
- **Date:** 2026-11-21
- **Related CUJs:** [CUJ-01](../cuj/CUJ-01-book-management.md), [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-03](../cuj/CUJ-03-scrub-preview-punchin.md), [CUJ-04](../cuj/CUJ-04-chapter-management.md), [CUJ-05](../cuj/CUJ-05-audiobook-player.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md)
- **Related ADRs:** [ADR-02](./ADR-02-indexeddb-arraybuffer-storage-and-drafts.md), [ADR-03](./ADR-03-off-main-thread-pcm-capture-and-timeline.md), [ADR-05](./ADR-05-client-side-drive-oauth-and-conflict-safe-sync.md), [ADR-06](./ADR-06-shared-folder-unlock-with-google-picker.md), [ADR-08](./ADR-08-persistent-player-and-media-session.md), [ADR-09](./ADR-09-strict-local-to-ci-verification-parity.md)

## Context
StoryTape already enforces strong example-based Vitest unit tests and multi-profile Playwright CUJ E2E coverage ([ADR-09](./ADR-09-strict-local-to-ci-verification-parity.md)). However, example-based tests only verify the specific scenarios a human thought to script. Three classes of high-impact bugs routinely slip past example-based tests:

1. **Multi-step state-machine corner cases**: Unanticipated action sequences (for example, `record → pause → seek(0) → trimToPlayhead → undoLastTrim`, which originally left `RecordingEngine` in `phase === 'idle'` with non-zero audio duration!).
2. **Distributed concurrency & tie-breaking bugs**: Two co-narrators syncing offline edits in arbitrary interleavings or with identical `updatedAt` timestamps, which violates CRDT commutativity unless tie-breaking induces a strict total order.
3. **Unbounded arithmetic & boundary invariants**: Frame-index clamping, splice/fade gain bounds, and non-finite (`NaN`/`±Infinity`) inputs across arbitrary sample rates, durations, and channel counts.

At the same time, formal methods tools fail in practice when they either (a) slow down everyday `npm test` watch loops, or (b) verify a disconnected specification that silently drifts away from the shipping TypeScript implementation (*the spec-to-code gap*).

## Decision
Adopt a **Two-Tier, Shared-Specification Formal Verification Architecture** under [`src/formal/`](../src/formal/README.md):

### 1. Single Source of Truth — Declarative Formal Specifications (`src/formal/specs/`)
Define the core transition systems, algebraic laws, and invariants once in pure TypeScript modules:
- [`syncMergeSpec.ts`](../src/formal/specs/syncMergeSpec.ts): Two-Phase Set (`2P-Set`) tombstone + total-order LWW-Register CRDT merge algebra and Google Drive access-role decision lattice (`owner` / `writer` / `reader`).
- [`studioStateMachineSpec.ts`](../src/formal/specs/studioStateMachineSpec.ts): Recording Studio labeled transition system (LTS) over `(phase, duration, playhead, micActive, previewActive, canUndoTrim, hasDraft)`.
- [`pcmTimelineSpec.ts`](../src/formal/specs/pcmTimelineSpec.ts): PCM audio timeline mathematical contract (closed-interval frame clamping, exact extraction lengths, 1-step truncate/undo invertibility, raised-cosine fade bounds, storage-block conservation).
- [`storageAndShareSpec.ts`](../src/formal/specs/storageAndShareSpec.ts): IndexedDB `ArrayBuffer` persistence invariants, cascade deletion, `#/join?...` share-link encode/parse round-trip contract, and audiobook player queue transition system.

### 2. Tier 1 — Always-On Executable Verification (`npm test`, ~1–2s, zero WASM overhead)
Runs on every `npm test` and `npm run test:watch` invocation directly against **real production TypeScript code**:
- **Explicit-State BFS Model Checker ([`modelChecker.ts`](../src/formal/core/modelChecker.ts))**: Exhaustively explores *every* reachable state and transition in the finite canonical abstraction, verifies every safety invariant and liveness/reachability property at every visited state, and prints the shortest counterexample action trace on violation.
- **Exhaustive Universal Quantifier & Algebraic Law Verifier ([`algebra.ts`](../src/formal/core/algebra.ts))**: Exhaustively checks Idempotence, Commutativity, Associativity (Join-Semilattice laws), Invertibility, Monotonicity, and truth tables over complete small-scope domains.
- **Differential Refinement / Conformance Verification**: Replays formal model traces and exhaustive inputs against the real production modules ([`syncService.ts`](../src/drive/syncService.ts), [`RecordingEngine`](../src/audio/recordingEngine.ts), [`PcmTimeline`](../src/audio/pcmTimeline.ts), [`db.ts`](../src/storage/db.ts), [`shareUtils.ts`](../src/drive/shareUtils.ts)) and proves observable equivalence — **closing the spec-to-code gap**.

### 3. Tier 2 — Unbounded Mathematical $\forall$-Proofs via Z3 SMT (`npm run test:formal`, pre-push & CI)
Runs via dedicated Node Vitest configuration ([`vitest.formal.config.ts`](../vitest.formal.config.ts)) using `z3-solver` (WebAssembly `devDependency`, 0 bytes in production PWA bundle), wired into `npm run precheck` ([`.githooks/pre-push`](../.githooks/pre-push)) and GitHub Actions ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)):
- **Proof by Refutation (`UNSAT`) ([`z3Prover.ts`](../src/formal/core/z3Prover.ts))**: Encodes each theorem's negation $\neg P(x)$ in SMT logic over **unbounded** integers, reals, and Booleans. `unsat` constitutes a mathematical proof that $\forall x,\, P(x)$ holds with zero counterexamples at any scale; `sat` prints a concrete counterexample model.
- **Inductive Invariant Proofs**: Proves safety for arbitrarily long execution traces ($n \to \infty$) in two SMT queries:
  1. **Base Case**: $\forall s.\ \mathrm{Init}(s) \implies \mathrm{Inv}(s)$
  2. **Inductive Step**: $\forall s, a, s'.\ \mathrm{Inv}(s) \land \mathrm{Step}(s, a, s') \implies \mathrm{Inv}(s')$
- **Pragmatic scope boundary**: Z3 is applied to subsystems with unbounded algebraic/stateful invariants (Drive sync CRDT & non-interference, Studio state machine, PCM timeline arithmetic). Browser-API and string-parsing contracts (IndexedDB serialization, URL regex parsing) remain in Tier 1 executable proofs where Z3 adds boilerplate without additional assurance.

## System Invariants
1. **CRDT Convergence & Tombstone Permanence**: Multi-user Drive sync merge forms a Join-Semilattice (Idempotent, Commutative, Associative) under deterministic total-order LWW tie-breaking; once tombstoned in `deletedRecordingIds`, a recording ID can never be resurrected by any future merge sequence.
2. **Read-Only Listener Non-Interference**: Whenever `accessRole === 'reader'` (resolved from Drive capabilities or fallback), zero Drive write/rename/upload mutations are ever performed.
3. **Studio State-Machine Safety**: Across *all* reachable states (finite BFS and unbounded Z3 induction):
   - $0 \le \text{playheadMs} \le \text{durationMs}$
   - $\text{micActive} \iff (\text{phase} = \text{recording})$ and $\text{previewActive} \iff (\text{phase} = \text{playing})$
   - $\neg(\text{micActive} \land \text{previewActive})$ (strict mutual exclusion)
   - $(\text{phase} = \text{playing}) \implies (\text{durationMs} > 0)$
   - $(\text{phase} = \text{idle}) \implies (\text{durationMs} = 0 \land \text{playheadMs} = 0)$
4. **PCM Audio Conservation & Invertibility**: `msToFrame`, `truncateAtFrame`, and `extractChannelData` stay strictly within $[0, \text{totalFrames}]$ for all IEEE-754 inputs (including `NaN`/`±Infinity`); `truncateAtFrame` followed by `undoTruncate` is bit-for-bit invertible; `buildStorageBlocks` → `loadFromChunks` preserves exact frame counts and sample values; raised-cosine fade gain lies in $[0, 1]$ with zero amplitude at cut boundaries.
5. **Storage, Queue & Share-Link Contracts**: IndexedDB `ArrayBuffer` round-trips preserve exact bytes and MIME types; project deletion cascades cleanly with zero orphan records; `buildJoinShareUrl` → `parseJoinInviteInput` is a faithful round-trip across all valid invites; player queue indices stay strictly within bounds.
6. **Local-to-CI Formal Verification Parity ([ADR-09](./ADR-09-strict-local-to-ci-verification-parity.md))**: `npm run precheck` (enforced by `.githooks/pre-push`) and `.github/workflows/deploy.yml` both execute `npm test` (Tier 1) **and** `npm run test:formal` (Tier 2).

## Consequences & Trade-offs
- **Real defects caught & fixed during adoption**:
  1. `RecordingEngine.undoLastTrim()` failed to restore `phase` back to `'paused'` after undoing a trim-to-zero (or trim from preview), violating `phase === 'idle' => durationMs === 0`.
  2. `syncService.ts` lacked deterministic equal-timestamp LWW tie-breaking, causing split-brain divergence when two devices modified metadata in the same millisecond.
  3. `PcmTimeline` (`msToFrame`, `truncateAtFrame`, `extractChannelData`) and `RecordingEngine.seekToMs` propagated `NaN` instead of clamping safely.
- **Pros:** Fast everyday feedback (~1–2s in `npm test`), mathematical $\forall$-certainty on pre-push/CI, zero spec-to-code drift, and zero production bundle overhead (`z3-solver` is dev-only).
- **Cons:** Adds `z3-solver` (~30 MB WASM) to `devDependencies` and ~2–5 seconds to `npm run precheck` and CI.
