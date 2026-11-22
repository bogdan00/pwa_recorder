/**
 * Tier 2 Formal Verification (Z3 SMT): Unbounded Mathematical Induction for Studio Settings Lifecycle
 *
 * SINGLE-IR ZERO-DRIFT ARCHITECTURE:
 * This file contains ZERO hand-translated transition formulas or invariants.
 * Instead, it compiles `SETTINGS_INVARIANT_IR` and `SETTINGS_TRANSITIONS_IR` directly from
 * `src/formal/specs/settingsLifecycleSpec.ts` into Z3 SMT via `z3ExprCompiler.ts`!
 *
 * Proves all 8 safety invariants across:
 *   - ARBITRARY unbounded open/close session counts (openCount ∈ ℤ≥0)
 *   - ARBITRARILY LONG navigation/modal/mic-test histories (n = 0, 1, 2, ..., ∞) via Mathematical Induction:
 *       Base Case:      Init(s) => Inv(s)
 *       Inductive Step: Inv(s) ∧ Step(s, a, s') => Inv(s')  for EVERY transition in SETTINGS_TRANSITIONS_IR
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
  SETTINGS_INITIAL_STATE,
  SETTINGS_INVARIANT_IR,
  SETTINGS_TAB_CODE,
  SETTINGS_TRANSITIONS_IR,
  type SettingsTransitionIr,
} from '../specs/settingsLifecycleSpec';

interface Z3SettingsState {
  readonly open: Z3Bool;
  readonly tab: Z3Arith;
  readonly advancedOpen: Z3Bool;
  readonly micTestActive: Z3Bool;
  readonly themeSwitcherOpen: Z3Bool;
  readonly openCount: Z3Arith;
}

function makeZ3SettingsState(ctx: Z3Context, prefix: string): Z3SettingsState {
  return {
    open: ctx.Bool.const(`${prefix}_open`),
    tab: ctx.Int.const(`${prefix}_tab`),
    advancedOpen: ctx.Bool.const(`${prefix}_advancedOpen`),
    micTestActive: ctx.Bool.const(`${prefix}_micTestActive`),
    themeSwitcherOpen: ctx.Bool.const(`${prefix}_themeSwitcherOpen`),
    openCount: ctx.Int.const(`${prefix}_openCount`),
  };
}

function stateToZ3Env(s: Z3SettingsState): Z3VarEnv {
  return {
    ints: {
      tab: s.tab,
      openCount: s.openCount,
    },
    bools: {
      open: s.open,
      advancedOpen: s.advancedOpen,
      micTestActive: s.micTestActive,
      themeSwitcherOpen: s.themeSwitcherOpen,
    },
  };
}

function z3Init(ctx: Z3Context, s: Z3SettingsState): Z3Bool {
  return ctx.And(
    s.open.eq(SETTINGS_INITIAL_STATE.open),
    s.tab.eq(SETTINGS_TAB_CODE[SETTINGS_INITIAL_STATE.tab]),
    s.advancedOpen.eq(SETTINGS_INITIAL_STATE.advancedOpen),
    s.micTestActive.eq(SETTINGS_INITIAL_STATE.micTestActive),
    s.themeSwitcherOpen.eq(SETTINGS_INITIAL_STATE.themeSwitcherOpen),
    s.openCount.eq(SETTINGS_INITIAL_STATE.openCount),
  );
}

/**
 * Compiles ALL invariants directly from `SETTINGS_INVARIANT_IR` (zero hand-translation).
 */
function compileSettingsInvariant(ctx: Z3Context, s: Z3SettingsState): Z3Bool {
  const env = stateToZ3Env(s);
  return ctx.And(
    ...SETTINGS_INVARIANT_IR.map((inv) => compileBoolToZ3(ctx, inv.expr, env)),
  );
}

/**
 * Compiles a declarative `SettingsTransitionIr` directly into a Z3 relation Step(prev, next).
 */
function compileSettingsTransition(
  ctx: Z3Context,
  ir: SettingsTransitionIr,
  prev: Z3SettingsState,
  next: Z3SettingsState,
): Z3Bool {
  const env = stateToZ3Env(prev);

  return ctx.And(
    compileBoolToZ3(ctx, ir.guard, env),
    next.open.eq(ir.next.open ? compileBoolToZ3(ctx, ir.next.open, env) : prev.open),
    next.tab.eq(ir.next.tab ? compileIntToZ3(ctx, ir.next.tab, env) : prev.tab),
    next.advancedOpen.eq(
      ir.next.advancedOpen
        ? compileBoolToZ3(ctx, ir.next.advancedOpen, env)
        : prev.advancedOpen,
    ),
    next.micTestActive.eq(
      ir.next.micTestActive
        ? compileBoolToZ3(ctx, ir.next.micTestActive, env)
        : prev.micTestActive,
    ),
    next.themeSwitcherOpen.eq(
      ir.next.themeSwitcherOpen
        ? compileBoolToZ3(ctx, ir.next.themeSwitcherOpen, env)
        : prev.themeSwitcherOpen,
    ),
    next.openCount.eq(
      ir.next.openCount
        ? compileIntToZ3(ctx, ir.next.openCount, env)
        : prev.openCount,
    ),
  );
}

describe('Tier 2 Z3 SMT Proofs: Studio Settings Lifecycle Unbounded Inductive Safety (Compiled from Shared IR)', () => {
  let z3: Z3Context;

  beforeAll(async () => {
    z3 = await getZ3();
  });

  it('proves all 9 shared SETTINGS_INVARIANT_IR formulas hold inductively across all 12 transitions for unbounded openCount ∈ ℤ≥0', async () => {
    const allTransitions = Object.values(SETTINGS_TRANSITIONS_IR);
    expect(allTransitions.length).toBe(12);

    const result = await proveInductiveInvariant<Z3SettingsState>(
      'SettingsLifecycle',
      z3,
      {
        makeState: makeZ3SettingsState,
        init: z3Init,
        invariant: compileSettingsInvariant,
        transitions: allTransitions.map((ir) => ({
          name: ir.name,
          relation: (ctx, prev: Z3SettingsState, next: Z3SettingsState) =>
            compileSettingsTransition(ctx, ir, prev, next),
        })),
      },
    );

    expect(result.baseCase.status).toBe('proved');
    expect(result.inductiveSteps).toHaveLength(allTransitions.length);
    for (const step of result.inductiveSteps) {
      expect(step.status).toBe('proved');
    }
  });

  it('meta-proof (non-vacuity sanity check): Z3 refutes a buggy switch_drive transition that forgets to stop micTestActive', async () => {
    const buggySwitchDrive: SettingsTransitionIr = {
      ...SETTINGS_TRANSITIONS_IR.switch_drive,
      next: {
        ...SETTINGS_TRANSITIONS_IR.switch_drive.next,
        micTestActive: undefined, // Bug: leaves live mic stream running on Drive tab!
      },
    };

    const solver = new z3.Solver();
    const prev = makeZ3SettingsState(z3, 'bug_prev');
    const next = makeZ3SettingsState(z3, 'bug_next');

    solver.add(compileSettingsInvariant(z3, prev));
    solver.add(compileSettingsTransition(z3, buggySwitchDrive, prev, next));
    solver.add(z3.Not(compileSettingsInvariant(z3, next)));

    expect(await solver.check()).toBe('sat');
  });
});
