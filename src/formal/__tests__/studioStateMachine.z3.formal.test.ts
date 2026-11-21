/**
 * Tier 2 Formal Verification (Z3 SMT): Unbounded Mathematical Induction for Recording Studio
 *
 * SINGLE-IR ZERO-DRIFT ARCHITECTURE:
 * This file contains ZERO hand-translated transition formulas or invariants.
 * Instead, it compiles `STUDIO_INVARIANT_IR` and `STUDIO_TRANSITIONS_IR` directly from
 * `src/formal/specs/studioStateMachineSpec.ts` into Z3 SMT via `z3ExprCompiler.ts`!
 *
 * Proves all safety invariants across:
 *   - ARBITRARY unbounded durations (duration ∈ ℤ≥0 — 1 second or 100 hours!)
 *   - ARBITRARY unbounded seek targets & rewind windows (∈ ℤ)
 *   - ARBITRARILY LONG execution histories (n = 0, 1, 2, ..., ∞) via Mathematical Induction:
 *       Base Case:      Init(s) => Inv(s)
 *       Inductive Step: Inv(s) ∧ Step(s, a, s') => Inv(s')  for EVERY transition in STUDIO_TRANSITIONS_IR
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  compileBoolToZ3,
  compileIntToZ3,
  type Z3VarEnv,
} from '../core/z3ExprCompiler';
import {
  getZ3,
  proveInductiveInvariant,
  type Z3Arith,
  type Z3Bool,
  type Z3Context,
} from '../core/z3Prover';
import {
  STUDIO_INITIAL_STATE,
  STUDIO_INVARIANT_IR,
  STUDIO_PHASE_CODE,
  STUDIO_TRANSITIONS_IR,
  type StudioTransitionIr,
} from '../specs/studioStateMachineSpec';

interface Z3StudioState {
  readonly phase: Z3Arith;
  readonly duration: Z3Arith;
  readonly playhead: Z3Arith;
  readonly micActive: Z3Bool;
  readonly previewActive: Z3Bool;
  readonly canUndoTrim: Z3Bool;
  readonly undoDuration: Z3Arith;
  readonly hasDraft: Z3Bool;
}

function makeZ3StudioState(ctx: Z3Context, prefix: string): Z3StudioState {
  return {
    phase: ctx.Int.const(`${prefix}_phase`),
    duration: ctx.Int.const(`${prefix}_duration`),
    playhead: ctx.Int.const(`${prefix}_playhead`),
    micActive: ctx.Bool.const(`${prefix}_micActive`),
    previewActive: ctx.Bool.const(`${prefix}_previewActive`),
    canUndoTrim: ctx.Bool.const(`${prefix}_canUndoTrim`),
    undoDuration: ctx.Int.const(`${prefix}_undoDuration`),
    hasDraft: ctx.Bool.const(`${prefix}_hasDraft`),
  };
}

function stateToZ3Env(
  s: Z3StudioState,
  extraInts: Readonly<Record<string, Z3Arith>> = {},
): Z3VarEnv {
  return {
    ints: {
      phase: s.phase,
      duration: s.duration,
      playhead: s.playhead,
      undoDuration: s.undoDuration,
      ...extraInts,
    },
    bools: {
      micActive: s.micActive,
      previewActive: s.previewActive,
      canUndoTrim: s.canUndoTrim,
      hasDraft: s.hasDraft,
    },
  };
}

function z3Init(ctx: Z3Context, s: Z3StudioState): Z3Bool {
  return ctx.And(
    s.phase.eq(STUDIO_PHASE_CODE[STUDIO_INITIAL_STATE.phase]),
    s.duration.eq(STUDIO_INITIAL_STATE.duration),
    s.playhead.eq(STUDIO_INITIAL_STATE.playhead),
    s.micActive.eq(STUDIO_INITIAL_STATE.micActive),
    s.previewActive.eq(STUDIO_INITIAL_STATE.previewActive),
    s.canUndoTrim.eq(STUDIO_INITIAL_STATE.canUndoTrim),
    s.undoDuration.eq(STUDIO_INITIAL_STATE.undoDuration),
    s.hasDraft.eq(STUDIO_INITIAL_STATE.hasDraft),
  );
}

/**
 * Compiles ALL invariants directly from `STUDIO_INVARIANT_IR` (zero hand-translation).
 */
