/**
 * Tier 2 Formal Verification (Z3 SMT): Unbounded Arithmetic Proofs for PCM Audio Timeline
 *
 * Runs on `npm run test:formal`, `npm run precheck` (.githooks/pre-push), and GitHub Actions CI.
 * Proves frame clamping, extraction window bounds, truncation conservation, anti-click
 * raised-cosine gain envelope bounds, and storage-block partition conservation over
 * unbounded integers (ℤ) and reals (ℝ).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Arith } from 'z3-solver';
import { getZ3, proveTheorem, type Z3Context } from '../core/z3Prover';

function z3Clamp(
  ctx: Z3Context,
  x: Arith<'storytape'>,
  lo: Arith<'storytape'>,
  hi: Arith<'storytape'>,
): Arith<'storytape'> {
  return ctx.If(x.lt(lo), lo, ctx.If(x.gt(hi), hi, x));
}

describe('Tier 2 Z3 SMT Proofs: PCM Audio Timeline Unbounded Arithmetic', () => {
  let z3: Z3Context;

  beforeAll(async () => {
    z3 = await getZ3();
  });

  it('proves ∀ N ≥ 0, k ∈ ℤ: frame clamping is strictly bounded in [0, N], idempotent, and monotonic', async () => {
    const res = await proveTheorem(
      'Frame Clamp: Bounded + Idempotent + Monotonic ∀ N ≥ 0, k1, k2 ∈ ℤ',
      z3,
      (ctx) => {
        const N = ctx.Int.const('totalFrames');
        const k1 = ctx.Int.const('k1');
        const k2 = ctx.Int.const('k2');
        const zero = ctx.Int.val(0);

        const c1 = z3Clamp(ctx, k1, zero, N);
        const c2 = z3Clamp(ctx, k2, zero, N);
        const c1Twice = z3Clamp(ctx, c1, zero, N);

        return {
          premises: [N.ge(0)],
          conclusion: ctx.And(
            c1.ge(0),
            c1.le(N),
            c1Twice.eq(c1),
            ctx.Implies(k1.le(k2), c1.le(c2)),
          ),
        };
      },
    );
    expect(res.status).toBe('proved');
  });

  it('proves ∀ N ≥ 0, s, e ∈ ℤ: extractChannelData window has exact length ∈ [0, N] and never overruns', async () => {
    const res = await proveTheorem(
      'Extract Window: 0 ≤ start ≤ end ≤ N and 0 ≤ length ≤ N',
      z3,
      (ctx) => {
        const N = ctx.Int.const('totalFrames');
        const rawStart = ctx.Int.const('rawStart');
        const rawEnd = ctx.Int.const('rawEnd');
        const zero = ctx.Int.val(0);

        const start = z3Clamp(ctx, rawStart, zero, N);
        const end = z3Clamp(ctx, rawEnd, start, N);
        const length = end.sub(start);

        return {
          premises: [N.ge(0)],
          conclusion: ctx.And(
            start.ge(0),
            start.le(end),
            end.le(N),
            length.ge(0),
            length.le(N),
            // Exact length for any in-bounds range [rawStart, rawEnd)
            ctx.Implies(
              ctx.And(rawStart.ge(0), rawStart.le(rawEnd), rawEnd.le(N)),
              length.eq(rawEnd.sub(rawStart)),
            ),
          ),
        };
      },
    );
    expect(res.status).toBe('proved');
  });

  it('proves ∀ N ≥ 0, k ∈ ℤ: truncateAtFrame conserves total frames (newFrames + trimmedFrames = N) and safe fade window', async () => {
    const res = await proveTheorem(
      'Truncate Frame Conservation & Safe Fade Window ∀ N ≥ 0, k ∈ ℤ, fadeTarget ≥ 1',
      z3,
      (ctx) => {
        const N = ctx.Int.const('totalFrames');
        const k = ctx.Int.const('targetFrame');
        const fadeTarget = ctx.Int.const('fadeTarget');
        const zero = ctx.Int.val(0);

        const newFrames = z3Clamp(ctx, k, zero, N);
        const trimmedFrames = N.sub(newFrames);
        const fadeFrames = ctx.If(newFrames.lt(fadeTarget), newFrames, fadeTarget);

        return {
          premises: [N.ge(0), fadeTarget.ge(1)],
          conclusion: ctx.And(
            newFrames.ge(0),
            newFrames.le(N),
            trimmedFrames.ge(0),
            newFrames.add(trimmedFrames).eq(N),
            // Fade window is always valid: 0 <= fadeFrames <= newFrames, and > 0 whenever audio remains
            fadeFrames.ge(0),
            fadeFrames.le(newFrames),
            ctx.Implies(newFrames.gt(0), fadeFrames.ge(1)),
          ),
        };
      },
    );
    expect(res.status).toBe('proved');
  });

  it('proves ∀ sample ∈ [-1, 1], cos(πt) ∈ [-1, 1]: raised-cosine crossfade gain ∈ [0, 1], never clips, and zeroes cut boundary', async () => {
    const res = await proveTheorem(
      'Raised-Cosine Envelope: gain ∈ [0, 1], |sample * gain| ≤ 1, cut edge (cos=1) => output = 0',
      z3,
      (ctx) => {
        const sample = ctx.Real.const('sample');
        const cosVal = ctx.Real.const('cosPiT');
        // g(t) = 0.5 * (1 - cos(π * t))
        const gain = ctx.Real.val(1).sub(cosVal).div(ctx.Real.val(2));
        const output = sample.mul(gain);

        return {
          premises: [
            sample.ge(-1),
            sample.le(1),
            cosVal.ge(-1),
            cosVal.le(1),
          ],
          conclusion: ctx.And(
            // Gain strictly in [0, 1]
            gain.ge(0),
            gain.le(1),
            // Zero clipping: output stays inside [-1, 1]
            output.ge(-1),
            output.le(1),
            // Cut-edge continuity: at t = 0, cos(0) = 1 => output is identically 0
            ctx.Implies(cosVal.eq(1), output.eq(0)),
            // Unity preservation: at t = 1, cos(π) = -1 => output equals original sample
            ctx.Implies(cosVal.eq(-1), output.eq(sample)),
          ),
        };
      },
    );
    expect(res.status).toBe('proved');
  });

  it('proves ∀ totalSamples ≥ 0, blockSamples > 0: storage-block chunking conserves every sample without loss', async () => {
    const res = await proveTheorem(
      'Storage-Block Partition Conservation: fullBlocks * blockSamples + tail = totalSamples',
      z3,
      (ctx) => {
        const totalSamples = ctx.Int.const('totalSamples');
        const blockSamples = ctx.Int.const('blockSamples');
        const fullBlocks = totalSamples.div(blockSamples);
        const tailSamples = totalSamples.mod(blockSamples);

        return {
          premises: [totalSamples.ge(0), blockSamples.gt(0)],
          conclusion: ctx.And(
            fullBlocks.ge(0),
            tailSamples.ge(0),
            tailSamples.lt(blockSamples),
            fullBlocks.mul(blockSamples).add(tailSamples).eq(totalSamples),
          ),
        };
      },
    );
    expect(res.status).toBe('proved');
  });
});
