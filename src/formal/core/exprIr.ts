/**
 * Shared Declarative Expression IR (Deep Embedding / Dual-Backend AST).
 *
 * Textbook concept (Single-Source-of-Truth Specification):
 * One of the classic failure modes in hybrid formal verification is **Tier-1 ↔ Tier-2 drift**,
 * where a concrete TypeScript spec and a hand-translated Z3 formula quietly diverge over time.
 *
 * By expressing invariants, transition guards, and state updates ONCE as a typed AST:
 *   - Backend 1 (`evalInt` / `evalBool`, this file): executes concretely in pure TypeScript
 *     for Tier 1 BFS model checking & conformance (zero WASM overhead).
 *   - Backend 2 (`z3ExprCompiler.ts`): compiles the EXACT SAME AST into Z3 SMT expressions
 *     for Tier 2 unbounded mathematical proofs (`UNSAT` / Induction).
 *
 * Tier-1 ↔ Tier-2 drift becomes structurally impossible.
 */

export type IntExpr =
  | { readonly kind: 'intLit'; readonly value: number }
  | { readonly kind: 'intVar'; readonly name: string }
  | { readonly kind: 'add'; readonly left: IntExpr; readonly right: IntExpr }
  | { readonly kind: 'sub'; readonly left: IntExpr; readonly right: IntExpr }
  | {
      readonly kind: 'iteInt';
      readonly cond: BoolExpr;
      readonly thenExpr: IntExpr;
      readonly elseExpr: IntExpr;
    };

export type BoolExpr =
  | { readonly kind: 'boolLit'; readonly value: boolean }
  | { readonly kind: 'boolVar'; readonly name: string }
  | { readonly kind: 'not'; readonly expr: BoolExpr }
  | { readonly kind: 'and'; readonly exprs: readonly BoolExpr[] }
  | { readonly kind: 'or'; readonly exprs: readonly BoolExpr[] }
  | { readonly kind: 'implies'; readonly premise: BoolExpr; readonly conclusion: BoolExpr }
  | { readonly kind: 'boolEq'; readonly left: BoolExpr; readonly right: BoolExpr }
  | { readonly kind: 'intEq'; readonly left: IntExpr; readonly right: IntExpr }
  | { readonly kind: 'intNeq'; readonly left: IntExpr; readonly right: IntExpr }
  | { readonly kind: 'gt'; readonly left: IntExpr; readonly right: IntExpr }
  | { readonly kind: 'ge'; readonly left: IntExpr; readonly right: IntExpr }
  | { readonly kind: 'lt'; readonly left: IntExpr; readonly right: IntExpr }
  | { readonly kind: 'le'; readonly left: IntExpr; readonly right: IntExpr }
  | {
      readonly kind: 'iteBool';
      readonly cond: BoolExpr;
      readonly thenExpr: BoolExpr;
      readonly elseExpr: BoolExpr;
    };

export interface EvalEnv {
  readonly ints: Readonly<Record<string, number>>;
  readonly bools: Readonly<Record<string, boolean>>;
}

// ============================================================================
// Ergonomic AST Builders
// ============================================================================

