/**
 * Formal Specification: Recording Studio State Machine (Single-IR Dual-Backend LTS)
 *
 * Related ADR: adr/ADR-03-off-main-thread-pcm-capture-and-timeline.md
 * Related ADR: adr/ADR-04-decoupled-60fps-canvas-waveform.md
 * Related ADR: adr/ADR-11-two-tier-formal-verification.md
 * Production implementation: src/audio/recordingEngine.ts
 *
 * SINGLE SOURCE OF TRUTH (Zero Tier-1 ↔ Tier-2 Drift):
 * All 11 safety invariants AND all transition rules are defined ONCE using `exprIr.ts`:
 *   - Tier 1 (BFS Model Checker + Automated Positive/Negative Conformance):
 *       Evaluates `STUDIO_INVARIANT_IR` and `STUDIO_TRANSITION_IR` concretely via `evalInt`/`evalBool`.
 *   - Tier 2 (Z3 SMT Unbounded Mathematical Induction):
 *       Compiles the EXACT SAME `STUDIO_INVARIANT_IR` and `STUDIO_TRANSITION_IR` ASTs
 *       directly into Z3 SMT expressions via `z3ExprCompiler.ts`.
 */

import type { StudioPhase } from '../../audio/recordingEngine';
import { E, evalBool, evalInt, type BoolExpr, type EvalEnv, type IntExpr } from '../core/exprIr';
import type {
  LabeledTransitionSystem,
  ReachabilityGoal,
  SafetyInvariant,
} from '../core/modelChecker';

export const STUDIO_PHASE_CODE: Readonly<Record<StudioPhase, number>> = {
  idle: 0,
  recording: 1,
  paused: 2,
  playing: 3,
};

const CODE_TO_PHASE: readonly StudioPhase[] = ['idle', 'recording', 'paused', 'playing'];

export interface StudioFormalState {
  readonly phase: StudioPhase;
  /** Audio timeline length in discrete time units (1 unit = 1 second in conformance replay). */
  readonly duration: number;
  /** Current playhead position in discrete time units. */
  readonly playhead: number;
  /** Whether the microphone capture stream is currently live. */
  readonly micActive: boolean;
  /** Browser capability: true on Chromium/Android (MediaStreamTrackProcessor), false on Safari/Firefox (AudioWorklet). */
  readonly useTrackProcessor: boolean;
  /** Whether direct MediaStreamTrackProcessor capture is currently live. */
  readonly trackProcessorActive: boolean;
  /** Whether Web Audio AudioWorkletNode capture is currently live. */
  readonly workletActive: boolean;
  /** Whether the Web Audio output AudioContext is currently in 'running' state. */
  readonly outputCtxRunning: boolean;
  /** Whether Web Audio preview playback is currently active. */
  readonly previewActive: boolean;
  /** Whether 1-step trim/punch-in undo snapshot is available. */
  readonly canUndoTrim: boolean;
  /** Snapshot duration stored for 1-step undo (0 when canUndoTrim is false). */
  readonly undoDuration: number;
  /** Whether an unsaved draft exists in IndexedDB. */
  readonly hasDraft: boolean;
}

export type StudioAction =
  | 'start_or_resume'
  | 'capture_chunk'
  | 'pause'
  | 'seek_start'
  | 'seek_mid'
  | 'seek_end'
  | 'play_preview'
  | 'preview_tick'
  | 'preview_ended'
  | 'pause_preview'
  | 'punch_in'
  | 'trim_to_playhead'
  | 'undo_trim'
  | 'finalize'
  | 'discard';

export const STUDIO_ACTIONS: readonly StudioAction[] = [
  'start_or_resume',
  'capture_chunk',
  'pause',
  'seek_start',
  'seek_mid',
  'seek_end',
  'play_preview',
  'preview_tick',
  'preview_ended',
  'pause_preview',
  'punch_in',
  'trim_to_playhead',
  'undo_trim',
  'finalize',
  'discard',
];

