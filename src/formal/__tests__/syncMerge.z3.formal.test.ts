/**
 * Tier 2 Formal Verification (Z3 SMT): Unbounded Mathematical ∀-Proofs for Multi-User Drive Sync
 *
 * Runs on `npm run test:formal`, `npm run precheck` (.githooks/pre-push), and GitHub Actions CI.
 * Unlike Tier 1 (which checks finite domains), Z3 proves these theorems across ALL
 * unbounded integers (timestamps t ∈ ℤ, payload tie-breaker ranks r ∈ ℤ) via proof by refutation (UNSAT).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Arith, Bool } from 'z3-solver';
import { getZ3, proveTheorem, type Z3Context } from '../core/z3Prover';

interface Z3Lww {
  readonly t: Arith<'storytape'>;
  readonly r: Arith<'storytape'>;
}

interface Z3ChapterSlot {
  readonly exists: Bool<'storytape'>;
  readonly tombstoned: Bool<'storytape'>;
  readonly ver: Z3Lww;
}

function makeLww(ctx: Z3Context, prefix: string): Z3Lww {
  return {
    t: ctx.Int.const(`${prefix}_t`),
    r: ctx.Int.const(`${prefix}_r`),
  };
}

/**
 * Mirrors `specPreferRemoteLww` & `shouldPreferRemoteBookMeta`/`shouldPreferRemoteRecordingMeta`:
 *   remote beats local  ⟺  remote.t > local.t ∨ (remote.t = local.t ∧ remote.r > local.r)
 */
function z3PreferRemote(ctx: Z3Context, local: Z3Lww, remote: Z3Lww): Bool<'storytape'> {
  return ctx.Or(
    remote.t.gt(local.t),
    ctx.And(remote.t.eq(local.t), remote.r.gt(local.r)),
  );
}

function z3JoinLww(ctx: Z3Context, a: Z3Lww, b: Z3Lww): Z3Lww {
  const pickB = z3PreferRemote(ctx, a, b);
  return {
    t: ctx.If(pickB, b.t, a.t),
    r: ctx.If(pickB, b.r, a.r),
  };
}

function z3LwwEq(ctx: Z3Context, a: Z3Lww, b: Z3Lww): Bool<'storytape'> {
  return ctx.And(a.t.eq(b.t), a.r.eq(b.r));
}

function makeChapterSlot(ctx: Z3Context, prefix: string): Z3ChapterSlot {
  return {
    exists: ctx.Bool.const(`${prefix}_exists`),
    tombstoned: ctx.Bool.const(`${prefix}_tomb`),
    ver: makeLww(ctx, `${prefix}_v`),
  };
}

/**
 * Well-formed 2P-Set chapter slot invariant: a tombstoned chapter cannot simultaneously be live.
 */
function z3ValidSlot(ctx: Z3Context, slot: Z3ChapterSlot): Bool<'storytape'> {
  return ctx.Implies(slot.tombstoned, ctx.Not(slot.exists));
}

/**
 * Mirrors `specMergeReplicas` for an arbitrary chapter slot ID.
 */
function z3JoinChapterSlot(
  ctx: Z3Context,
  a: Z3ChapterSlot,
  b: Z3ChapterSlot,
): Z3ChapterSlot {
  const tombstoned = ctx.Or(a.tombstoned, b.tombstoned);
  const exists = ctx.And(ctx.Not(tombstoned), ctx.Or(a.exists, b.exists));
  const joinedVer = z3JoinLww(ctx, a.ver, b.ver);
  const ver: Z3Lww = {
    t: ctx.If(
      ctx.And(a.exists, b.exists),
      joinedVer.t,
      ctx.If(a.exists, a.ver.t, b.ver.t),
    ),
    r: ctx.If(
      ctx.And(a.exists, b.exists),
      joinedVer.r,
      ctx.If(a.exists, a.ver.r, b.ver.r),
    ),
  };
  return { exists, tombstoned, ver };
}

function z3SlotEq(ctx: Z3Context, a: Z3ChapterSlot, b: Z3ChapterSlot): Bool<'storytape'> {
  return ctx.And(
    a.tombstoned.eq(b.tombstoned),
    a.exists.eq(b.exists),
    // Version payloads only matter when the chapter is live
    ctx.Implies(a.exists, z3LwwEq(ctx, a.ver, b.ver)),
  );
}

