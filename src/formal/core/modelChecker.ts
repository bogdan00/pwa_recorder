/**
 * Explicit-State Breadth-First Search (BFS) Model Checker.
 *
 * Textbook background:
 * A Labeled Transition System (LTS) is a tuple (S, S0, A, ->) where:
 *   - S  is the set of states
 *   - S0 ⊆ S is the set of initial states
 *   - A  is the finite alphabet of actions/events
 *   - -> ⊆ S × A × S is the transition relation
 *
 * This engine performs exhaustive BFS over all states reachable from S0:
 *   1. Safety (□ I, "Always I"): verifies every invariant holds in every reachable state.
 *      Because exploration is BFS, any violation produces the **shortest** counterexample trace.
 *   2. Reachability (◇ G, "Eventually G"): verifies non-vacuity — important target states
 *      are actually reachable, preventing trivially-safe broken models.
 *   3. Trace harvesting: records minimal witness traces for every reachable state so
 *      differential conformance tests can replay them directly against production code.
 */

export interface SafetyInvariant<S> {
  readonly name: string;
  readonly check: (state: S) => boolean;
}

export interface ReachabilityGoal<S> {
  readonly name: string;
  readonly check: (state: S) => boolean;
}

export interface TransitionStep<S, A> {
  readonly action: A;
  readonly state: S;
}

export interface LabeledTransitionSystem<S, A> {
  readonly name: string;
  readonly initialStates: readonly S[];
  readonly actions: readonly A[];
  /**
   * Deterministic or non-deterministic transition relation.
   * Return `null` if the action is disabled (guard is false) in `state`,
   * or return the successor state (or array of successor states for non-determinism).
   */
  readonly step: (state: S, action: A) => S | readonly S[] | null;
  /** Canonical lossless state key used for visited-set deduplication. */
  readonly serialize: (state: S) => string;
  /** Safety properties □ I that must hold in EVERY reachable state. */
  readonly invariants: readonly SafetyInvariant<S>[];
  /** Optional reachability witnesses ◇ G proving the model is non-vacuous. */
  readonly reachabilityGoals?: readonly ReachabilityGoal<S>[];
  /** Safety guard against accidental infinite state spaces in finite specs. */
  readonly maxStates?: number;
}

export interface CounterexampleTrace<S, A> {
  readonly invariantName: string;
  readonly initialState: S;
  readonly steps: readonly TransitionStep<S, A>[];
  readonly violatingState: S;
}

export interface ModelCheckCertificate<S, A> {
  readonly systemName: string;
  readonly statesExplored: number;
  readonly transitionsExplored: number;
  readonly maxDepth: number;
  readonly reachedGoals: readonly string[];
  /** Shortest action sequence from an initial state to each reachable canonical state key. */
  readonly witnessTraces: ReadonlyMap<
    string,
    { readonly initialState: S; readonly steps: readonly TransitionStep<S, A>[] }
  >;
}

function formatTrace<S, A>(ce: CounterexampleTrace<S, A>): string {
  const lines: string[] = [
    `Safety invariant violated: "${ce.invariantName}"`,
    `  Initial state: ${JSON.stringify(ce.initialState)}`,
  ];
  ce.steps.forEach((step, idx) => {
    lines.push(
      `  Step ${idx + 1}: --[${JSON.stringify(step.action)}]--> ${JSON.stringify(step.state)}`,
    );
  });
  lines.push(`  Violating state: ${JSON.stringify(ce.violatingState)}`);
  return lines.join('\n');
}

/**
 * Exhaustively model-checks a Labeled Transition System using BFS.
 * Throws a detailed minimal counterexample trace if any safety invariant fails,
 * if a reachability goal is unreachable, or if the state bound is exceeded.
 */