export function makeStudioInitialState(useTrackProcessor = false): StudioFormalState {
  return {
    phase: 'idle',
    duration: 0,
    playhead: 0,
    micActive: false,
    useTrackProcessor,
    trackProcessorActive: false,
    workletActive: false,
    outputCtxRunning: false,
    previewActive: false,
    canUndoTrim: false,
    undoDuration: 0,
    hasDraft: false,
  };
}

export const STUDIO_INITIAL_STATE: StudioFormalState = makeStudioInitialState(false);

// ============================================================================
// Shared Declarative IR for State Variables, Invariants & Transitions
// ============================================================================

export interface StudioIrStateVars {
  readonly phase: IntExpr;
  readonly duration: IntExpr;
  readonly playhead: IntExpr;
  readonly micActive: BoolExpr;
  readonly useTrackProcessor: BoolExpr;
  readonly trackProcessorActive: BoolExpr;
  readonly workletActive: BoolExpr;
  readonly outputCtxRunning: BoolExpr;
  readonly previewActive: BoolExpr;
  readonly canUndoTrim: BoolExpr;
  readonly undoDuration: IntExpr;
  readonly hasDraft: BoolExpr;
}

export function studioIrVars(prefix = ''): StudioIrStateVars {
  const p = (name: string) => (prefix ? `${prefix}_${name}` : name);
  return {
    phase: E.intVar(p('phase')),
    duration: E.intVar(p('duration')),
    playhead: E.intVar(p('playhead')),
    micActive: E.boolVar(p('micActive')),
    useTrackProcessor: E.boolVar(p('useTrackProcessor')),
    trackProcessorActive: E.boolVar(p('trackProcessorActive')),
    workletActive: E.boolVar(p('workletActive')),
    outputCtxRunning: E.boolVar(p('outputCtxRunning')),
    previewActive: E.boolVar(p('previewActive')),
    canUndoTrim: E.boolVar(p('canUndoTrim')),
    undoDuration: E.intVar(p('undoDuration')),
    hasDraft: E.boolVar(p('hasDraft')),
  };
}

export function studioStateToEnv(
  s: StudioFormalState,
  extraInts: Readonly<Record<string, number>> = {},
): EvalEnv {
  return {
    ints: {
      phase: STUDIO_PHASE_CODE[s.phase],
      duration: s.duration,
      playhead: s.playhead,
      undoDuration: s.undoDuration,
      ...extraInts,
    },
    bools: {
      micActive: s.micActive,
      useTrackProcessor: s.useTrackProcessor,
      trackProcessorActive: s.trackProcessorActive,
      workletActive: s.workletActive,
      outputCtxRunning: s.outputCtxRunning,
      previewActive: s.previewActive,
      canUndoTrim: s.canUndoTrim,
      hasDraft: s.hasDraft,
    },
  };
}

export interface StudioInvariantIr {
  readonly name: string;
  readonly expr: BoolExpr;
}

const S = studioIrVars();
const IDLE = E.int(STUDIO_PHASE_CODE.idle);
const REC = E.int(STUDIO_PHASE_CODE.recording);
const PAUSED = E.int(STUDIO_PHASE_CODE.paused);
const PLAYING = E.int(STUDIO_PHASE_CODE.playing);

/**
 * The 17 Safety Invariants (□ Inv) defined ONCE as Expression IR ASTs.
 * Evaluated by Tier 1 BFS & Conformance, AND compiled verbatim into Z3 by Tier 2!
 */
