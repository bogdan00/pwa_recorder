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