describe('Tier 2 Z3 SMT Proofs: Multi-User Drive Sync CRDT & Non-Interference', () => {
  let z3: Z3Context;

  beforeAll(async () => {
    z3 = await getZ3();
  });

  it('proves ∀ t, r ∈ ℤ: LWW-Register merge is Idempotent, Commutative, and Associative', async () => {
    const idem = await proveTheorem(
      'LWW-Register Idempotence: ∀ a. join(a, a) = a',
      z3,
      (ctx) => {
        const a = makeLww(ctx, 'a');
        return { conclusion: z3LwwEq(ctx, z3JoinLww(ctx, a, a), a) };
      },
    );
    expect(idem.status).toBe('proved');

    const comm = await proveTheorem(
      'LWW-Register Commutativity: ∀ a, b. join(a, b) = join(b, a)',
      z3,
      (ctx) => {
        const a = makeLww(ctx, 'a');
        const b = makeLww(ctx, 'b');
        return {
          conclusion: z3LwwEq(ctx, z3JoinLww(ctx, a, b), z3JoinLww(ctx, b, a)),
        };
      },
    );
    expect(comm.status).toBe('proved');

    const assoc = await proveTheorem(
      'LWW-Register Associativity: ∀ a, b, c. join(join(a, b), c) = join(a, join(b, c))',
      z3,
      (ctx) => {
        const a = makeLww(ctx, 'a');
        const b = makeLww(ctx, 'b');
        const c = makeLww(ctx, 'c');
        return {
          conclusion: z3LwwEq(
            ctx,
            z3JoinLww(ctx, z3JoinLww(ctx, a, b), c),
            z3JoinLww(ctx, a, z3JoinLww(ctx, b, c)),
          ),
        };
      },
    );
    expect(assoc.status).toBe('proved');
  });

  it('proves ∀ replicas: 2P-Set Chapter Merge satisfies Join-Semilattice, Tombstone Permanence, and 3-Way Convergence', async () => {
    const tombstonePermanence = await proveTheorem(
      'Tombstone Permanence (No Resurrection): ∀ a, b. (a.tomb ∨ b.tomb) => (a ⊔ b).tomb ∧ ¬(a ⊔ b).exists',
      z3,
      (ctx) => {
        const a = makeChapterSlot(ctx, 'a');
        const b = makeChapterSlot(ctx, 'b');
        const m = z3JoinChapterSlot(ctx, a, b);
        return {
          premises: [z3ValidSlot(ctx, a), z3ValidSlot(ctx, b)],
          conclusion: ctx.And(
            z3ValidSlot(ctx, m),
            ctx.Implies(
              ctx.Or(a.tombstoned, b.tombstoned),
              ctx.And(m.tombstoned, ctx.Not(m.exists)),
            ),
          ),
        };
      },
    );
    expect(tombstonePermanence.status).toBe('proved');

    const nonLoss = await proveTheorem(
      'Concurrent Non-Loss: ∀ a, b. live chapter with no tombstone survives merge',
      z3,
      (ctx) => {
        const a = makeChapterSlot(ctx, 'a');
        const b = makeChapterSlot(ctx, 'b');
        const m = z3JoinChapterSlot(ctx, a, b);
        return {
          premises: [
            z3ValidSlot(ctx, a),
            z3ValidSlot(ctx, b),
            ctx.Or(a.exists, b.exists),
            ctx.Not(a.tombstoned),
            ctx.Not(b.tombstoned),
          ],
          conclusion: m.exists,
        };
      },
    );
    expect(nonLoss.status).toBe('proved');

    const threeWayConvergence = await proveTheorem(
      '3-Device Strong Eventual Consistency: ∀ A, B, C. (A ⊔ B) ⊔ C = (C ⊔ A) ⊔ B = A ⊔ (B ⊔ C)',
      z3,
      (ctx) => {
        const a = makeChapterSlot(ctx, 'A');
        const b = makeChapterSlot(ctx, 'B');
        const c = makeChapterSlot(ctx, 'C');
        const ab_c = z3JoinChapterSlot(ctx, z3JoinChapterSlot(ctx, a, b), c);
        const ca_b = z3JoinChapterSlot(ctx, z3JoinChapterSlot(ctx, c, a), b);
        const a_bc = z3JoinChapterSlot(ctx, a, z3JoinChapterSlot(ctx, b, c));
        return {
          premises: [z3ValidSlot(ctx, a), z3ValidSlot(ctx, b), z3ValidSlot(ctx, c)],
          conclusion: ctx.And(
            z3SlotEq(ctx, ab_c, ca_b),
            z3SlotEq(ctx, ab_c, a_bc),
          ),
        };
      },
    );
    expect(threeWayConvergence.status).toBe('proved');
  });

  it('proves Access-Role Decision Policy guarantees Read-Only Non-Interference across all Drive capability states', async () => {
    const ROLE_OWNER = 0;
    const ROLE_WRITER = 1;
    const ROLE_READER = 2;

    const result = await proveTheorem(
      'AccessRole Policy: non-owner without write capabilities ALWAYS resolves to reader (zero Drive writes)',
      z3,
      (ctx) => {
        const summaryPresent = ctx.Bool.const('summaryPresent');
        const ownedByMe = ctx.Bool.const('ownedByMe');
        const ownedByMeFalse = ctx.Bool.const('ownedByMeFalse');
        const shared = ctx.Bool.const('shared');
        const hasCapabilities = ctx.Bool.const('hasCapabilities');
        const canEdit = ctx.Bool.const('canEdit');
        const canAddChildren = ctx.Bool.const('canAddChildren');
        const fallback = ctx.Int.const('fallback');

        // ownedByMe cannot be simultaneously true and explicitly false
        const validOwned = ctx.Not(ctx.And(ownedByMe, ownedByMeFalse));
        const validFallback = ctx.And(fallback.ge(ROLE_OWNER), fallback.le(ROLE_READER));

        const canWriteCap = ctx.Or(canEdit, canAddChildren);
        const resolvedRole = ctx.If(
          ctx.Not(summaryPresent),
          fallback,
          ctx.If(
            ownedByMe,
            ctx.Int.val(ROLE_OWNER),
            ctx.If(
              hasCapabilities,
              ctx.If(canWriteCap, ctx.Int.val(ROLE_WRITER), ctx.Int.val(ROLE_READER)),
              ctx.If(
                ctx.And(shared, ownedByMeFalse),
                ctx.If(fallback.eq(ROLE_READER), ctx.Int.val(ROLE_READER), ctx.Int.val(ROLE_WRITER)),
                fallback,
              ),
            ),
          ),
        );

        const allowDriveWrite = resolvedRole.neq(ROLE_READER);

        return {
          premises: [validOwned, validFallback],
          conclusion: ctx.And(
            // 1. Always resolves to a valid role enum
            resolvedRole.ge(ROLE_OWNER),
            resolvedRole.le(ROLE_READER),
            // 2. Explicit owner always resolves to owner and can write
            ctx.Implies(
              ctx.And(summaryPresent, ownedByMe),
              ctx.And(resolvedRole.eq(ROLE_OWNER), allowDriveWrite),
            ),
            // 3. Explicit non-owner with capabilities lacking write permission is ALWAYS read-only
            ctx.Implies(
              ctx.And(
                summaryPresent,
                ctx.Not(ownedByMe),
                hasCapabilities,
                ctx.Not(canEdit),
                ctx.Not(canAddChildren),
              ),
              ctx.And(resolvedRole.eq(ROLE_READER), ctx.Not(allowDriveWrite)),
            ),
            // 4. Read-only fallback is preserved when shared folder lacks capability metadata
            ctx.Implies(
              ctx.And(
                summaryPresent,
                ctx.Not(ownedByMe),
                ctx.Not(hasCapabilities),
                fallback.eq(ROLE_READER),
              ),
              ctx.And(resolvedRole.eq(ROLE_READER), ctx.Not(allowDriveWrite)),
            ),
          ),
        };
      },
    );
    expect(result.status).toBe('proved');
  });
});