export const STUDIO_INVARIANT_IR: readonly StudioInvariantIr[] = [
  {
    name: 'valid_phase_enum',
    expr: E.and(E.ge(S.phase, IDLE), E.le(S.phase, PLAYING)),
  },
  {
    name: 'duration_non_negative',
    expr: E.ge(S.duration, E.int(0)),
  },
  {
    name: 'playhead_within_bounds (0 <= playhead <= duration)',
    expr: E.and(E.ge(S.playhead, E.int(0)), E.le(S.playhead, S.duration)),
  },
  {
    name: 'mic_active_iff_recording',
    expr: E.boolEq(S.micActive, E.eq(S.phase, REC)),
  },
  {
    name: 'capture_backends_mutually_exclusive',
    expr: E.not(E.and(S.trackProcessorActive, S.workletActive)),
  },
  {
    name: 'mic_active_iff_one_capture_backend',
    expr: E.boolEq(S.micActive, E.or(S.trackProcessorActive, S.workletActive)),
  },
  {
    name: 'capture_backend_matches_capability',
    expr: E.implies(
      S.micActive,
      E.and(
        E.boolEq(S.trackProcessorActive, S.useTrackProcessor),
        E.boolEq(S.workletActive, E.not(S.useTrackProcessor)),
      ),
    ),
  },
  {
    name: 'zero_duplex_output_during_track_processor',
    expr: E.implies(S.trackProcessorActive, E.not(S.outputCtxRunning)),
  },
  {
    name: 'preview_requires_output_ctx_running',
    expr: E.implies(S.previewActive, S.outputCtxRunning),
  },
  {
    name: 'preview_active_iff_playing',
    expr: E.boolEq(S.previewActive, E.eq(S.phase, PLAYING)),
  },
  {
    name: 'mutual_exclusion_mic_and_preview',
    expr: E.not(E.and(S.micActive, S.previewActive)),
  },
  {
    name: 'playing_requires_non_empty_audio',
    expr: E.implies(E.eq(S.phase, PLAYING), E.gt(S.duration, E.int(0))),
  },
  {
    name: 'idle_implies_zero_duration_and_playhead',
    expr: E.implies(
      E.eq(S.phase, IDLE),
      E.and(E.eq(S.duration, E.int(0)), E.eq(S.playhead, E.int(0))),
    ),
  },
  {
    name: 'recording_playhead_tracks_live_tail',
    expr: E.implies(E.eq(S.phase, REC), E.eq(S.playhead, S.duration)),
  },
  {
    name: 'active_session_implies_draft_persisted',
    expr: E.implies(E.neq(S.phase, IDLE), S.hasDraft),
  },
  {
    name: 'undo_snapshot_consistent',
    expr: E.iteBool(
      S.canUndoTrim,
      E.ge(S.undoDuration, E.int(0)),
      E.eq(S.undoDuration, E.int(0)),
    ),
  },
  {
    // Inductive strengthening (CTI): an undo snapshot only exists while a draft/timeline is active
    name: 'undo_requires_draft_persisted',
    expr: E.implies(S.canUndoTrim, S.hasDraft),
  },
];

export interface StudioTransitionIr {
  readonly name: string;
  /** Optional symbolic action parameters (e.g., chunk delta, seek target, elapsed ms). */
  readonly intParams?: readonly string[];
  /** Guard condition that must hold for this transition to fire. */
  readonly guard: BoolExpr;
  /** Next-state expressions (omitted fields remain unchanged from `S`). */
  readonly next: {
    readonly phase?: IntExpr;
    readonly duration?: IntExpr;
    readonly playhead?: IntExpr;
    readonly micActive?: BoolExpr;
    readonly useTrackProcessor?: BoolExpr;
    readonly trackProcessorActive?: BoolExpr;
    readonly workletActive?: BoolExpr;
    readonly outputCtxRunning?: BoolExpr;
    readonly previewActive?: BoolExpr;
    readonly canUndoTrim?: BoolExpr;
    readonly undoDuration?: IntExpr;
    readonly hasDraft?: BoolExpr;
  };
}

/**
 * Shared transition rules expressed ONCE in Expression IR.
 * Both Tier 1 (`stepStudioState`) and Tier 2 (`studioStateMachine.z3.formal.test.ts`)
 * execute/compile these exact AST definitions — zero drift is possible.
 */
const CHUNK_DELTA = E.intVar('chunkDelta');
const SEEK_TARGET = E.intVar('seekTarget');
const PREVIEW_ELAPSED = E.intVar('previewElapsed');

function previewStartPlayhead(target: IntExpr, dur: IntExpr): IntExpr {
  return E.iteInt(E.ge(target, dur), E.int(0), target);
}

