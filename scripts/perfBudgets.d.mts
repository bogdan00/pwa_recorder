export interface PerfBudgets {
  minFps: number;
  maxP95FrameMs: number;
  maxSevereStalls: number;
  maxScriptMsPerSec: number;
  maxRecalcStylePerSec: number;
  maxLayoutPerSec: number;
  minWindowChunks: number;
  maxChunkIntervalMs: number;
  minRecordedSec: number;
}

export interface PerfProfileConfig {
  name: string;
  cpuThrottle: number;
  measureSeconds: number;
  checkBlackoutPause: boolean;
  budgets: PerfBudgets;
}

export interface BlackoutPauseSummary {
  canvasRenderDelta: number;
  chunkDelta: number;
}

export interface PerfProfileSummary {
  name?: string;
  cpuThrottle?: number;
  fps: number;
  p50FrameMs?: number;
  p95FrameMs: number;
  maxFrameMs?: number;
  severeStalls: number;
  scriptMsPerSec: number;
  taskMsPerSec?: number;
  recalcStylePerSec: number;
  layoutPerSec: number;
  workletLoaded: number;
  scriptProcessorCreated: number;
  loopingAudioPlayCalls: number;
  windowChunks: number;
  meanChunkIntervalMs: number;
  maxChunkIntervalMs: number;
  canvasPixelWidth: number;
  canvasClientWidth: number;
  recordedDurationSec: number;
  zeroRuns: number;
  maxAbs: number;
  blackoutResult?: BlackoutPauseSummary | null;
}

export interface PerfEvaluationMeta {
  pageErrors?: string[];
  consoleErrors?: string[];
  unexpectedExternalUrls?: string[];
  workletErrors?: string[];
  maxZeroRun?: number;
}

export interface RegressionCanarySummary {
  passed: boolean;
  caughtCount: number;
  recalcStylePerSec: number;
  loopingAudioPlayCalls: number;
}

export interface ScorecardRow {
  guard: string;
  measured: string;
  budget: string;
  ok: boolean;
}

export declare const PERF_PROFILES: readonly PerfProfileConfig[];

export declare function evaluateProfileResults(
  summary: PerfProfileSummary,
  budgets: PerfBudgets,
  meta?: PerfEvaluationMeta,
): string[];

export declare function buildScorecardRows(
  fast: PerfProfileSummary,
  slow: PerfProfileSummary,
  canary?: RegressionCanarySummary | null,
): ScorecardRow[];

export declare function formatScorecardText(rows: ScorecardRow[]): string;
export declare function formatScorecardMarkdown(rows: ScorecardRow[]): string;
