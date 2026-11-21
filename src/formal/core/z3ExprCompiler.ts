/**
 * Backend 2: Z3 SMT Compiler for the Shared Expression IR (`exprIr.ts`).
 *
 * Compiles the EXACT SAME `IntExpr` / `BoolExpr` AST evaluated by Tier 1
 * directly into symbolic Z3 SMT expressions for Tier 2 unbounded mathematical proofs.
 * Kept in a separate module from `exprIr.ts` so Tier 1 tests never load `z3-solver` WASM.
 */

import type { BoolExpr, IntExpr } from './exprIr';
import type { Z3Arith, Z3Bool, Z3Context } from './z3Prover';

export interface Z3VarEnv {
  readonly ints: Readonly<Record<string, Z3Arith>>;
  readonly bools: Readonly<Record<string, Z3Bool>>;
}

export function compileIntToZ3(
  ctx: Z3Context,
  expr: IntExpr,
  env: Z3VarEnv,
): Z3Arith {
  switch (expr.kind) {
    case 'intLit':
      return ctx.Int.val(expr.value);
    case 'intVar': {
      const v = env.ints[expr.name];
      if (!v) {
        throw new Error(`[Z3ExprCompiler] Missing symbolic Int var "${expr.name}"`);
      }
      return v;
    }
    case 'add':
      return compileIntToZ3(ctx, expr.left, env).add(
        compileIntToZ3(ctx, expr.right, env),
      );
    case 'sub':
      return compileIntToZ3(ctx, expr.left, env).sub(
        compileIntToZ3(ctx, expr.right, env),
      );
    case 'iteInt':
      return ctx.If(
        compileBoolToZ3(ctx, expr.cond, env),
        compileIntToZ3(ctx, expr.thenExpr, env),
        compileIntToZ3(ctx, expr.elseExpr, env),
      );
  }
}

export function compileBoolToZ3(
  ctx: Z3Context,
  expr: BoolExpr,
  env: Z3VarEnv,
): Z3Bool {
  switch (expr.kind) {
    case 'boolLit':
      return ctx.Bool.val(expr.value);
    case 'boolVar': {
      const v = env.bools[expr.name];
      if (!v) {
        throw new Error(`[Z3ExprCompiler] Missing symbolic Bool var "${expr.name}"`);
      }
      return v;
    }
    case 'not':
      return ctx.Not(compileBoolToZ3(ctx, expr.expr, env));
    case 'and':
      return expr.exprs.length === 0
        ? ctx.Bool.val(true)
        : ctx.And(...expr.exprs.map((e) => compileBoolToZ3(ctx, e, env)));
    case 'or':
      return expr.exprs.length === 0
        ? ctx.Bool.val(false)
        : ctx.Or(...expr.exprs.map((e) => compileBoolToZ3(ctx, e, env)));
    case 'implies':
      return ctx.Implies(
        compileBoolToZ3(ctx, expr.premise, env),
        compileBoolToZ3(ctx, expr.conclusion, env),
      );
    case 'boolEq':
      return compileBoolToZ3(ctx, expr.left, env).eq(
        compileBoolToZ3(ctx, expr.right, env),
      );
    case 'intEq':
      return compileIntToZ3(ctx, expr.left, env).eq(
        compileIntToZ3(ctx, expr.right, env),
      );
    case 'intNeq':
      return compileIntToZ3(ctx, expr.left, env).neq(
        compileIntToZ3(ctx, expr.right, env),
      );
    case 'gt':
      return compileIntToZ3(ctx, expr.left, env).gt(
        compileIntToZ3(ctx, expr.right, env),
      );
    case 'ge':
      return compileIntToZ3(ctx, expr.left, env).ge(
        compileIntToZ3(ctx, expr.right, env),
      );
    case 'lt':
      return compileIntToZ3(ctx, expr.left, env).lt(
        compileIntToZ3(ctx, expr.right, env),
      );
    case 'le':
      return compileIntToZ3(ctx, expr.left, env).le(
        compileIntToZ3(ctx, expr.right, env),
      );
    case 'iteBool':
      return ctx.If(
        compileBoolToZ3(ctx, expr.cond, env),
        compileBoolToZ3(ctx, expr.thenExpr, env),
        compileBoolToZ3(ctx, expr.elseExpr, env),
      );
  }
}