export const STUDIO_TRANSITIONS_IR: Readonly<Record<string, StudioTransitionIr>> = {
  start_or_resume: {
    name: 'start_or_resume',
    guard: E.bool(true),
    next: {
      phase: REC,
      playhead: S.duration,
      micActive: E.bool(true),
      trackProcessorActive: S.useTrackProcessor,
      workletActive: E.not(S.useTrackProcessor),
      // Direct TrackProcessor suspends any previously opened preview AudioContext!
      outputCtxRunning: E.not(S.useTrackProcessor),
      previewActive: E.bool(false),
      canUndoTrim: E.bool(false),
      undoDuration: E.int(0),
      hasDraft: E.bool(true),
    },
  },
  capture_chunk: {
    name: 'capture_chunk',
    intParams: ['chunkDelta'],
    guard: E.and(E.eq(S.phase, REC), E.gt(CHUNK_DELTA, E.int(0))),
    next: {
      duration: E.add(S.duration, CHUNK_DELTA),
      playhead: E.add(S.duration, CHUNK_DELTA),
    },
  },
  pause: {
    name: 'pause',
    guard: E.eq(S.phase, REC),
    next: {
      phase: PAUSED,
      micActive: E.bool(false),
      trackProcessorActive: E.bool(false),
      workletActive: E.bool(false),
      playhead: S.duration,
    },
  },
  seek: {
    name: 'seek',
    intParams: ['seekTarget'],
    guard: E.neq(S.phase, REC),
    next: {
      // Mirrors RecordingEngine.seekToMs: clamps to [0, duration]; if currently playing
      // and sought to the end, playPreviewFromPlayhead restarts from 0.
      playhead: E.iteInt(
        E.eq(S.phase, PLAYING),
        previewStartPlayhead(E.clamp(SEEK_TARGET, E.int(0), S.duration), S.duration),
        E.clamp(SEEK_TARGET, E.int(0), S.duration),
      ),
    },
  },
  play_preview: {
    name: 'play_preview',
    guard: E.gt(S.duration, E.int(0)),
    next: {
      phase: PLAYING,
      playhead: previewStartPlayhead(S.playhead, S.duration),
      micActive: E.bool(false),
      trackProcessorActive: E.bool(false),
      workletActive: E.bool(false),
      outputCtxRunning: E.bool(true),
      previewActive: E.bool(true),
    },
  },
  preview_tick: {
    name: 'preview_tick',
    intParams: ['previewElapsed'],
    guard: E.and(E.eq(S.phase, PLAYING), E.ge(PREVIEW_ELAPSED, E.int(0))),
    next: {
      playhead: E.min(S.duration, E.add(S.playhead, PREVIEW_ELAPSED)),
    },
  },
  preview_ended: {
    name: 'preview_ended',
    guard: E.eq(S.phase, PLAYING),
    next: {
      phase: PAUSED,
      previewActive: E.bool(false),
      playhead: S.duration,
    },
  },
  pause_preview: {
    name: 'pause_preview',
    guard: E.eq(S.phase, PLAYING),
    next: {
      phase: PAUSED,
      previewActive: E.bool(false),
    },
  },
  punch_in: {
    name: 'punch_in',
    guard: E.bool(true),
    next: {
      phase: REC,
      duration: E.iteInt(S.hasDraft, S.playhead, E.int(0)),
      playhead: E.iteInt(S.hasDraft, S.playhead, E.int(0)),
      micActive: E.bool(true),
      trackProcessorActive: S.useTrackProcessor,
      workletActive: E.not(S.useTrackProcessor),
      outputCtxRunning: E.not(S.useTrackProcessor),
      previewActive: E.bool(false),
      canUndoTrim: S.hasDraft,
      undoDuration: E.iteInt(S.hasDraft, S.duration, E.int(0)),
      hasDraft: E.bool(true),
    },
  },
  trim_to_playhead: {
    name: 'trim_to_playhead',
    guard: S.hasDraft,
    next: {
      phase: E.iteInt(
        E.gt(E.iteInt(E.eq(S.phase, REC), S.duration, S.playhead), E.int(0)),
        PAUSED,
        IDLE,
      ),
      duration: E.iteInt(E.eq(S.phase, REC), S.duration, S.playhead),
      playhead: E.iteInt(E.eq(S.phase, REC), S.duration, S.playhead),
      micActive: E.bool(false),
      trackProcessorActive: E.bool(false),
      workletActive: E.bool(false),
      previewActive: E.bool(false),
      canUndoTrim: E.bool(true),
      undoDuration: S.duration,
    },
  },
  undo_trim: {
    name: 'undo_trim',
    guard: S.canUndoTrim,
    next: {
      phase: E.iteInt(E.gt(S.undoDuration, E.int(0)), PAUSED, IDLE),
      duration: S.undoDuration,
      playhead: S.undoDuration,
      micActive: E.bool(false),
      trackProcessorActive: E.bool(false),
      workletActive: E.bool(false),
      previewActive: E.bool(false),
      canUndoTrim: E.bool(false),
      undoDuration: E.int(0),
    },
  },
  finalize: {
    name: 'finalize',
    guard: E.gt(S.duration, E.int(0)),
    next: {
      phase: IDLE,
      duration: E.int(0),
      playhead: E.int(0),
      micActive: E.bool(false),
      trackProcessorActive: E.bool(false),
      workletActive: E.bool(false),
      previewActive: E.bool(false),
      canUndoTrim: E.bool(false),
      undoDuration: E.int(0),
      hasDraft: E.bool(false),
    },
  },
  discard: {
    name: 'discard',
    guard: E.bool(true),
    next: {
      phase: IDLE,
      duration: E.int(0),
      playhead: E.int(0),
      micActive: E.bool(false),
      trackProcessorActive: E.bool(false),
      workletActive: E.bool(false),
      previewActive: E.bool(false),
      canUndoTrim: E.bool(false),
      undoDuration: E.int(0),
      hasDraft: E.bool(false),
    },
  },
};

