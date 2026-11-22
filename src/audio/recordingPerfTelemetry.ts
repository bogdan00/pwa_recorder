export interface RecordingPerfSnapshot {
  capturedAt: string;
  durationSec: number;
  sampleRate: number;
  channels: 1 | 2;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  captureMode: 'worklet' | 'scriptProcessor' | 'none';
  softwareAgcActive: boolean;
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
