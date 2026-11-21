/**
 * Tier 2 Formal Verification (Z3 SMT): Unbounded Mathematical ∀-Proofs for Multi-User Drive Sync
 *
 * SINGLE-IR ZERO-DRIFT ARCHITECTURE:
 * Compiles `joinLwwIr`, `joinChapterSlotIr`, `validChapterSlotIr`, and `resolveAccessRoleIr`
 * directly from `src/formal/specs/syncMergeSpec.ts` into Z3 SMT via `z3ExprCompiler.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { E } from '../core/exprIr';
import { compileBoolToZ3, type Z3VarEnv } from '../core/z3ExprCompiler';
import { getZ3, proveTheorem, type Z3Context } from '../core/z3Prover';
import {
  ROLE_CODE,
  chapterSlotEqIr,
  joinChapterSlotIr,
  joinLwwIr,
  lwwEqIr,
  resolveAccessRoleIr,
  validChapterSlotIr,
  type ChapterSlotIr,
  type LwwIr,
} from '../specs/syncMergeSpec';

function lwwVars(prefix: string): LwwIr {
  return {
    t: E.intVar(`${prefix}_t`),
    r: E.intVar(`${prefix}_r`),
  };
}

function slotVars(prefix: string): ChapterSlotIr {
  return {
    exists: E.boolVar(`${prefix}_exists`),
    tombstoned: E.boolVar(`${prefix}_tomb`),
    ver: lwwVars(`${prefix}_v`),
  };
}

function bindLww(ctx: Z3Context, prefixes: readonly string[]): Z3VarEnv {
  const ints: Record<string, ReturnType<Z3Context['Int']['const']>> = {};
  for (const p of prefixes) {
    ints[`${p}_t`] = ctx.Int.const(`${p}_t`);
    ints[`${p}_r`] = ctx.Int.const(`${p}_r`);
  }
  return { ints, bools: {} };
}

function bindSlots(ctx: Z3Context, prefixes: readonly string[]): Z3VarEnv {
  const ints: Record<string, ReturnType<Z3Context['Int']['const']>> = {};
  const bools: Record<string, ReturnType<Z3Context['Bool']['const']>> = {};
  for (const p of prefixes) {
    bools[`${p}_exists`] = ctx.Bool.const(`${p}_exists`);
    bools[`${p}_tomb`] = ctx.Bool.const(`${p}_tomb`);
    ints[`${p}_v_t`] = ctx.Int.const(`${p}_v_t`);
    ints[`${p}_v_r`] = ctx.Int.const(`${p}_v_r`);
  }
  return { ints, bools };
}

describe('Tier 2 Z3 SMT Proofs: Multi-User Drive Sync CRDT & Non-Interference (Compiled from Shared IR)', () => {
  let z3: Z3Context;

  beforeAll(async () => {
    z3 = await getZ3();
  });

  it('proves ∀ t, r ∈ ℤ: shared joinLwwIr is Idempotent, Commutative, and Associative', async () => {
    const a = lwwVars('a');
    const b = lwwVars('b');
    const c = lwwVars('c');

    const idem = await proveTheorem(
      'LWW-Register Idempotence: ∀ a. join(a, a) = a',
      z3,
      (ctx) => ({
        conclusion: compileBoolToZ3(
          ctx,
          lwwEqIr(joinLwwIr(a, a), a),
          bindLww(ctx, ['a']),
        ),
      }),
    );
    expect(idem.status).toBe('proved');

    const comm = await proveTheorem(
      'LWW-Register Commutativity: ∀ a, b. join(a, b) = join(b, a)',
      z3,
      (ctx) => ({
        conclusion: compileBoolToZ3(
          ctx,
          lwwEqIr(joinLwwIr(a, b), joinLwwIr(b, a)),
          bindLww(ctx, ['a', 'b']),
        ),
      }),
    );
    expect(comm.status).toBe('proved');

    const assoc = await proveTheorem(
      'LWW-Register Associativity: ∀ a, b, c. join(join(a, b), c) = join(a, join(b, c))',
      z3,
      (ctx) => ({
        conclusion: compileBoolToZ3(
          ctx,
          lwwEqIr(joinLwwIr(joinLwwIr(a, b), c), joinLwwIr(a, joinLwwIr(b, c))),
          bindLww(ctx, ['a', 'b', 'c']),
        ),
      }),
    );
    expect(assoc.status).toBe('proved');
  });

  it('proves ∀ replicas: shared joinChapterSlotIr satisfies Tombstone Permanence, Non-Loss, and 3-Way Convergence', async () => {
    const a = slotVars('A');
    const b = slotVars('B');
    const c = slotVars('C');
    const ab = joinChapterSlotIr(a, b);

    const tombstonePermanence = await proveTheorem(
      'Tombstone Permanence (No Resurrection)',
      z3,
      (ctx) => {
        const env = bindSlots(ctx, ['A', 'B']);
        return {
          premises: [
            compileBoolToZ3(ctx, validChapterSlotIr(a), env),
            compileBoolToZ3(ctx, validChapterSlotIr(b), env),
          ],
          conclusion: compileBoolToZ3(
            ctx,
            E.and(
              validChapterSlotIr(ab),
              E.implies(
                E.or(a.tombstoned, b.tombstoned),
                E.and(ab.tombstoned, E.not(ab.exists)),
              ),
            ),
            env,
          ),
        };
      },
    );
    expect(tombstonePermanence.status).toBe('proved');

    const nonLoss = await proveTheorem(
      'Concurrent Non-Loss: live non-tombstoned chapter survives merge',
      z3,
      (ctx) => {
        const env = bindSlots(ctx, ['A', 'B']);
        return {
          premises: [
            compileBoolToZ3(
              ctx,
              E.and(
                validChapterSlotIr(a),
                validChapterSlotIr(b),
                E.or(a.exists, b.exists),
                E.not(a.tombstoned),
                E.not(b.tombstoned),
              ),
              env,
            ),
          ],
          conclusion: compileBoolToZ3(ctx, ab.exists, env),
        };
      },
    );
    expect(nonLoss.status).toBe('proved');

    const threeWayConvergence = await proveTheorem(
      '3-Device Strong Eventual Consistency: (A ⊔ B) ⊔ C = (C ⊔ A) ⊔ B = A ⊔ (B ⊔ C)',
      z3,
      (ctx) => {
        const env = bindSlots(ctx, ['A', 'B', 'C']);
        const ab_c = joinChapterSlotIr(ab, c);
        const ca_b = joinChapterSlotIr(joinChapterSlotIr(c, a), b);
        const a_bc = joinChapterSlotIr(a, joinChapterSlotIr(b, c));
        return {
          premises: [
            compileBoolToZ3(ctx, validChapterSlotIr(a), env),
            compileBoolToZ3(ctx, validChapterSlotIr(b), env),
            compileBoolToZ3(ctx, validChapterSlotIr(c), env),
          ],
          conclusion: compileBoolToZ3(
            ctx,
            E.and(chapterSlotEqIr(ab_c, ca_b), chapterSlotEqIr(ab_c, a_bc)),
            env,
          ),
        };
      },
    );
    expect(threeWayConvergence.status).toBe('proved');
  });

  it('proves shared resolveAccessRoleIr guarantees Read-Only Non-Interference across all Drive capability states', async () => {
    const vars = {
      summaryPresent: E.boolVar('summaryPresent'),
      ownedByMe: E.boolVar('ownedByMe'),
      ownedByMeFalse: E.boolVar('ownedByMeFalse'),
      shared: E.boolVar('shared'),
      hasCapabilities: E.boolVar('hasCapabilities'),
      canEdit: E.boolVar('canEdit'),
      canAddChildren: E.boolVar('canAddChildren'),
      fallback: E.intVar('fallback'),
    };
    const role = resolveAccessRoleIr(vars);
    const allowDriveWrite = E.neq(role, E.int(ROLE_CODE.reader));

    const goal = E.and(
      E.ge(role, E.int(ROLE_CODE.owner)),
      E.le(role, E.int(ROLE_CODE.reader)),
      E.implies(
        E.and(vars.summaryPresent, vars.ownedByMe),
        E.and(E.eq(role, E.int(ROLE_CODE.owner)), allowDriveWrite),
      ),
      E.implies(
        E.and(
          vars.summaryPresent,
          E.not(vars.ownedByMe),
          vars.hasCapabilities,
          E.not(vars.canEdit),
          E.not(vars.canAddChildren),
        ),
        E.and(E.eq(role, E.int(ROLE_CODE.reader)), E.not(allowDriveWrite)),
      ),
      E.implies(
        E.and(
          vars.summaryPresent,
          E.not(vars.ownedByMe),
          E.not(vars.hasCapabilities),
          E.eq(vars.fallback, E.int(ROLE_CODE.reader)),
        ),
        E.and(E.eq(role, E.int(ROLE_CODE.reader)), E.not(allowDriveWrite)),
      ),
    );

    const res = await proveTheorem(
      'AccessRole Policy (Compiled from Shared IR): Read-Only Non-Interference',
      z3,
      (ctx) => {
        const env: Z3VarEnv = {
          ints: { fallback: ctx.Int.const('fallback') },
          bools: {
            summaryPresent: ctx.Bool.const('summaryPresent'),
            ownedByMe: ctx.Bool.const('ownedByMe'),
            ownedByMeFalse: ctx.Bool.const('ownedByMeFalse'),
            shared: ctx.Bool.const('shared'),
            hasCapabilities: ctx.Bool.const('hasCapabilities'),
            canEdit: ctx.Bool.const('canEdit'),
            canAddChildren: ctx.Bool.const('canAddChildren'),
          },
        };
        return {
          premises: [
            compileBoolToZ3(
              ctx,
              E.and(
                E.not(E.and(vars.ownedByMe, vars.ownedByMeFalse)),
                E.ge(vars.fallback, E.int(ROLE_CODE.owner)),
                E.le(vars.fallback, E.int(ROLE_CODE.reader)),
              ),
              env,
            ),
          ],
          conclusion: compileBoolToZ3(ctx, goal, env),
        };
      },
    );
    expect(res.status).toBe('proved');
  });
});
