export interface CapturedTrackSettingsSummary {
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  voiceIsolation?: boolean;
}

export interface RecordingQualitySummary {
  overallStatus: 'listening' | 'good' | 'warn' | 'critical';
  analyzedSec: number;
  speechSec: number;
  totalClicks: number;
  totalDropouts: number;
  saturatedFrameRatio: number;
  speechRmsDb: number | null;
  noiseFloorDb: number | null;
  snrDb: number | null;
  clarityTiltDb: number | null;
  triggeredCodes: string[];
}

export interface RecordingPerfSnapshot {
  capturedAt: string;
  durationSec: number;
  sampleRate: number;
  channels: 1 | 2;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  captureMode: 'trackProcessor' | 'worklet' | 'scriptProcessor' | 'none';
  deviceLabel?: string;
  nativeAgcActive?: boolean;
  trackSettings?: CapturedTrackSettingsSummary;
  softwareAgcActive: boolean;
  softwareAgcFinalGainDb?: number | null;
  peakLevel?: number;
  minCompressorReductionDb?: number | null;
  saturatedChunks?: number;
  timestampGapCount?: number;
  maxTimestampGapMs?: number;
  discardedFrames?: number | null;
  takeSegments?: number;
  backgroundKeepaliveEnabled: boolean;
  chunkCount: number;
  avgChunkGapMs: number;
  maxChunkGapMs: number;
  chunksOver60ms: number;
  rafFrames: number;
  fps: number;
  p95FrameMs: number;
  severeStallsOver50ms: number;
  playheadStallFrames: number;
  playheadJumpFrames: number;
  maxPlayheadStepMs: number;
  qualitySummary?: RecordingQualitySummary | null;
}

let lastSnapshot: RecordingPerfSnapshot | null = null;

export function setLastRecordingPerfSnapshot(
  snapshot: RecordingPerfSnapshot,
): void {
  lastSnapshot = snapshot;
}

export function getLastRecordingPerfSnapshot(): RecordingPerfSnapshot | null {
  return lastSnapshot;
}

export function clearLastRecordingPerfSnapshotForTests(): void {
  lastSnapshot = null;
}
