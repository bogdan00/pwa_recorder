/**
 * Formal Specification: Recording Studio State Machine (Labeled Transition System)
 *
 * Related ADR: adr/ADR-03-off-main-thread-pcm-capture-and-timeline.md
 * Related ADR: adr/ADR-04-decoupled-60fps-canvas-waveform.md
 * Related ADR: adr/ADR-11-two-tier-formal-verification.md
 * Production implementation: src/audio/recordingEngine.ts
 *
 * Single Source of Truth:
 *   - Tier 1 (BFS Model Checker) explores 100% of reachable states over a finite
 *     duration bound (MAX_DURATION_UNITS = 3) and replays witness traces against
 *     the real `RecordingEngine` class to verify conformance.
 *   - Tier 2 (Z3 SMT Induction) proves the EXACT SAME safety invariants over
 *     unbounded durations (duration ∈ ℤ≥0) and arbitrarily long action sequences.
 */

import type { StudioPhase } from '../../audio/recordingEngine';
import type {
  LabeledTransitionSystem,
  ReachabilityGoal,
  SafetyInvariant,
} from '../core/modelChecker';

export interface StudioFormalState {
  readonly phase: StudioPhase;
  /** Audio timeline length in discrete time units (1 unit = 1 second in conformance replay). */
  readonly duration: number;
  /** Current playhead position in discrete time units. */
  readonly playhead: number;
  /** Whether the microphone capture worklet/stream is currently live. */
  readonly micActive: boolean;
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

export const STUDIO_INITIAL_STATE: StudioFormalState = {
  phase: 'idle',
  duration: 0,
  playhead: 0,
  micActive: false,
  previewActive: false,
  canUndoTrim: false,
  undoDuration: 0,
  hasDraft: false,
};

/**
 * Safety Invariants (□ Inv) — must hold in EVERY reachable state of StoryTape Studio.
 * The same 9 invariants are proved by BFS (Tier 1) and Z3 Induction (Tier 2).
 */
export const STUDIO_INVARIANTS: readonly SafetyInvariant<StudioFormalState>[] = [
  {
    name: 'duration_non_negative',
    check: (s) => s.duration >= 0,
  },
  {
    name: 'playhead_within_bounds (0 <= playhead <= duration)',
    check: (s) => s.playhead >= 0 && s.playhead <= s.duration,
  },
  {
    name: 'mic_active_iff_recording',
    check: (s) => s.micActive === (s.phase === 'recording'),
  },
  {
    name: 'preview_active_iff_playing',
    check: (s) => s.previewActive === (s.phase === 'playing'),
  },
  {
    name: 'mutual_exclusion_mic_and_preview',
    check: (s) => !(s.micActive && s.previewActive),
  },
  {
    name: 'playing_requires_non_empty_audio',
    check: (s) => s.phase !== 'playing' || s.duration > 0,
  },
  {
    name: 'idle_implies_zero_duration_and_playhead',
    check: (s) =>
      s.phase !== 'idle' || (s.duration === 0 && s.playhead === 0),
  },
  {
    name: 'recording_playhead_tracks_live_tail',
    check: (s) => s.phase !== 'recording' || s.playhead === s.duration,
  },
  {
    name: 'active_session_implies_draft_persisted',
    check: (s) => s.phase === 'idle' || s.hasDraft,
  },
  {
    name: 'undo_snapshot_consistent',
    check: (s) => (s.canUndoTrim ? s.undoDuration >= 0 : s.undoDuration === 0),
  },
  {
    // Inductive strengthening (CTI): an undo snapshot only exists while a draft/timeline is active
    name: 'undo_requires_draft_persisted',
    check: (s) => !s.canUndoTrim || s.hasDraft,
  },
];

/**
 * Reachability Goals (◇ Goal) — prove the transition system is non-vacuous and all
 * key CUJ-02/CUJ-03 user workflows are reachable.
 */
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
 * Pure step relation matching `RecordingEngine` semantics.
 * `maxDuration` bounds `capture_chunk` so Tier-1 BFS explores a finite canonical state space.
 */
export function stepStudioState(
  s: StudioFormalState,
  action: StudioAction,
  maxDuration = 3,
): StudioFormalState | null {
  switch (action) {
    case 'start_or_resume': {
      // Safe append from end; stops any preview, clears undo, starts mic
      return {
        ...s,
        phase: 'recording',
        playhead: s.duration,
        micActive: true,
        previewActive: false,
        canUndoTrim: false,
        undoDuration: 0,
        hasDraft: true,
      };
    }

    case 'capture_chunk': {
      if (s.phase !== 'recording' || s.duration >= maxDuration) return null;
      const nextDuration = s.duration + 1;
      return {
        ...s,
        duration: nextDuration,
        playhead: nextDuration,
      };
    }

    case 'pause': {
      if (s.phase !== 'recording') return null;
      return {
        ...s,
        phase: 'paused',
        micActive: false,
        playhead: s.duration,
      };
    }

    case 'seek_start': {
      if (s.phase === 'recording') return null;
      if (s.phase === 'playing') {
        // Seeking while playing restarts preview from 0 (valid because playing => duration > 0)
        return { ...s, playhead: 0 };
      }
      return { ...s, playhead: 0 };
    }

    case 'seek_mid': {
      if (s.phase === 'recording' || s.duration < 2) return null;
      const mid = Math.floor(s.duration / 2);
      return { ...s, playhead: mid };
    }

    case 'seek_end': {
      if (s.phase === 'recording') return null;
      if (s.phase === 'playing') {
        // Mirror RecordingEngine.playPreviewFromPlayhead: seeking to very end rewinds back from end
        const rewindPos = Math.max(0, s.duration - 1);
        return { ...s, playhead: rewindPos };
      }
      return { ...s, playhead: s.duration };
    }

    case 'play_preview': {
      if (s.duration === 0) return null;
      // If playhead is already at end, rewind smoothly (mirrors RecordingEngine.playPreviewFromPlayhead)
      const effectivePlayhead =
        s.playhead >= s.duration ? Math.max(0, s.duration - 1) : s.playhead;
      return {
        ...s,
        phase: 'playing',
        playhead: effectivePlayhead,
        micActive: false,
        previewActive: true,
      };
    }

    case 'preview_tick': {
      if (s.phase !== 'playing') return null;
      const nextPlayhead = Math.min(s.duration, s.playhead + 1);
      return {
        ...s,
        playhead: nextPlayhead,
      };
    }

    case 'preview_ended': {
      if (s.phase !== 'playing') return null;
      return {
        ...s,
        phase: 'paused',
        previewActive: false,
        playhead: s.duration,
      };
    }

    case 'pause_preview': {
      if (s.phase !== 'playing') return null;
      return {
        ...s,
        phase: 'paused',
        previewActive: false,
      };
    }

    case 'punch_in': {
      // Truncate at current playhead (saving 1-step undo snapshot) & start recording
      const hasTimeline = s.hasDraft;
      const newDuration = hasTimeline ? s.playhead : 0;
      return {
        ...s,
        phase: 'recording',
        duration: newDuration,
        playhead: newDuration,
        micActive: true,
        previewActive: false,
        canUndoTrim: hasTimeline,
        undoDuration: hasTimeline ? s.duration : 0,
        hasDraft: true,
      };
    }

    case 'trim_to_playhead': {
      if (!s.hasDraft) return null;
      // Mirrors RecordingEngine.trimToPlayhead (pause if recording -> truncate at playhead)
      const cutAt = s.phase === 'recording' ? s.duration : s.playhead;
      return {
        ...s,
        phase: cutAt > 0 ? 'paused' : 'idle',
        duration: cutAt,
        playhead: cutAt,
        micActive: false,
        previewActive: false,
        canUndoTrim: true,
        undoDuration: s.duration,
      };
    }

    case 'undo_trim': {
      if (!s.canUndoTrim) return null;
      const restored = s.undoDuration;
      return {
        ...s,
        phase: restored > 0 ? 'paused' : 'idle',
        duration: restored,
        playhead: restored,
        micActive: false,
        previewActive: false,
        canUndoTrim: false,
        undoDuration: 0,
      };
    }

    case 'finalize': {
      if (s.duration === 0) return null;
      return { ...STUDIO_INITIAL_STATE };
    }

    case 'discard': {
      return { ...STUDIO_INITIAL_STATE };
    }
  }
}

export function serializeStudioState(s: StudioFormalState): string {
  return [
    s.phase,
    s.duration,
    s.playhead,
    s.micActive ? 1 : 0,
    s.previewActive ? 1 : 0,
    s.canUndoTrim ? 1 : 0,
    s.undoDuration,
    s.hasDraft ? 1 : 0,
  ].join('|');
}

export function createStudioLts(
  maxDuration = 3,
): LabeledTransitionSystem<StudioFormalState, StudioAction> {
  return {
    name: 'RecordingStudio',
    initialStates: [STUDIO_INITIAL_STATE],
    actions: STUDIO_ACTIONS,
    step: (state, action) => stepStudioState(state, action, maxDuration),
    serialize: serializeStudioState,
    invariants: STUDIO_INVARIANTS,
    reachabilityGoals: STUDIO_REACHABILITY_GOALS,
    maxStates: 10_000,
  };
}
