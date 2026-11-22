/**
 * Formal Specification: Software AGC / Soft-Limiter Stability & Quality Monitor Lattice
 *
 * Related ADRs:
 *   - adr/ADR-03-off-main-thread-pcm-capture-and-timeline.md
 *   - adr/ADR-11-two-tier-formal-verification.md
 * Production implementations:
 *   - src/audio/inputStrip.ts (`SoftwareAutoGainController`, `softLimitSample`)
 *   - src/audio/recordingQualityAnalyzer.ts (`joinQualitySeverity`, `aggregateOverallQualityStatus`, `RecordingQualityAnalyzer`)
 *
 * Defines canonical constants and algebraic/numerical invariants verified by:
 *   - Tier 1 (`audioDspAndQuality.proof.test.ts`): exhaustive algebraic laws & conformance against real TS code.
 *   - Tier 2 (`audioDspAndQuality.z3.formal.test.ts`): unbounded Z3 SMT proofs over ℝ and ℤ.
 */

import {
  SOFT_CLIP_CEILING,
  SOFT_CLIP_THRESHOLD,
  SOFTWARE_AGC_COMP_REDUCTION_TRIGGER_DB,
  SOFTWARE_AGC_INITIAL_GAIN,
  SOFTWARE_AGC_MAX_GAIN,
  SOFTWARE_AGC_MIN_GAIN,
  SOFTWARE_AGC_PEAK_CEILING,
  SOFTWARE_AGC_TARGET_RMS,
} from '../../audio/inputStrip';
import {
  MAX_GLITCH_LOG_ENTRIES,
  type QualitySeverity,
} from '../../audio/recordingQualityAnalyzer';

export const AUDIO_DSP_CONTRACT = {
  softClipThreshold: SOFT_CLIP_THRESHOLD,
  softClipCeiling: SOFT_CLIP_CEILING,
  agcInitialGain: SOFTWARE_AGC_INITIAL_GAIN,
  agcMinGain: SOFTWARE_AGC_MIN_GAIN,
  agcMaxGain: SOFTWARE_AGC_MAX_GAIN,
  agcTargetRms: SOFTWARE_AGC_TARGET_RMS,
  agcPeakCeiling: SOFTWARE_AGC_PEAK_CEILING,
  agcCompReductionTriggerDb: SOFTWARE_AGC_COMP_REDUCTION_TRIGGER_DB,
  maxGlitchLogEntries: MAX_GLITCH_LOG_ENTRIES,
} as const;

export const QUALITY_SEVERITY_DOMAIN: readonly QualitySeverity[] = [
  'good',
  'warn',
  'critical',
];

export const QUALITY_SEVERITY_CODE: Readonly<Record<QualitySeverity, number>> = {
  good: 0,
  warn: 1,
  critical: 2,
};
