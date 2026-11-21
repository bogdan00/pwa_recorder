/**
 * Tier 2 Formal Verification (Z3 SMT): Unbounded Mathematical Induction for Recording Studio
 *
 * Runs on `npm run test:formal`, `npm run precheck` (.githooks/pre-push), and GitHub Actions CI.
 * Proves all 10 Studio Safety Invariants from `studioStateMachineSpec.ts` across:
 *   - ARBITRARY unbounded durations (duration ∈ ℤ≥0 — 1 second or 100 hours!)
 *   - ARBITRARY unbounded seek targets (target ∈ ℤ)
 *   - ARBITRARILY LONG execution histories (n = 0, 1, 2, ..., ∞) via Mathematical Induction:
 *       Base Case:      Init(s) => Inv(s)
 *       Inductive Step: Inv(s) ∧ Step(s, a, s') => Inv(s')  for EVERY action a ∈ STUDIO_ACTIONS
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Arith, Bool } from 'z3-solver';
import {
  getZ3,
  proveInductiveInvariant,
  type Z3Context,
} from '../core/z3Prover';

const PHASE_IDLE = 0;
const PHASE_RECORDING = 1;
const PHASE_PAUSED = 2;
const PHASE_PLAYING = 3;

interface Z3StudioState {
  readonly phase: Arith<'storytape'>;
  readonly duration: Arith<'storytape'>;
  readonly playhead: Arith<'storytape'>;
  readonly micActive: Bool<'storytape'>;
  readonly previewActive: Bool<'storytape'>;
  readonly canUndoTrim: Bool<'storytape'>;
  readonly undoDuration: Arith<'storytape'>;
  readonly hasDraft: Bool<'storytape'>;
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

function z3Init(ctx: Z3Context, s: Z3StudioState): Bool<'storytape'> {
  return ctx.And(
    s.phase.eq(PHASE_IDLE),
    s.duration.eq(0),
    s.playhead.eq(0),
    ctx.Not(s.micActive),
    ctx.Not(s.previewActive),
    ctx.Not(s.canUndoTrim),
    s.undoDuration.eq(0),
    ctx.Not(s.hasDraft),
  );
}

/**
 * Exact symbolic encoding of all 10 invariants in `STUDIO_INVARIANTS` (`studioStateMachineSpec.ts`).
 */
function z3StudioInvariant(ctx: Z3Context, s: Z3StudioState): Bool<'storytape'> {
  return ctx.And(
    // Valid phase enum
    s.phase.ge(PHASE_IDLE),
    s.phase.le(PHASE_PLAYING),
    // 1. duration_non_negative
    s.duration.ge(0),
    // 2. playhead_within_bounds (0 <= playhead <= duration)
    s.playhead.ge(0),
    s.playhead.le(s.duration),
    // 3. mic_active_iff_recording
    s.micActive.eq(s.phase.eq(PHASE_RECORDING)),
    // 4. preview_active_iff_playing
    s.previewActive.eq(s.phase.eq(PHASE_PLAYING)),
    // 5. mutual_exclusion_mic_and_preview
    ctx.Not(ctx.And(s.micActive, s.previewActive)),
    // 6. playing_requires_non_empty_audio
    ctx.Implies(s.phase.eq(PHASE_PLAYING), s.duration.gt(0)),
    // 7. idle_implies_zero_duration_and_playhead
    ctx.Implies(
      s.phase.eq(PHASE_IDLE),
      ctx.And(s.duration.eq(0), s.playhead.eq(0)),
    ),
    // 8. recording_playhead_tracks_live_tail
    ctx.Implies(s.phase.eq(PHASE_RECORDING), s.playhead.eq(s.duration)),
    // 9. active_session_implies_draft_persisted
    ctx.Implies(s.phase.neq(PHASE_IDLE), s.hasDraft),
    // 10. undo_snapshot_consistent
    ctx.If(s.canUndoTrim, s.undoDuration.ge(0), s.undoDuration.eq(0)),
    // 11. undo_requires_draft_persisted (inductive strengthening eliminating unreachable CTI ghost states)
    ctx.Implies(s.canUndoTrim, s.hasDraft),
  );
}

function z3Clamp(
  ctx: Z3Context,
  val: Arith<'storytape'>,
  lo: Arith<'storytape'>,
  hi: Arith<'storytape'>,
): Arith<'storytape'> {
  return ctx.If(val.lt(lo), lo, ctx.If(val.gt(hi), hi, val));
}