export const E = {
  int: (value: number): IntExpr => ({ kind: 'intLit', value }),
  intVar: (name: string): IntExpr => ({ kind: 'intVar', name }),
  bool: (value: boolean): BoolExpr => ({ kind: 'boolLit', value }),
  boolVar: (name: string): BoolExpr => ({ kind: 'boolVar', name }),
  add: (left: IntExpr, right: IntExpr): IntExpr => ({ kind: 'add', left, right }),
  sub: (left: IntExpr, right: IntExpr): IntExpr => ({ kind: 'sub', left, right }),
  iteInt: (cond: BoolExpr, thenExpr: IntExpr, elseExpr: IntExpr): IntExpr => ({
    kind: 'iteInt',
    cond,
    thenExpr,
    elseExpr,
  }),
  clamp: (val: IntExpr, lo: IntExpr, hi: IntExpr): IntExpr =>
    E.iteInt(E.lt(val, lo), lo, E.iteInt(E.gt(val, hi), hi, val)),
  min: (a: IntExpr, b: IntExpr): IntExpr => E.iteInt(E.lt(a, b), a, b),
  max: (a: IntExpr, b: IntExpr): IntExpr => E.iteInt(E.gt(a, b), a, b),
  not: (expr: BoolExpr): BoolExpr => ({ kind: 'not', expr }),
  and: (...exprs: BoolExpr[]): BoolExpr => ({ kind: 'and', exprs }),
  or: (...exprs: BoolExpr[]): BoolExpr => ({ kind: 'or', exprs }),
  implies: (premise: BoolExpr, conclusion: BoolExpr): BoolExpr => ({
    kind: 'implies',
    premise,
    conclusion,
  }),
  boolEq: (left: BoolExpr, right: BoolExpr): BoolExpr => ({ kind: 'boolEq', left, right }),
  eq: (left: IntExpr, right: IntExpr): BoolExpr => ({ kind: 'intEq', left, right }),
  neq: (left: IntExpr, right: IntExpr): BoolExpr => ({ kind: 'intNeq', left, right }),
  gt: (left: IntExpr, right: IntExpr): BoolExpr => ({ kind: 'gt', left, right }),
  ge: (left: IntExpr, right: IntExpr): BoolExpr => ({ kind: 'ge', left, right }),
  lt: (left: IntExpr, right: IntExpr): BoolExpr => ({ kind: 'lt', left, right }),
  le: (left: IntExpr, right: IntExpr): BoolExpr => ({ kind: 'le', left, right }),
  iteBool: (cond: BoolExpr, thenExpr: BoolExpr, elseExpr: BoolExpr): BoolExpr => ({
    kind: 'iteBool',
    cond,
    thenExpr,
    elseExpr,
  }),
};

// ============================================================================
// Backend 1: Concrete TypeScript Interpreter (Tier 1)
// ============================================================================

export function evalInt(expr: IntExpr, env: EvalEnv): number {
  switch (expr.kind) {
    case 'intLit':
      return expr.value;
    case 'intVar': {
      const v = env.ints[expr.name];
      if (v === undefined) {
        throw new Error(`[ExprIR] Missing integer variable "${expr.name}"`);
      }
      return v;
    }
    case 'add':
      return evalInt(expr.left, env) + evalInt(expr.right, env);
    case 'sub':
      return evalInt(expr.left, env) - evalInt(expr.right, env);
    case 'iteInt':
      return evalBool(expr.cond, env)
        ? evalInt(expr.thenExpr, env)
        : evalInt(expr.elseExpr, env);
  }
}

export function evalBool(expr: BoolExpr, env: EvalEnv): boolean {
  switch (expr.kind) {
    case 'boolLit':
      return expr.value;
    case 'boolVar': {
      const v = env.bools[expr.name];
      if (v === undefined) {
        throw new Error(`[ExprIR] Missing boolean variable "${expr.name}"`);
      }
      return v;
    }
    case 'not':
      return !evalBool(expr.expr, env);
    case 'and':
      return expr.exprs.every((e) => evalBool(e, env));
    case 'or':
      return expr.exprs.some((e) => evalBool(e, env));
    case 'implies':
      return !evalBool(expr.premise, env) || evalBool(expr.conclusion, env);
    case 'boolEq':
      return evalBool(expr.left, env) === evalBool(expr.right, env);
    case 'intEq':
      return evalInt(expr.left, env) === evalInt(expr.right, env);
    case 'intNeq':
      return evalInt(expr.left, env) !== evalInt(expr.right, env);
    case 'gt':
      return evalInt(expr.left, env) > evalInt(expr.right, env);
    case 'ge':
      return evalInt(expr.left, env) >= evalInt(expr.right, env);
    case 'lt':
      return evalInt(expr.left, env) < evalInt(expr.right, env);
    case 'le':
      return evalInt(expr.left, env) <= evalInt(expr.right, env);
    case 'iteBool':
      return evalBool(expr.cond, env)
        ? evalBool(expr.thenExpr, env)
        : evalBool(expr.elseExpr, env);
  }
}