function evalTransitionIr(
  s: StudioFormalState,
  ir: StudioTransitionIr,
  params: Readonly<Record<string, number>> = {},
): StudioFormalState | null {
  const env = studioStateToEnv(s, params);
  if (!evalBool(ir.guard, env)) return null;
  const nextPhaseCode = ir.next.phase ? evalInt(ir.next.phase, env) : STUDIO_PHASE_CODE[s.phase];
  return {
    phase: CODE_TO_PHASE[nextPhaseCode],
    duration: ir.next.duration ? evalInt(ir.next.duration, env) : s.duration,
    playhead: ir.next.playhead ? evalInt(ir.next.playhead, env) : s.playhead,
    micActive: ir.next.micActive ? evalBool(ir.next.micActive, env) : s.micActive,
    useTrackProcessor: ir.next.useTrackProcessor
      ? evalBool(ir.next.useTrackProcessor, env)
      : s.useTrackProcessor,
    trackProcessorActive: ir.next.trackProcessorActive
      ? evalBool(ir.next.trackProcessorActive, env)
      : s.trackProcessorActive,
    workletActive: ir.next.workletActive
      ? evalBool(ir.next.workletActive, env)
      : s.workletActive,
    outputCtxRunning: ir.next.outputCtxRunning
      ? evalBool(ir.next.outputCtxRunning, env)
      : s.outputCtxRunning,
    previewActive: ir.next.previewActive ? evalBool(ir.next.previewActive, env) : s.previewActive,
    canUndoTrim: ir.next.canUndoTrim ? evalBool(ir.next.canUndoTrim, env) : s.canUndoTrim,
    undoDuration: ir.next.undoDuration ? evalInt(ir.next.undoDuration, env) : s.undoDuration,
    hasDraft: ir.next.hasDraft ? evalBool(ir.next.hasDraft, env) : s.hasDraft,
  };
}

/**
 * Tier 1 Safety Invariants derived directly from `STUDIO_INVARIANT_IR`.
 */
