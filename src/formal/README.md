# StoryTape Formal Verification Guide

This directory implements StoryTape's **Two-Tier, Shared-Specification Formal Verification** architecture (see [ADR-11](../../adr/ADR-11-two-tier-formal-verification.md)). It is structured as a textbook reference for applying practical formal methods to a production TypeScript PWA.

---

## Why Two Tiers?

Formal methods traditionally suffer from two failure modes in real apps:
1. **Slow feedback loops** if heavy SMT/model-checking runs block every save during development.
2. **The spec-to-code gap** if a standalone mathematical model is proved correct while the actual TypeScript implementation silently drifts away from it.

StoryTape solves both by sharing one declarative specification layer (`specs/`) across two complementary verification tiers:

| Tier | Command | When it runs | Engine | What it proves |
| --- | --- | --- | --- | --- |
| **Tier 1** | `npm test` | Always (dev, watch, pre-push, CI) | Explicit-State BFS Model Checker + Exhaustive Algebraic & Conformance Proofs (pure TS, ~1s) | 100% of canonical finite states & inputs **directly against real production TypeScript code** (closes the spec-to-code gap). |
| **Tier 2** | `npm run test:formal` | `npm run precheck`, `.githooks/pre-push`, GitHub Actions CI | **Z3 SMT Solver** (WASM, Node Vitest, ~2s) | **Unbounded mathematical $\forall$-proofs** (`UNSAT`) & **Mathematical Induction** over arbitrary integers, timestamps, durations, and infinite trace lengths. |

---

## Directory Layout

```text
src/formal/
├── core/                        # Reusable formal verification engines
│   ├── exprIr.ts                # Shared declarative Expression IR AST + Tier 1 concrete evaluator
│   ├── z3ExprCompiler.ts        # Tier 2 Z3 SMT compiler for the exact same Expression IR (zero drift!)
│   ├── modelChecker.ts          # Explicit-State BFS Model Checker + Automated Positive/Negative `verifyConformance`
│   ├── algebra.ts               # Exhaustive universal quantifiers & Join-Semilattice / Round-Trip verifiers
│   └── z3Prover.ts              # Z3 SMT proof kernel (Proof-by-Refutation UNSAT + Mathematical Induction)
│
├── specs/                       # SINGLE SOURCE OF TRUTH — declarative formal models (Shared IR)
│   ├── syncMergeSpec.ts         # 2P-Set + Total-Order LWW CRDT merge & Drive Access-Role policy (Shared IR)
│   ├── studioStateMachineSpec.ts# Recording Studio Labeled Transition System (Shared IR: 12 invariants, 6 goals)
│   ├── settingsLifecycleSpec.ts # Studio Settings Modal, Tabs, Disclosure & Mic-Test Lifecycle (Shared IR: 9 invariants, 5 goals)
│   ├── pcmTimelineSpec.ts       # PCM frame clamping, extraction bounds, splice/fade & undo contract
│   └── storageAndShareSpec.ts   # Player Queue LTS, Share-Link round-trip & IndexedDB binary contracts
│
└── __tests__/
    ├── syncMerge.conformance.test.ts       # Tier 1: Join-Semilattice + 273-row role truth table + real syncService.ts
    ├── studioStateMachine.modelCheck.test.ts # Tier 1: BFS + 100%-state positive/negative RecordingEngine conformance + async cancellation
    ├── settingsLifecycle.modelCheck.test.ts  # Tier 1: BFS + 100%-state positive/negative SettingsSheet/useMicTest conformance + async cancellation
    ├── pcmTimeline.proof.test.ts           # Tier 1: 480-case conservation/undo/round-trip + crash-recovery peaks + IEEE-754 bounds
    ├── storageAndShare.proof.test.ts       # Tier 1: Player Queue BFS + real PlayerProvider conformance + 48-case invite bijection + IndexedDB
    │
    ├── syncMerge.z3.formal.test.ts         # Tier 2 (Z3): compiled from syncMergeSpec IR — ∀ t,r ∈ ℤ CRDT convergence & non-interference
    ├── studioStateMachine.z3.formal.test.ts  # Tier 2 (Z3): compiled from studioStateMachineSpec IR — Induction (Base + 13 Steps) + non-vacuity
    ├── settingsLifecycle.z3.formal.test.ts   # Tier 2 (Z3): compiled from settingsLifecycleSpec IR — Induction (Base + 12 Steps) + non-vacuity
    └── pcmTimeline.z3.formal.test.ts       # Tier 2 (Z3): ∀ N,k ∈ ℤ, ℝ clamping, conservation, zero-clip raised cosine
```

---

## Textbook Concepts Demonstrated

### 1. Single-IR Dual-Backend Specification (`core/exprIr.ts` + `core/z3ExprCompiler.ts`)
By writing invariants, transition guards, and next-state expressions **once** as a typed AST (`IntExpr` / `BoolExpr`), Tier 1 evaluates the AST concretely in TypeScript while Tier 2 compiles the **exact same AST** into Z3 SMT formulas. Tier-1 ↔ Tier-2 drift is structurally impossible — and enforced by `repoInvariants.test.ts`.