export function modelCheck<S, A>(
  lts: LabeledTransitionSystem<S, A>,
): ModelCheckCertificate<S, A> {
  const maxStates = lts.maxStates ?? 25_000;
  const visited = new Set<string>();
  const witnessTraces = new Map<
    string,
    { readonly initialState: S; readonly steps: readonly TransitionStep<S, A>[] }
  >();
  const satisfiedGoals = new Set<string>();

  interface QueueNode {
    readonly state: S;
    readonly initialState: S;
    readonly steps: readonly TransitionStep<S, A>[];
  }

  const queue: QueueNode[] = [];
  let queueHead = 0;
  let transitionsExplored = 0;
  let maxDepth = 0;

  const inspectState = (node: QueueNode): void => {
    for (const inv of lts.invariants) {
      if (!inv.check(node.state)) {
        const ce: CounterexampleTrace<S, A> = {
          invariantName: inv.name,
          initialState: node.initialState,
          steps: node.steps,
          violatingState: node.state,
        };
        throw new Error(`[ModelChecker:${lts.name}]\n${formatTrace(ce)}`);
      }
    }

    if (lts.reachabilityGoals) {
      for (const goal of lts.reachabilityGoals) {
        if (!satisfiedGoals.has(goal.name) && goal.check(node.state)) {
          satisfiedGoals.add(goal.name);
        }
      }
    }
  };

  for (const init of lts.initialStates) {
    const key = lts.serialize(init);
    if (!visited.has(key)) {
      visited.add(key);
      const node: QueueNode = { state: init, initialState: init, steps: [] };
      inspectState(node);
      witnessTraces.set(key, { initialState: init, steps: [] });
      queue.push(node);
    }
  }

  while (queueHead < queue.length) {
    const current = queue[queueHead++];
    if (current.steps.length > maxDepth) {
      maxDepth = current.steps.length;
    }

    for (const action of lts.actions) {
      const result = lts.step(current.state, action);
      if (result === null) continue;

      const successors: readonly S[] = Array.isArray(result)
        ? (result as readonly S[])
        : [result as S];
      for (const nextState of successors) {
        transitionsExplored += 1;
        const nextSteps: readonly TransitionStep<S, A>[] = [
          ...current.steps,
          { action, state: nextState },
        ];
        const nextKey = lts.serialize(nextState);
        if (!visited.has(nextKey)) {
          visited.add(nextKey);
          if (visited.size > maxStates) {
            throw new Error(
              `[ModelChecker:${lts.name}] State space exceeded bound (${maxStates} states). Tighten abstraction or increase maxStates.`,
            );
          }
          const nextNode: QueueNode = {
            state: nextState,
            initialState: current.initialState,
            steps: nextSteps,
          };
          inspectState(nextNode);
          witnessTraces.set(nextKey, {
            initialState: current.initialState,
            steps: nextSteps,
          });
          queue.push(nextNode);
        }
      }
    }
  }

  if (lts.reachabilityGoals) {
    for (const goal of lts.reachabilityGoals) {
      if (!satisfiedGoals.has(goal.name)) {
        throw new Error(
          `[ModelChecker:${lts.name}] Reachability goal "${goal.name}" was NEVER reached across ${visited.size} explored states (possible vacuous model or dead transition).`,
        );
      }
    }
  }

  return {
    systemName: lts.name,
    statesExplored: visited.size,
    transitionsExplored,
    maxDepth,
    reachedGoals: Array.from(satisfiedGoals),
    witnessTraces,
  };
}

// ============================================================================
// Automated Refinement / Differential Conformance Engine (Positive + Negative)
// ============================================================================

export interface ConformanceAdapter<S, A, Impl> {
  /** Create a fresh isolated production instance matching `initialState`. */
  readonly createImpl: (initialState: S) => Promise<Impl> | Impl;
  /** Dispose/cleanup production instance after each trace. */
  readonly destroyImpl?: (impl: Impl) => Promise<void> | void;
  /** Execute an action (either enabled OR disabled) on the real implementation. */
  readonly execute: (impl: Impl, action: A, currentSpec: S) => Promise<void> | void;
  /** Abstraction function α(impl) -> formal state S. */
  readonly observe: (impl: Impl) => S;
  /** Optional custom comparator (defaults to lts.serialize equality). */
  readonly statesMatch?: (spec: S, observed: S, action: A | null) => boolean;
  /**
   * Optional subset of disabled actions to probe as no-ops at visited states.
   * Defaults to ALL actions in `lts.actions` where `lts.step(s, a) === null`.
   */
  readonly negativeProbeActions?: readonly A[];
}

export interface ConformanceCertificate {
  readonly systemName: string;
  readonly tracesReplayed: number;
  readonly enabledStepsVerified: number;
  readonly disabledGuardsVerified: number;
  readonly distinctStatesCovered: number;
}

/**
 * Selects a minimal set of maximal BFS witness traces (prefixes pruned) that cover
 * 100% of reachable states — avoiding redundant replays of strict prefixes.
 */
export function selectMaximalWitnessTraces<S, A>(
  cert: ModelCheckCertificate<S, A>,
  serialize: (state: S) => string,
): ReadonlyArray<{
  readonly targetKey: string;
  readonly initialState: S;
  readonly steps: readonly TransitionStep<S, A>[];
}> {
  const all = Array.from(cert.witnessTraces.entries()).map(([targetKey, trace]) => ({
    targetKey,
    initialState: trace.initialState,
    steps: trace.steps,
  }));

  // Sort longest-first so shorter strict prefixes are subsumed automatically
  all.sort((a, b) => b.steps.length - a.steps.length);

  const coveredKeys = new Set<string>();
  const selected: Array<{
    readonly targetKey: string;
    readonly initialState: S;
    readonly steps: readonly TransitionStep<S, A>[];
  }> = [];

  for (const candidate of all) {
    if (coveredKeys.has(candidate.targetKey)) continue;
    selected.push(candidate);
    coveredKeys.add(serialize(candidate.initialState));
    for (const step of candidate.steps) {
      coveredKeys.add(serialize(step.state));
    }
  }

  return selected;
}

