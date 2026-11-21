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
│   ├── modelChecker.ts          # Explicit-State BFS Model Checker (Safety □I, Reachability ◇G, Shortest Counterexample)
│   ├── algebra.ts               # Exhaustive universal quantifiers & Join-Semilattice / Round-Trip verifiers
│   └── z3Prover.ts              # Z3 SMT proof kernel (Proof-by-Refutation UNSAT + Mathematical Induction)
│
├── specs/                       # SINGLE SOURCE OF TRUTH — declarative formal models
│   ├── syncMergeSpec.ts         # 2P-Set + Total-Order LWW CRDT merge & Drive Access-Role policy
│   ├── studioStateMachineSpec.ts# Recording Studio Labeled Transition System (10 safety invariants, 6 goals)
│   ├── pcmTimelineSpec.ts       # PCM frame clamping, extraction bounds, splice/fade & undo contract
│   └── storageAndShareSpec.ts   # Player Queue LTS, Share-Link round-trip & IndexedDB binary contracts
│
└── __tests__/
    ├── syncMerge.conformance.test.ts      # Tier 1: Join-Semilattice + 273-row role truth table + real syncService.ts
    ├── studioStateMachine.modelCheck.test.ts # Tier 1: BFS over all studio states + lock-step RecordingEngine replay
    ├── pcmTimeline.proof.test.ts          # Tier 1: 480-case conservation/undo/round-trip + IEEE-754 bounds on PcmTimeline
    ├── storageAndShare.proof.test.ts      # Tier 1: Player Queue BFS + 48-case invite bijection + IndexedDB proofs
    │
    ├── syncMerge.z3.formal.test.ts        # Tier 2 (Z3): ∀ t,r ∈ ℤ CRDT convergence, tombstone permanence, non-interference
    ├── studioStateMachine.z3.formal.test.ts # Tier 2 (Z3): Mathematical induction (Base + 13 Inductive Steps) + non-vacuity
    └── pcmTimeline.z3.formal.test.ts      # Tier 2 (Z3): ∀ N,k ∈ ℤ, ℝ clamping, conservation, zero-clip raised cosine
```

---

## Textbook Concepts Demonstrated

### 1. Explicit-State BFS Model Checking (`core/modelChecker.ts`)
Models a stateful subsystem as a **Labeled Transition System** $(S, S_0, A, \to)$ and explores the entire reachable graph via Breadth-First Search:
- **Safety ($\Box I$, "Always $I$"):** Checked on every reachable state. BFS guarantees any violation reports the **shortest possible counterexample action trace**.
- **Reachability ($\Diamond G$, "Eventually $G$"):** Proves the model is non-vacuous (important states are genuinely reachable, not accidentally blocked by over-strict guards).

### 2. Differential Refinement / Conformance (`*.conformance.test.ts`, `*.modelCheck.test.ts`)
Defines an **abstraction function** $\alpha(\text{realImpl}) \to \text{FormalState}$ and replays actions against both the formal specification and the real production class (`RecordingEngine`, `syncService.ts`), proving lock-step equivalence. If anyone changes production code in a way that violates the proven spec, Tier 1 fails immediately.

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
- **Inductive Strengthening (CTI — Counterexample to Induction):** Notice invariant #11 (`canUndoTrim => hasDraft`) in `studioStateMachineSpec.ts`. Without it, Z3 immediately produces an unreachable "ghost" state (`phase = idle, canUndoTrim = true, hasDraft = false`) where `undo_trim` would transition to `paused` without a draft. Adding `canUndoTrim => hasDraft` strengthens the invariant so it becomes *inductive* across all reachable states — a classic textbook formal-methods technique!
- **Non-Vacuity Meta-Proof:** `studioStateMachine.z3.formal.test.ts` explicitly verifies that reverting our fix in `undoLastTrim` causes Z3 to return `sat` with a concrete counterexample — proving the SMT harness has real teeth.

---

## Real Defects Caught During Formalization

Writing these specs immediately exposed three real edge-case bugs in production code (all fixed rather than weakening invariants):
1. **`RecordingEngine.undoLastTrim()`**: Undoing a trim-to-zero left `phase === 'idle'` with `durationMs > 0` (violating `idle => duration === 0`). Fixed to restore `phase = restoredDurationMs > 0 ? 'paused' : 'idle'`.
2. **`syncService.ts` LWW tie-breaking**: Comparing `remote.updatedAt > local.updatedAt` without a deterministic tie-breaker broke CRDT commutativity when two devices edited metadata at the same millisecond. Fixed with total-order lexicographical tie-breaking (`shouldPreferRemoteBookMeta` / `shouldPreferRemoteRecordingMeta`).
3. **`PcmTimeline` & `RecordingEngine.seekToMs` non-finite inputs**: Passing `NaN` propagated `NaN` into `totalFrames` and `playheadMs`. Fixed with IEEE-754 finiteness guards.