function compileStudioInvariant(ctx: Z3Context, s: Z3StudioState): Z3Bool {
  const env = stateToZ3Env(s);
  return ctx.And(
    ...STUDIO_INVARIANT_IR.map((inv) => compileBoolToZ3(ctx, inv.expr, env)),
  );
}

/**
 * Compiles a declarative `StudioTransitionIr` directly into a Z3 relation Step(prev, next).
 */
function compileStudioTransition(
  ctx: Z3Context,
  ir: StudioTransitionIr,
  prev: Z3StudioState,
  next: Z3StudioState,
): Z3Bool {
  const extraInts: Record<string, Z3Arith> = {};
  for (const param of ir.intParams ?? []) {
    extraInts[param] = ctx.Int.const(`${ir.name}_param_${param}`);
  }
  const env = stateToZ3Env(prev, extraInts);

  return ctx.And(
    compileBoolToZ3(ctx, ir.guard, env),
    next.phase.eq(ir.next.phase ? compileIntToZ3(ctx, ir.next.phase, env) : prev.phase),
    next.duration.eq(
      ir.next.duration ? compileIntToZ3(ctx, ir.next.duration, env) : prev.duration,
    ),
    next.playhead.eq(
      ir.next.playhead ? compileIntToZ3(ctx, ir.next.playhead, env) : prev.playhead,
    ),
    next.micActive.eq(
      ir.next.micActive ? compileBoolToZ3(ctx, ir.next.micActive, env) : prev.micActive,
    ),
    next.previewActive.eq(
      ir.next.previewActive
        ? compileBoolToZ3(ctx, ir.next.previewActive, env)
        : prev.previewActive,
    ),
    next.canUndoTrim.eq(
      ir.next.canUndoTrim
        ? compileBoolToZ3(ctx, ir.next.canUndoTrim, env)
        : prev.canUndoTrim,
    ),
    next.undoDuration.eq(
      ir.next.undoDuration
        ? compileIntToZ3(ctx, ir.next.undoDuration, env)
        : prev.undoDuration,
    ),
    next.hasDraft.eq(
      ir.next.hasDraft ? compileBoolToZ3(ctx, ir.next.hasDraft, env) : prev.hasDraft,
    ),
  );
}

describe('Tier 2 Z3 SMT Proofs: Recording Studio Unbounded Inductive Safety (Compiled from Shared IR)', () => {
  let z3: Z3Context;

  beforeAll(async () => {
    z3 = await getZ3();
  });

  it('proves all shared STUDIO_INVARIANT_IR formulas hold inductively across EVERY transition in STUDIO_TRANSITIONS_IR', async () => {
    const allTransitions = Object.values(STUDIO_TRANSITIONS_IR);
    expect(allTransitions.length).toBe(13);

    const result = await proveInductiveInvariant<Z3StudioState>('RecordingStudio', z3, {
      makeState: makeZ3StudioState,
      init: z3Init,
      invariant: compileStudioInvariant,
      transitions: allTransitions.map((ir) => ({
        name: ir.name,
        relation: (ctx, prev: Z3StudioState, next: Z3StudioState) =>
          compileStudioTransition(ctx, ir, prev, next),
      })),
    });

    expect(result.baseCase.status).toBe('proved');
    expect(result.inductiveSteps).toHaveLength(allTransitions.length);
    for (const step of result.inductiveSteps) {
      expect(step.status).toBe('proved');
    }
  });

  it('meta-proof (non-vacuity sanity check): Z3 refutes the original buggy undoLastTrim that kept phase unchanged', async () => {
    // Mutate only the `phase` update of `undo_trim` to simulate the pre-fix bug
    const buggyUndoIr: StudioTransitionIr = {
      ...STUDIO_TRANSITIONS_IR.undo_trim,
      name: 'buggy_undo_trim',
      next: {
        ...STUDIO_TRANSITIONS_IR.undo_trim.next,
        phase: undefined, // Bug: leaves next.phase === prev.phase!
      },
    };

    const solver = new z3.Solver();
    const prev = makeZ3StudioState(z3, 'bug_prev');
    const next = makeZ3StudioState(z3, 'bug_next');

    solver.add(compileStudioInvariant(z3, prev));
    solver.add(compileStudioTransition(z3, buggyUndoIr, prev, next));
    solver.add(z3.Not(compileStudioInvariant(z3, next)));

    expect(await solver.check()).toBe('sat');
  });
});