### 2. Explicit-State BFS Model Checking & Positive/Negative Conformance (`core/modelChecker.ts`)
Models a stateful subsystem as a **Labeled Transition System** $(S, S_0, A, \to)$ and explores the entire reachable graph via Breadth-First Search:
- **Safety ($\Box I$, "Always $I$"):** Checked on every reachable state. BFS guarantees any violation reports the **shortest possible counterexample action trace**.
- **Reachability ($\Diamond G$, "Eventually $G$"):** Proves the model is non-vacuous (important states are genuinely reachable, not accidentally blocked by over-strict guards).
- **Automated Positive + Negative Conformance (`verifyConformance`):** Automatically replays BFS-harvested maximal traces directly against real production implementations (`RecordingEngine`, `PlayerProvider`) using an abstraction function $\alpha(\text{real}) \to \text{FormalState}$. At every visited state it verifies **both** enabled transitions *and* **disabled guards** (probing disabled actions like `seekToMs` during `recording` or `expandPlayer` while closed to ensure production code rejects them as no-ops).

### 3. State-Based CRDT Join-Semilattice Proofs (`syncMergeSpec.ts`)
A state-based CRDT guarantees **Strong Eventual Consistency** if and only if its merge operator $\sqcup$ satisfies three algebraic axioms:
1. **Idempotence:** $A \sqcup A = A$
2. **Commutativity:** $A \sqcup B = B \sqcup A$
3. **Associativity:** $(A \sqcup B) \sqcup C = A \sqcup (B \sqcup C)$

Tier 1 verifies these exhaustively across 75 canonical replicas (5,625 pairs & 15,625 triples); Tier 2 proves them mathematically for *all* unbounded timestamps and tie-breaker ranks in $\mathbb{Z}$ via Z3.

### 4. SMT Proof by Refutation & Mathematical Induction (`core/z3Prover.ts`)
- **Refutation (`proveTheorem`):** To prove $\forall x.\, P(x) \implies Q(x)$, we ask Z3 to solve $P(x) \land \neg Q(x)$. `unsat` is a mathematical proof that no counterexample exists anywhere in $\mathbb{Z}$ or $\mathbb{R}$.
- **Induction (`proveInductiveInvariant`):** Proves safety for arbitrarily long execution histories ($n \to \infty$) without unrolling:
  - **Base Case:** $\text{Init}(s) \land \neg \text{Inv}(s)$ is `unsat`
  - **Inductive Step:** $\text{Inv}(s) \land \text{Step}(s, a, s') \land \neg \text{Inv}(s')$ is `unsat` for every action $a$
- **Inductive Strengthening (CTI — Counterexample to Induction):** Notice `undo_requires_draft_persisted` (`canUndoTrim => hasDraft`) in `studioStateMachineSpec.ts`. Without it, Z3 immediately produces an unreachable "ghost" state (`phase = idle, canUndoTrim = true, hasDraft = false`) where `undo_trim` would transition to `paused` without a draft. Adding `canUndoTrim => hasDraft` strengthens the invariant so it becomes *inductive* across all reachable states — a classic textbook formal-methods technique!
- **Non-Vacuity Meta-Proof:** `studioStateMachine.z3.formal.test.ts` explicitly verifies that reverting our fix in `undoLastTrim` causes Z3 to return `sat` with a concrete counterexample — proving the SMT harness has real teeth.

---

## Real Defects Caught During Formalization & Systemic Audit

Writing these specs and upgrading to automated positive+negative conformance immediately exposed real edge-case bugs in production code (all fixed rather than weakening invariants):
1. **`RecordingEngine.undoLastTrim()`**: Undoing a trim-to-zero left `phase === 'idle'` with `durationMs > 0`. Fixed to restore `phase = restoredDurationMs > 0 ? 'paused' : 'idle'`.
2. **`RecordingEngine.seekToMs()`, `finalizeAndEncode()`, & `beginMicCapture()`**: `seekToMs` lacked a `phase === 'recording'` guard, `finalizeAndEncode` paused the mic *before* checking its non-empty timeline precondition (both caught automatically by negative guard probing!), and `beginMicCapture` lacked a `captureEpoch` cancellation token against mid-await `discard()`/`pause()` races.
3. **`PlayerContext`**: `expandPlayer` and `setSleepTimer` lacked loaded-book guards (caught by negative guard probing), and `seek` lacked an IEEE-754 finiteness guard.
4. **`syncService.ts` LWW tie-breaking**: Comparing `remote.updatedAt > local.updatedAt` without deterministic tie-breaking broke CRDT commutativity on equal timestamps (fixed for book metadata, chapters, and `coverUpdatedAt`).
5. **`PcmTimeline`**: `NaN` propagated into `totalFrames`/`extractChannelData`, and `loadFromChunks` trusted stale persisted `savedPeaks` without validating length against `totalFrames`.
6. **`googleAuth.ts` CI E2E parity**: Build-time `VITE_GOOGLE_AUTH_BROKER_URL` took precedence over runtime `window.__STORYTAPE_AUTH_BROKER_URL__`, leaking real Cloud Run requests in CI E2E runs.