export const STUDIO_INVARIANTS: readonly SafetyInvariant<StudioFormalState>[] =
  STUDIO_INVARIANT_IR.map((inv) => ({
    name: inv.name,
    check: (s) => evalBool(inv.expr, studioStateToEnv(s)),
  }));

export const STUDIO_REACHABILITY_GOALS: readonly ReachabilityGoal<StudioFormalState>[] =
  [
    {
      name: 'can_record_audio',
      check: (s) => s.phase === 'recording' && s.duration > 0,
    },
    {
      name: 'can_scrub_mid_take_while_paused',
      check: (s) =>
        s.phase === 'paused' && s.playhead > 0 && s.playhead < s.duration,
    },
    {
      name: 'can_play_preview',
      check: (s) => s.phase === 'playing' && s.previewActive && !s.micActive,
    },
    {
      name: 'can_punch_in_and_retain_undo',
      check: (s) => s.phase === 'recording' && s.canUndoTrim,
    },
    {
      name: 'can_trim_to_zero_and_keep_undo_snapshot',
      check: (s) =>
        s.phase === 'idle' &&
        s.duration === 0 &&
        s.canUndoTrim &&
        s.undoDuration > 0,
    },
    {
      name: 'can_recover_from_trim_to_zero_via_undo',
      check: (s) =>
        s.phase === 'paused' && s.duration > 0 && !s.canUndoTrim,
    },
  ];

/**
 * Tier 1 step relation executed directly from `STUDIO_TRANSITIONS_IR`.
 */
export function stepStudioState(
  s: StudioFormalState,
  action: StudioAction,
  maxDuration = 3,
): StudioFormalState | null {
  switch (action) {
    case 'capture_chunk':
      if (s.duration >= maxDuration) return null;
      return evalTransitionIr(s, STUDIO_TRANSITIONS_IR.capture_chunk, { chunkDelta: 1 });
    case 'seek_start':
      return evalTransitionIr(s, STUDIO_TRANSITIONS_IR.seek, {
        seekTarget: 0,
      });
    case 'seek_mid':
      if (s.duration < 2) return null;
      return evalTransitionIr(s, STUDIO_TRANSITIONS_IR.seek, {
        seekTarget: Math.floor(s.duration / 2),
      });
    case 'seek_end':
      return evalTransitionIr(s, STUDIO_TRANSITIONS_IR.seek, {
        seekTarget: s.duration,
      });
    case 'play_preview':
      return evalTransitionIr(s, STUDIO_TRANSITIONS_IR.play_preview);
    case 'preview_tick':
      return evalTransitionIr(s, STUDIO_TRANSITIONS_IR.preview_tick, { previewElapsed: 1 });
    default:
      return evalTransitionIr(s, STUDIO_TRANSITIONS_IR[action]);
  }
}

export function serializeStudioState(s: StudioFormalState): string {
  return [
    s.phase,
    s.duration,
    s.playhead,
    s.micActive ? 1 : 0,
    s.useTrackProcessor ? 1 : 0,
    s.trackProcessorActive ? 1 : 0,
    s.workletActive ? 1 : 0,
    s.outputCtxRunning ? 1 : 0,
    s.previewActive ? 1 : 0,
    s.canUndoTrim ? 1 : 0,
    s.undoDuration,
    s.hasDraft ? 1 : 0,
  ].join('|');
}

export function createStudioLts(
  maxDuration = 3,
  useTrackProcessor?: boolean,
): LabeledTransitionSystem<StudioFormalState, StudioAction> {
  const initialStates =
    typeof useTrackProcessor === 'boolean'
      ? [makeStudioInitialState(useTrackProcessor)]
      : [makeStudioInitialState(false), makeStudioInitialState(true)];
  return {
    name: 'RecordingStudio',
    initialStates,
    actions: STUDIO_ACTIONS,
    step: (state, action) => stepStudioState(state, action, maxDuration),
    serialize: serializeStudioState,
    invariants: STUDIO_INVARIANTS,
    reachabilityGoals: STUDIO_REACHABILITY_GOALS,
    maxStates: 20_000,
  };
}
