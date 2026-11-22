import type { ChannelCountOption } from '../types/models';
import type { RecordingQualitySummary } from './recordingPerfTelemetry';
import {
  type QualityIngestMeta,
  type RecordingQualityReport,
} from './recordingQualityAnalyzer';
import type {
  QualityWorkerInboundMessage,
  QualityWorkerOutboundMessage,
} from './qualityMonitor.worker';

const BATCH_DURATION_SEC = 0.5; // Transfer ~500 ms batches (<= 2 postMessages/sec)

/**
 * Main-thread coordinator for the Dedicated Web Worker Recording Quality Monitor.
 *
 * - Batches incoming PCM chunks into ~500 ms transferable `Float32Array` buffers
 *   (`<= 2` zero-copy transfers/sec) so the main thread runs ZERO FFT or DSP heuristics.
 * - Receives `<= 1 Hz` `RecordingQualityReport` snapshots from the Worker.
 * - Cleanly terminates the Worker on `dispose()` so zero orphan threads leak.
 */
export class QualityMonitorClient {
  private worker: Worker | null = null;
  private sampleRate = 48000;
  private channels: ChannelCountOption = 1;
  private batchTargetSamples = 24000;
  private batchChunks: Float32Array[] = [];
  private batchSamples = 0;
  private batchMinCompReductionDb = 0;
  private batchTimestampGaps = 0;
  private latestReport: RecordingQualityReport | null = null;
  private listeners = new Set<(report: RecordingQualityReport | null) => void>();
  private disposed = false;

  subscribe(
    listener: (report: RecordingQualityReport | null) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.latestReport);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getLatestReport(): RecordingQualityReport | null {
    return this.latestReport;
  }

  getLatestSummary(): RecordingQualitySummary | null {
    const r = this.latestReport;
    if (!r) return null;
    return {
      overallStatus: r.status,
      analyzedSec: r.metrics.analyzedSec,
      speechSec: r.metrics.speechSec,
      totalClicks: r.metrics.totalClicks,
      totalDropouts: r.metrics.totalDropouts,
      saturatedFrameRatio: r.metrics.saturatedFrameRatio,
      speechRmsDb: r.metrics.speechRmsDb,
      noiseFloorDb: r.metrics.noiseFloorDb,
      snrDb: r.metrics.snrDb,
      clarityTiltDb: r.metrics.clarityTiltDb,
      triggeredCodes: r.checks
        .filter((c) => c.severity !== 'good')
        .map((c) => c.code),
    };
  }

  isWorkerActive(): boolean {
    return this.worker !== null;
  }

  private ensureWorker(): Worker | null {
    if (this.disposed) return null;
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null;

    try {
      const w = new Worker(
        new URL('./qualityMonitor.worker.ts', import.meta.url),
        { type: 'module' },
      );
      w.onmessage = (event: MessageEvent<QualityWorkerOutboundMessage>) => {
        if (this.disposed) return;
        const msg = event.data;
        if (msg?.type === 'report' && msg.report) {
          this.latestReport = msg.report;
          this.emit();
        }
      };
      w.onerror = () => {
        // Non-fatal: disable worker silently so recording is never disrupted
        this.terminateWorker();
      };
      this.worker = w;
      return w;
    } catch {
      return null;
    }
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn(this.latestReport));
  }

  startTake(sampleRate: number, channels: ChannelCountOption): void {
    this.sampleRate = Math.max(8000, Math.round(sampleRate || 48000));
    this.channels = channels === 2 ? 2 : 1;
    this.batchTargetSamples = Math.max(
      1024,
      Math.round(this.sampleRate * this.channels * BATCH_DURATION_SEC),
    );
    this.batchChunks = [];
    this.batchSamples = 0;
    this.batchMinCompReductionDb = 0;
    this.batchTimestampGaps = 0;

    const w = this.ensureWorker();
    if (w) {
      const msg: QualityWorkerInboundMessage = {
        type: 'reset',
        sampleRate: this.sampleRate,
        channels: this.channels,
      };
      w.postMessage(msg);
    }
  }

  pushChunk(interleaved: Float32Array, meta?: QualityIngestMeta): void {
    if (this.disposed || interleaved.length === 0) return;
    if (!this.worker && !this.ensureWorker()) return;

    this.batchChunks.push(interleaved);
    this.batchSamples += interleaved.length;
    if (
      meta &&
      typeof meta.compressorReductionDb === 'number' &&
      Number.isFinite(meta.compressorReductionDb) &&
      meta.compressorReductionDb < this.batchMinCompReductionDb
    ) {
      this.batchMinCompReductionDb = meta.compressorReductionDb;
    }
    if (
      meta &&
      typeof meta.timestampGapsDelta === 'number' &&
      meta.timestampGapsDelta > 0
    ) {
      this.batchTimestampGaps += meta.timestampGapsDelta;
    }

    if (this.batchSamples >= this.batchTargetSamples) {
      this.sendPendingBatch();
    }
  }

  flush(): void {
    if (this.disposed || !this.worker) return;
    this.sendPendingBatch();
    const msg: QualityWorkerInboundMessage = { type: 'flush' };
    this.worker.postMessage(msg);
  }

  reset(): void {
    this.batchChunks = [];
    this.batchSamples = 0;
    this.batchMinCompReductionDb = 0;
    this.batchTimestampGaps = 0;
    this.latestReport = null;
    this.emit();
  }

  private sendPendingBatch(): void {
    if (!this.worker || this.batchSamples === 0) return;
    const merged = new Float32Array(this.batchSamples);
    let offset = 0;
    for (let i = 0; i < this.batchChunks.length; i += 1) {
      const c = this.batchChunks[i];
      merged.set(c, offset);
      offset += c.length;
    }
    const meta: QualityIngestMeta = {
      compressorReductionDb: this.batchMinCompReductionDb,
      timestampGapsDelta: this.batchTimestampGaps,
    };
    this.batchChunks = [];
    this.batchSamples = 0;
    this.batchMinCompReductionDb = 0;
    this.batchTimestampGaps = 0;

    const msg: QualityWorkerInboundMessage = {
      type: 'chunk',
      pcmBuffer: merged.buffer,
      meta,
    };
    this.worker.postMessage(msg, [merged.buffer]);
  }

  private terminateWorker(): void {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Ignore
      }
      this.worker = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.batchChunks = [];
    this.batchSamples = 0;
    this.terminateWorker();
  }
}
