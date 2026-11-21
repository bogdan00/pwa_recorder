/**
 * Z3 SMT Solver Proof Kernel Wrapper (Tier 2 — Unbounded Mathematical ∀-Proofs).
 *
 * Textbook background:
 * Satisfiability Modulo Theories (SMT) solvers decide whether a first-order logic
 * formula over theories like Linear/Nonlinear Integer & Real Arithmetic (LIA/LRA/NRA)
 * and Booleans has a satisfying assignment (`sat`) or none (`unsat`).
 *
 * Proof by Refutation:
 *   To mathematically prove ∀ x. Premises(x) => Conclusion(x) over INFINITE domains
 *   (e.g., all integers x ∈ ℤ, all non-negative durations, all timestamps):
 *     We assert: Premises(x) ∧ ¬Conclusion(x)
 *     - If Z3 returns `unsat`: NO counterexample exists anywhere in the universe. Q.E.D.
 *     - If Z3 returns `sat`:   Z3 hands us a concrete counterexample model!
 *
 * Mathematical Induction for Transition Systems:
 *   To prove safety □ Inv across unbounded trace lengths (0, 1, 2, ..., ∞):
 *     1. Base Case:      Init(s) ∧ ¬Inv(s)                     is UNSAT
 *     2. Inductive Step: Inv(s) ∧ Step(s, a, s') ∧ ¬Inv(s')    is UNSAT
 */

import { init, type Arith, type Bool, type Context } from 'z3-solver';

export type Z3Context = Context<'storytape'>;
export type Z3Bool = Bool<'storytape'>;
export type Z3Arith = Arith<'storytape'>;

let cachedZ3Promise: Promise<Z3Context> | null = null;

/**
 * Initializes the Z3 WebAssembly runtime once per Vitest worker process.
 */
export async function getZ3(): Promise<Z3Context> {
  if (!cachedZ3Promise) {
    cachedZ3Promise = init().then(({ Context }) => new Context('storytape'));
  }
  return cachedZ3Promise;
}

export interface TheoremResult {
  readonly name: string;
  readonly status: 'proved';
  readonly durationMs: number;
}

/**
 * Proves a universal theorem ∀ x. (premises => conclusion) by asking Z3 to refute
 * `premises ∧ ¬conclusion`. Fails loudly with the concrete Z3 counterexample model
 * if satisfiable (`sat`) or inconclusive (`unknown`).
 */
export async function proveTheorem(
  name: string,
  z3: Z3Context,
  buildFormula: (ctx: Z3Context) => {
    readonly premises?: readonly Z3Bool[];
    readonly conclusion: Z3Bool;
  },
): Promise<TheoremResult> {
  const start = performance.now();
  const solver = new z3.Solver();
  const { premises = [], conclusion } = buildFormula(z3);

  for (const p of premises) {
    solver.add(p);
  }
  // Proof by refutation: search for any assignment violating the conclusion
  solver.add(z3.Not(conclusion));

  const verdict = await solver.check();
  const durationMs = Math.round(performance.now() - start);

  if (verdict === 'unsat') {
    return { name, status: 'proved', durationMs };
  }

  if (verdict === 'sat') {
    const model = solver.model();
    throw new Error(
      `[Z3Prover] THEOREM DISPROVED: "${name}"\nConcrete counterexample found by Z3:\n${model.toString()}`,
    );
  }

  throw new Error(
    `[Z3Prover] THEOREM INCONCLUSIVE (${verdict}): "${name}" — Z3 could not prove UNSAT.`,
  );
}

/**
 * Proves an inductive safety invariant □ Inv for an unbounded transition system:
 *   1. Base case:      ∀ s.          Init(s) => Inv(s)
 *   2. Inductive step: ∀ s, a, s'.   Inv(s) ∧ Step(s, a, s') => Inv(s')
 */
export async function proveInductiveInvariant<S>(
  systemName: string,
  z3: Z3Context,
  spec: {
    readonly makeState: (ctx: Z3Context, prefix: string) => S;
    readonly init: (ctx: Z3Context, s: S) => Z3Bool;
    readonly invariant: (ctx: Z3Context, s: S) => Z3Bool;
    readonly transitions: ReadonlyArray<{
      readonly name: string;
      readonly relation: (ctx: Z3Context, prev: S, next: S) => Z3Bool;
    }>;
  },
): Promise<{
  readonly baseCase: TheoremResult;
  readonly inductiveSteps: readonly TheoremResult[];
}> {
  const baseCase = await proveTheorem(
    `${systemName} [Induction Base Case: Init(s) => Inv(s)]`,
    z3,
    (ctx) => {
      const s0 = spec.makeState(ctx, 's0');
      return {
        premises: [spec.init(ctx, s0)],
        conclusion: spec.invariant(ctx, s0),
      };
    },
  );

  const inductiveSteps: TheoremResult[] = [];
  for (const tr of spec.transitions) {
    const stepResult = await proveTheorem(
      `${systemName} [Induction Step (${tr.name}): Inv(s) ∧ Step(s,s') => Inv(s')]`,
      z3,
      (ctx) => {
        const prev = spec.makeState(ctx, 'prev');
        const next = spec.makeState(ctx, 'next');
        return {
          premises: [spec.invariant(ctx, prev), tr.relation(ctx, prev, next)],
          conclusion: spec.invariant(ctx, next),
        };
      },
    );
    inductiveSteps.push(stepResult);
  }

  return { baseCase, inductiveSteps };
}