/**
 * Automated Positive + Negative Differential Conformance Verifier.
 *
 * Replays BFS-harvested traces against the REAL production implementation:
 *   1. Positive conformance: after every enabled action `a`, asserts α(real) === specNext
 *      and every formal safety invariant holds on α(real).
 *   2. Negative conformance (guard verification): at every newly visited state `s`,
 *      probes every disabled action (`lts.step(s, a) === null`) against the REAL
 *      implementation and asserts α(real) remains strictly unchanged!
 */
export async function verifyConformance<S, A, Impl>(
  lts: LabeledTransitionSystem<S, A>,
  cert: ModelCheckCertificate<S, A>,
  adapter: ConformanceAdapter<S, A, Impl>,
  options?: { readonly maxTraces?: number },
): Promise<ConformanceCertificate> {
  const maximal = selectMaximalWitnessTraces(cert, lts.serialize);
  const traces =
    options?.maxTraces !== undefined ? maximal.slice(0, options.maxTraces) : maximal;

  const statesMatch =
    adapter.statesMatch ??
    ((spec: S, obs: S) => lts.serialize(spec) === lts.serialize(obs));
  const negativeCandidates = adapter.negativeProbeActions ?? lts.actions;

  const coveredStateKeys = new Set<string>();
  const probedStateKeys = new Set<string>();
  let enabledStepsVerified = 0;
  let disabledGuardsVerified = 0;

  const assertInvariants = (observed: S, context: string): void => {
    for (const inv of lts.invariants) {
      if (!inv.check(observed)) {
        throw new Error(
          `[Conformance:${lts.name}] Production state violated invariant "${inv.name}" at ${context}\n  Observed α(impl): ${JSON.stringify(observed)}`,
        );
      }
    }
  };

  for (let tIdx = 0; tIdx < traces.length; tIdx += 1) {
    const trace = traces[tIdx];
    const impl = await adapter.createImpl(trace.initialState);
    try {
      let currentSpec = trace.initialState;
      const initObs = adapter.observe(impl);
      if (!statesMatch(currentSpec, initObs, null)) {
        throw new Error(
          `[Conformance:${lts.name}] Initial state mismatch on trace #${tIdx + 1}:\n  Spec:     ${JSON.stringify(currentSpec)}\n  Observed: ${JSON.stringify(initObs)}`,
        );
      }
      assertInvariants(initObs, `trace #${tIdx + 1} [init]`);
      coveredStateKeys.add(lts.serialize(currentSpec));

      const probeDisabledAtCurrent = async (stepLabel: string): Promise<void> => {
        const key = lts.serialize(currentSpec);
        if (probedStateKeys.has(key)) return;
        probedStateKeys.add(key);

        for (const candidate of negativeCandidates) {
          if (lts.step(currentSpec, candidate) !== null) continue;
          const beforeObs = adapter.observe(impl);
          await adapter.execute(impl, candidate, currentSpec);
          const afterObs = adapter.observe(impl);
          disabledGuardsVerified += 1;

          if (lts.serialize(beforeObs) !== lts.serialize(afterObs)) {
            throw new Error(
              `[Conformance:${lts.name}] NEGATIVE GUARD FAILURE at ${stepLabel}: disabled action ${JSON.stringify(candidate)} mutated production state!\n  Before: ${JSON.stringify(beforeObs)}\n  After:  ${JSON.stringify(afterObs)}`,
            );
          }
          assertInvariants(afterObs, `${stepLabel} [negative probe: ${JSON.stringify(candidate)}]`);
        }
      };

      await probeDisabledAtCurrent(`trace #${tIdx + 1} [init]`);

      for (let sIdx = 0; sIdx < trace.steps.length; sIdx += 1) {
        const step = trace.steps[sIdx];
        const stepLabel = `trace #${tIdx + 1} step ${sIdx + 1}/${trace.steps.length} (${JSON.stringify(step.action)})`;

        await adapter.execute(impl, step.action, currentSpec);
        currentSpec = step.state;
        enabledStepsVerified += 1;
        coveredStateKeys.add(lts.serialize(currentSpec));

        const observed = adapter.observe(impl);
        if (!statesMatch(currentSpec, observed, step.action)) {
          throw new Error(
            `[Conformance:${lts.name}] Refinement mismatch at ${stepLabel}:\n  Spec:     ${JSON.stringify(currentSpec)}\n  Observed: ${JSON.stringify(observed)}`,
          );
        }
        assertInvariants(observed, stepLabel);

        await probeDisabledAtCurrent(stepLabel);
      }
    } finally {
      if (adapter.destroyImpl) {
        await adapter.destroyImpl(impl);
      }
    }
  }

  return {
    systemName: lts.name,
    tracesReplayed: traces.length,
    enabledStepsVerified,
    disabledGuardsVerified,
    distinctStatesCovered: coveredStateKeys.size,
  };
}