describe('Tier 2 Z3 SMT Proofs: Recording Studio Unbounded Inductive Safety', () => {
  let z3: Z3Context;

  beforeAll(async () => {
    z3 = await getZ3();
  });

  it('proves all 11 Studio Safety Invariants hold inductively for ALL durations ∈ ℤ≥0 and ALL trace lengths', async () => {
    const result = await proveInductiveInvariant('RecordingStudio', z3, {
      makeState: makeZ3StudioState,
      init: z3Init,
      invariant: z3StudioInvariant,
      transitions: [
        {
          name: 'start_or_resume',
          relation: (ctx, prev, next) =>
            ctx.And(
              next.phase.eq(PHASE_RECORDING),
              next.duration.eq(prev.duration),
              next.playhead.eq(prev.duration),
              next.micActive,
              ctx.Not(next.previewActive),
              ctx.Not(next.canUndoTrim),
              next.undoDuration.eq(0),
              next.hasDraft,
            ),
        },
        {
          name: 'capture_chunk (arbitrary Δ > 0)',
          relation: (ctx, prev, next) => {
            const delta = ctx.Int.const('chunk_delta');
            return ctx.And(
              prev.phase.eq(PHASE_RECORDING),
              delta.gt(0),
              next.phase.eq(PHASE_RECORDING),
              next.duration.eq(prev.duration.add(delta)),
              next.playhead.eq(prev.duration.add(delta)),
              next.micActive,
              ctx.Not(next.previewActive),
              next.canUndoTrim.eq(prev.canUndoTrim),
              next.undoDuration.eq(prev.undoDuration),
              next.hasDraft.eq(prev.hasDraft),
            );
          },
        },
        {
          name: 'pause',
          relation: (ctx, prev, next) =>
            ctx.And(
              prev.phase.eq(PHASE_RECORDING),
              next.phase.eq(PHASE_PAUSED),
              next.duration.eq(prev.duration),
              next.playhead.eq(prev.duration),
              ctx.Not(next.micActive),
              ctx.Not(next.previewActive),
              next.canUndoTrim.eq(prev.canUndoTrim),
              next.undoDuration.eq(prev.undoDuration),
              next.hasDraft.eq(prev.hasDraft),
            ),
        },
        {
          name: 'seek (arbitrary target ∈ ℤ while not recording)',
          relation: (ctx, prev, next) => {
            const rawTarget = ctx.Int.const('seek_raw_target');
            const clamped = z3Clamp(ctx, rawTarget, ctx.Int.val(0), prev.duration);
            return ctx.And(
              prev.phase.neq(PHASE_RECORDING),
              next.phase.eq(prev.phase),
              next.duration.eq(prev.duration),
              next.playhead.eq(clamped),
              next.micActive.eq(prev.micActive),
              next.previewActive.eq(prev.previewActive),
              next.canUndoTrim.eq(prev.canUndoTrim),
              next.undoDuration.eq(prev.undoDuration),
              next.hasDraft.eq(prev.hasDraft),
            );
          },
        },
        {
          name: 'play_preview (with auto-rewind if near end)',
          relation: (ctx, prev, next) => {
            const rewindBack = ctx.Int.val(5000);
            const rewound = ctx.If(
              prev.duration.gt(rewindBack),
              prev.duration.sub(rewindBack),
              ctx.Int.val(0),
            );
            const effPlayhead = ctx.If(
              prev.playhead.ge(prev.duration),
              rewound,
              prev.playhead,
            );
            return ctx.And(
              prev.duration.gt(0),
              next.phase.eq(PHASE_PLAYING),
              next.duration.eq(prev.duration),
              next.playhead.eq(effPlayhead),
              ctx.Not(next.micActive),
              next.previewActive,
              next.canUndoTrim.eq(prev.canUndoTrim),
              next.undoDuration.eq(prev.undoDuration),
              next.hasDraft,
            );
          },
        },
        {
          name: 'preview_tick (arbitrary elapsed ≥ 0)',
          relation: (ctx, prev, next) => {
            const elapsed = ctx.Int.const('preview_elapsed');
            const advanced = prev.playhead.add(elapsed);
            const bounded = ctx.If(advanced.gt(prev.duration), prev.duration, advanced);
            return ctx.And(
              prev.phase.eq(PHASE_PLAYING),
              elapsed.ge(0),
              next.phase.eq(PHASE_PLAYING),
              next.duration.eq(prev.duration),
              next.playhead.eq(bounded),
              ctx.Not(next.micActive),
              next.previewActive,
              next.canUndoTrim.eq(prev.canUndoTrim),
              next.undoDuration.eq(prev.undoDuration),
              next.hasDraft.eq(prev.hasDraft),
            );
          },
        },
        {
          name: 'preview_ended',
          relation: (ctx, prev, next) =>
            ctx.And(
              prev.phase.eq(PHASE_PLAYING),
              next.phase.eq(PHASE_PAUSED),
              next.duration.eq(prev.duration),
              next.playhead.eq(prev.duration),
              ctx.Not(next.micActive),
              ctx.Not(next.previewActive),
              next.canUndoTrim.eq(prev.canUndoTrim),
              next.undoDuration.eq(prev.undoDuration),
              next.hasDraft.eq(prev.hasDraft),
            ),
        },
        {
          name: 'pause_preview',
          relation: (ctx, prev, next) =>
            ctx.And(
              prev.phase.eq(PHASE_PLAYING),
              next.phase.eq(PHASE_PAUSED),
              next.duration.eq(prev.duration),
              next.playhead.eq(prev.playhead),
              ctx.Not(next.micActive),
              ctx.Not(next.previewActive),
              next.canUndoTrim.eq(prev.canUndoTrim),
              next.undoDuration.eq(prev.undoDuration),
              next.hasDraft.eq(prev.hasDraft),
            ),
        },
        {
          name: 'punch_in',
          relation: (ctx, prev, next) => {
            const newDur = ctx.If(prev.hasDraft, prev.playhead, ctx.Int.val(0));
            return ctx.And(
              next.phase.eq(PHASE_RECORDING),
              next.duration.eq(newDur),
              next.playhead.eq(newDur),
              next.micActive,
              ctx.Not(next.previewActive),
              next.canUndoTrim.eq(prev.hasDraft),
              next.undoDuration.eq(ctx.If(prev.hasDraft, prev.duration, ctx.Int.val(0))),
              next.hasDraft,
            );
          },
        },
        {
          name: 'trim_to_playhead',
          relation: (ctx, prev, next) => {
            const cutAt = ctx.If(prev.phase.eq(PHASE_RECORDING), prev.duration, prev.playhead);
            return ctx.And(
              prev.hasDraft,
              next.phase.eq(ctx.If(cutAt.gt(0), ctx.Int.val(PHASE_PAUSED), ctx.Int.val(PHASE_IDLE))),
              next.duration.eq(cutAt),
              next.playhead.eq(cutAt),
              ctx.Not(next.micActive),
              ctx.Not(next.previewActive),
              next.canUndoTrim,
              next.undoDuration.eq(prev.duration),
              next.hasDraft,
            );
          },
        },
        {
          name: 'undo_trim (fixed phase restoration)',
          relation: (ctx, prev, next) =>
            ctx.And(
              prev.canUndoTrim,
              next.phase.eq(
                ctx.If(prev.undoDuration.gt(0), ctx.Int.val(PHASE_PAUSED), ctx.Int.val(PHASE_IDLE)),
              ),
              next.duration.eq(prev.undoDuration),
              next.playhead.eq(prev.undoDuration),
              ctx.Not(next.micActive),
              ctx.Not(next.previewActive),
              ctx.Not(next.canUndoTrim),
              next.undoDuration.eq(0),
              next.hasDraft.eq(prev.hasDraft),
            ),
        },
        {
          name: 'finalize',
          relation: (ctx, prev, next) =>
            ctx.And(prev.duration.gt(0), z3Init(ctx, next)),
        },
        {
          name: 'discard',
          relation: (ctx, _prev, next) => z3Init(ctx, next),
        },
      ],
    });

    expect(result.baseCase.status).toBe('proved');
    expect(result.inductiveSteps).toHaveLength(13);
    for (const step of result.inductiveSteps) {
      expect(step.status).toBe('proved');
    }
  });

  it('meta-proof (non-vacuity sanity check): Z3 refutes the original buggy undoLastTrim that kept phase unchanged', async () => {
    // Demonstrates that our Z3 induction harness genuinely detects real bugs:
    // If undo_trim preserved `next.phase = prev.phase` (the pre-fix bug in RecordingEngine),
    // Z3 MUST return `sat` with a counterexample (prev.phase = IDLE, prev.undoDuration > 0)!
    const solver = new z3.Solver();
    const prev = makeZ3StudioState(z3, 'bug_prev');
    const next = makeZ3StudioState(z3, 'bug_next');

    solver.add(z3StudioInvariant(z3, prev));
    // Buggy transition: keeps next.phase === prev.phase!
    solver.add(
      z3.And(
        prev.canUndoTrim,
        next.phase.eq(prev.phase),
        next.duration.eq(prev.undoDuration),
        next.playhead.eq(prev.undoDuration),
        z3.Not(next.micActive),
        z3.Not(next.previewActive),
        z3.Not(next.canUndoTrim),
        next.undoDuration.eq(0),
        next.hasDraft.eq(prev.hasDraft),
      ),
    );
    solver.add(z3.Not(z3StudioInvariant(z3, next)));

    const verdict = await solver.check();
    expect(verdict).toBe('sat');
  });
});
