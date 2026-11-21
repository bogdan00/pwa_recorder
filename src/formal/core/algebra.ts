/**
 * Exhaustive Bounded Universal Quantifier & Algebraic Law Verifiers.
 *
 * Textbook background (Small-Scope Hypothesis, Daniel Jackson / Alloy):
 * Most algebraic and protocol bugs manifest on small finite domains (e.g., 2–3 replicas,
 * 2–3 chapters, 3 timestamps). Unlike randomized fuzzing/property testing, exhaustive
 * enumeration over a canonical finite domain verifies **100% of combinations**
 * deterministically with zero flakiness.
 */

export interface ProofCertificate {
  readonly lawName: string;
  readonly casesChecked: number;
}

/**
 * Exhaustively verifies ∀ x ∈ domain. predicate(x).
 * Throws with the first exact counterexample if any case fails.
 */
export function forAll<T>(
  lawName: string,
  domain: readonly T[],
  predicate: (value: T) => boolean,
): ProofCertificate {
  let casesChecked = 0;
  for (const value of domain) {
    casesChecked += 1;
    if (!predicate(value)) {
      throw new Error(
        `[AlgebraicProof] Law "${lawName}" FAILED on counterexample:\n  ${JSON.stringify(value)}`,
      );
    }
  }
  if (casesChecked === 0) {
    throw new Error(`[AlgebraicProof] Law "${lawName}" has an empty domain (vacuous proof rejected).`);
  }
  return { lawName, casesChecked };
}

/**
 * Exhaustively verifies ∀ (a, b) ∈ domainA × domainB. predicate(a, b).
 */
export function forAllPairs<A, B>(
  lawName: string,
  domainA: readonly A[],
  domainB: readonly B[],
  predicate: (a: A, b: B) => boolean,
): ProofCertificate {
  let casesChecked = 0;
  for (const a of domainA) {
    for (const b of domainB) {
      casesChecked += 1;
      if (!predicate(a, b)) {
        throw new Error(
          `[AlgebraicProof] Law "${lawName}" FAILED on counterexample pair:\n  a = ${JSON.stringify(a)}\n  b = ${JSON.stringify(b)}`,
        );
      }
    }
  }
  if (casesChecked === 0) {
    throw new Error(`[AlgebraicProof] Law "${lawName}" has an empty domain (vacuous proof rejected).`);
  }
  return { lawName, casesChecked };
}

/**
 * Exhaustively verifies ∀ (a, b, c) ∈ domain³. predicate(a, b, c).
 */
export function forAllTriples<T>(
  lawName: string,
  domain: readonly T[],
  predicate: (a: T, b: T, c: T) => boolean,
): ProofCertificate {
  let casesChecked = 0;
  for (const a of domain) {
    for (const b of domain) {
      for (const c of domain) {
        casesChecked += 1;
        if (!predicate(a, b, c)) {
          throw new Error(
            `[AlgebraicProof] Law "${lawName}" FAILED on counterexample triple:\n  a = ${JSON.stringify(a)}\n  b = ${JSON.stringify(b)}\n  c = ${JSON.stringify(c)}`,
          );
        }
      }
    }
  }
  if (casesChecked === 0) {
    throw new Error(`[AlgebraicProof] Law "${lawName}" has an empty domain (vacuous proof rejected).`);
  }
  return { lawName, casesChecked };
}

/**
 * Verifies the three axioms of a Join-Semilattice (the exact mathematical structure
 * required for State-Based CRDT / CvRDT strong eventual consistency):
 *   1. Idempotence:   ∀ a.       join(a, a) == a
 *   2. Commutativity: ∀ a, b.    join(a, b) == join(b, a)
 *   3. Associativity: ∀ a, b, c. join(join(a, b), c) == join(a, join(b, c))
 */
export function verifyJoinSemilattice<T>(
  name: string,
  domain: readonly T[],
  join: (a: T, b: T) => T,
  equals: (x: T, y: T) => boolean,
): {
  readonly idempotence: ProofCertificate;
  readonly commutativity: ProofCertificate;
  readonly associativity: ProofCertificate;
} {
  const idempotence = forAll(
    `${name}: Idempotence (a ⊔ a = a)`,
    domain,
    (a) => equals(join(a, a), a),
  );

  const commutativity = forAllPairs(
    `${name}: Commutativity (a ⊔ b = b ⊔ a)`,
    domain,
    domain,
    (a, b) => equals(join(a, b), join(b, a)),
  );

  const associativity = forAllTriples(
    `${name}: Associativity ((a ⊔ b) ⊔ c = a ⊔ (b ⊔ c))`,
    domain,
    (a, b, c) => equals(join(join(a, b), c), join(a, join(b, c))),
  );

  return { idempotence, commutativity, associativity };
}

/**
 * Verifies Left-Inverse / Round-Trip law: ∀ x ∈ domain. decode(encode(x)) == x.
 */
export function verifyRoundTrip<T, E>(
  name: string,
  domain: readonly T[],
  encode: (value: T) => E,
  decode: (encoded: E) => T,
  equals: (expected: T, actual: T) => boolean,
): ProofCertificate {
  return forAll(name, domain, (x) => equals(x, decode(encode(x))));
}
