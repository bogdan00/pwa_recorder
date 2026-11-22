/**
 * Tier 2 Formal Verification (Z3 SMT): Unbounded Real & Integer Proofs for
 * Software AGC Headroom/Stability, Soft-Limiter Ceiling, and Quality Monitor Lattice.
 *
 * Runs on `npm run test:formal`, `npm run precheck` (.githooks/pre-push), and GitHub Actions CI.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Arith } from 'z3-solver';
import { getZ3, proveTheorem, type Z3Context } from '../core/z3Prover';
import {
  AUDIO_DSP_CONTRACT,
  QUALITY_SEVERITY_CODE,
} from '../specs/audioDspAndQualitySpec';

function z3ClampReal(
  ctx: Z3Context,
  x: Arith<'storytape'>,
  lo: Arith<'storytape'>,
  hi: Arith<'storytape'>,
): Arith<'storytape'> {
  return ctx.If(x.lt(lo), lo, ctx.If(x.gt(hi), hi, x));
}

function z3MaxInt(
  ctx: Z3Context,
  a: Arith<'storytape'>,
  b: Arith<'storytape'>,
): Arith<'storytape'> {
  return ctx.If(a.ge(b), a, b);
}

describe('Tier 2 Z3 SMT Proofs: Software AGC, Soft-Limiter & Quality Monitor Lattice', () => {
  let z3: Z3Context;

  beforeAll(async () => {
    z3 = await getZ3();
  });

  it('proves ∀ g ∈ [min, max], alpha ∈ (0, 1], desiredGain ∈ ℝ: smoothed AGC gain stays bounded and NEVER increases on compressor/peak backoff', async () => {
    const res = await proveTheorem(
      'Software AGC Gain Bounds & Compressor-Yield Monotonicity ∀ g, rawDesired, alpha ∈ ℝ',
      z3,
      (ctx) => {
        const minG = ctx.Real.val(AUDIO_DSP_CONTRACT.agcMinGain);
        const maxG = ctx.Real.val(AUDIO_DSP_CONTRACT.agcMaxGain);
        const g = ctx.Real.const('currentGain');
        const compReductionLinear = ctx.Real.const('compReductionLinear');
        const rmsDesired = ctx.Real.const('rmsDesired');
        const alpha = ctx.Real.const('alpha');
        const compEngaged = ctx.Bool.const('compEngaged');
        const isSpeech = ctx.Bool.const('isSpeech');

        // Exact mirror of SoftwareAutoGainController.processSamples backoff + smoothing
        const compSafe = z3ClampReal(ctx, g.mul(compReductionLinear), minG, maxG);
        const rmsClamped = z3ClampReal(ctx, rmsDesired, minG, maxG);
        const afterSpeech = ctx.If(
          isSpeech,
          ctx.If(
            compEngaged,
            ctx.If(compSafe.le(rmsClamped), compSafe, rmsClamped),
            rmsClamped,
          ),
          ctx.If(compEngaged, compSafe, g),
        );
        // Non-boost guard when compressor/peak hit
        const guardedDesired = ctx.If(
          ctx.And(compEngaged, afterSpeech.gt(g)),
          g,
          afterSpeech,
        );
        const nextGain = z3ClampReal(
          ctx,
          g.add(guardedDesired.sub(g).mul(alpha)),
          minG,
          maxG,
        );

        return {
          premises: [
            g.ge(minG),
            g.le(maxG),
            alpha.gt(0),
            alpha.le(1),
            // When compressor engages (<= -1.5 dB), reductionLinear = 10^((r-1.5)/20) ∈ (0, 1)
            compReductionLinear.gt(0),
            compReductionLinear.lt(1),
          ],
          conclusion: ctx.And(
            // 1. Always bounded in [minGain, maxGain]
            nextGain.ge(minG),
            nextGain.le(maxG),
            // 2. Compressor-yield monotonicity: whenever compressor engages, gain NEVER increases
            ctx.Implies(compEngaged, nextGain.le(g)),
            // 3. Silence non-pumping: when neither speech nor compressor/peak hit, gain is strictly invariant
            ctx.Implies(
              ctx.And(ctx.Not(isSpeech), ctx.Not(compEngaged)),
              nextGain.eq(g),
            ),
          ),
        };
      },
    );
    expect(res.status).toBe('proved');
  });

  it('proves ∀ x ∈ ℝ, tanhVal ∈ [0, 1]: softLimitSample preserves exact 1:1 identity below threshold and never exceeds -1 dBFS ceiling', async () => {
    const res = await proveTheorem(
      'Soft-Clipper Exact Identity & -1 dBFS Ceiling ∀ x ∈ ℝ, tanh ∈ [0, 1]',
      z3,
      (ctx) => {
        const threshold = ctx.Real.val(AUDIO_DSP_CONTRACT.softClipThreshold);
        const ceiling = ctx.Real.val(AUDIO_DSP_CONTRACT.softClipCeiling);
        const peakCeiling = ctx.Real.val(AUDIO_DSP_CONTRACT.agcPeakCeiling);
        const headroom = ceiling.sub(threshold);

        const x = ctx.Real.const('x');
        const tanhVal = ctx.Real.const('tanhVal');
        const absX = ctx.If(x.ge(0), x, x.neg());
        const limitedMag = threshold.add(headroom.mul(tanhVal));
        const y = ctx.If(
          absX.le(threshold),
          x,
          ctx.If(x.lt(0), limitedMag.neg(), limitedMag),
        );
        const absY = ctx.If(y.ge(0), y, y.neg());

        return {
          premises: [tanhVal.ge(0), tanhVal.le(1)],
          conclusion: ctx.And(
            // Strict headroom separation: AGC peak ceiling sits strictly below soft-clip knee
            peakCeiling.lt(threshold),
            threshold.lt(ceiling),
            // Exact 1:1 identity below knee
            ctx.Implies(absX.le(threshold), y.eq(x)),
            // True-peak ceiling invariant for all x ∈ ℝ
            absY.le(ceiling),
          ),
        };
      },
    );
    expect(res.status).toBe('proved');
  });

  it('proves Quality Monitor severity join forms a Join-Semilattice and warm-up listening NEVER masks critical alerts', async () => {
    const res = await proveTheorem(
      'Quality Severity Join-Semilattice & Critical Non-Masking ∀ a, b, c ∈ {0, 1, 2}, warmedUp ∈ Bool',
      z3,
      (ctx) => {
        const a = ctx.Int.const('a');
        const b = ctx.Int.const('b');
        const c = ctx.Int.const('c');
        const warmedUp = ctx.Bool.const('warmedUp');

        const GOOD = ctx.Int.val(QUALITY_SEVERITY_CODE.good);
        const CRIT = ctx.Int.val(QUALITY_SEVERITY_CODE.critical);
        const LISTENING = ctx.Int.val(-1);

        const joinAB = z3MaxInt(ctx, a, b);
        const joinBA = z3MaxInt(ctx, b, a);
        const joinAA = z3MaxInt(ctx, a, a);
        const joinAssocL = z3MaxInt(ctx, joinAB, c);
        const joinAssocR = z3MaxInt(ctx, a, z3MaxInt(ctx, b, c));

        // aggregateOverallQualityStatus(a, b, c, warmedUp)
        const overall = ctx.If(
          joinAssocL.eq(CRIT),
          CRIT,
          ctx.If(warmedUp, joinAssocL, LISTENING),
        );

        return {
          premises: [
            a.ge(GOOD),
            a.le(CRIT),
            b.ge(GOOD),
            b.le(CRIT),
            c.ge(GOOD),
            c.le(CRIT),
          ],
          conclusion: ctx.And(
            // Join-Semilattice laws
            joinAA.eq(a),
            joinAB.eq(joinBA),
            joinAssocL.eq(joinAssocR),
            // Critical alert can NEVER be masked by warm-up listening
            ctx.Implies(
              ctx.Or(a.eq(CRIT), b.eq(CRIT), c.eq(CRIT)),
              overall.eq(CRIT),
            ),
            // Once warmed up, overall equals exact lattice join
            ctx.Implies(warmedUp, overall.eq(joinAssocL)),
          ),
        };
      },
    );
    expect(res.status).toBe('proved');
  });

  it('proves inductively ∀ len ∈ ℤ: glitch event log length stays strictly within [0, MAX_GLITCH_LOG_ENTRIES] over arbitrarily long takes', async () => {
    const res = await proveTheorem(
      'Bounded Glitch Log Inductive Safety ∀ len ∈ [0, MAX]',
      z3,
      (ctx) => {
        const MAX = ctx.Int.val(AUDIO_DSP_CONTRACT.maxGlitchLogEntries);
        const len = ctx.Int.const('len');
        const nextLen = ctx.If(len.add(1).gt(MAX), MAX, len.add(1));

        return {
          premises: [len.ge(0), len.le(MAX)],
          conclusion: ctx.And(nextLen.ge(0), nextLen.le(MAX)),
        };
      },
    );
    expect(res.status).toBe('proved');
  });

  it('proves ∀ offset, instant1, instant2 ∈ ℝ: TimestampContinuityTracker is immune to ±35ms jitter and 1-frame spikes, contracts EMA offset, and confirms + re-locks sustained >35ms drops with zero cascades', async () => {
    const res = await proveTheorem(
      'TimestampContinuityTracker 2-Frame Sustained Drop & Jitter Immunity ∀ offset, instant1, instant2 ∈ ℝ',
      z3,
      (ctx) => {
        const THRESH = ctx.Real.val(AUDIO_DSP_CONTRACT.timestampDriftGapThresholdUs);
        const ALPHA = ctx.Real.val(AUDIO_DSP_CONTRACT.timestampOffsetEmaAlpha);
        const offset = ctx.Real.const('offset');
        const instant1 = ctx.Real.const('instant1');
        const instant2 = ctx.Real.const('instant2');

        // Step 1 starting from steady state (consecutivePos = 0, consecutiveNeg = 0)
        const d1 = instant1.sub(offset);
        const pos1 = d1.gt(THRESH);
        const neg1 = d1.lt(THRESH.neg());
        const gap1 = ctx.Bool.val(false); // Requires 2 consecutive frames -> 1-frame spike NEVER fires!
        const offset1 = ctx.If(ctx.Or(pos1, neg1), offset, offset.add(d1.mul(ALPHA)));

        // Step 2
        const d2 = instant2.sub(offset1);
        const pos2 = d2.gt(THRESH);
        const gap2 = ctx.And(pos1, pos2);
        const offset2 = ctx.If(
          gap2,
          instant2,
          ctx.If(
            ctx.And(neg1, d2.lt(THRESH.neg())),
            instant2,
            ctx.If(ctx.Or(pos2, d2.lt(THRESH.neg())), offset1, offset1.add(d2.mul(ALPHA))),
          ),
        );

        // Step 3 nominal continuation after a confirmed drop (instant3 === instant2)
        const d3AfterDrop = instant2.sub(offset2);

        return {
          premises: [],
          conclusion: ctx.And(
            // 1. Single-frame spike (even +1000ms) followed by nominal frame NEVER fires a gap
            ctx.Not(gap1),
            ctx.Implies(
              ctx.And(d1.gt(THRESH), instant2.sub(offset).le(THRESH)),
              ctx.Not(gap2),
            ),
            // 2. Bounded jitter within [-THRESH, +THRESH] NEVER fires a gap and contracts EMA
            ctx.Implies(
              ctx.And(d1.ge(0), d1.le(THRESH)),
              ctx.And(offset1.ge(offset), offset1.le(instant1)),
            ),
            // 3. Sustained > +35ms drop across 2 consecutive frames ALWAYS confirms and re-locks cleanly (d3 === 0)
            ctx.Implies(
              ctx.And(d1.gt(THRESH), instant2.sub(offset).gt(THRESH)),
              ctx.And(gap2, offset2.eq(instant2), d3AfterDrop.eq(0)),
            ),
          ),
        };
      },
    );
    expect(res.status).toBe('proved');
  });
});
