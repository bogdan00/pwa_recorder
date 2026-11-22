import type { ChannelCountOption } from '../types/models';
import {
  RecordingQualityAnalyzer,
  type QualityIngestMeta,
  type RecordingQualityReport,
} from './recordingQualityAnalyzer';

export type QualityWorkerInboundMessage =
  | {
      type: 'reset';
      sampleRate: number;
      channels: ChannelCountOption;
    }
  | {
      type: 'chunk';
      pcmBuffer: ArrayBuffer;
      meta?: QualityIngestMeta;
    }
  | {
      type: 'flush';
    };

export type QualityWorkerOutboundMessage = {
  type: 'report';
  report: RecordingQualityReport;
};

const REPORT_INTERVAL_MS = 1000; // Strict <= 1 Hz UI update cadence
const analyzer = new RecordingQualityAnalyzer();
let lastEmitMs = 0;

function postReport(force: boolean): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!force && lastEmitMs > 0 && now - lastEmitMs < REPORT_INTERVAL_MS) {
    return;
  }
  lastEmitMs = now;
  const msg: QualityWorkerOutboundMessage = {
    type: 'report',
    report: analyzer.getReport(),
  };
  self.postMessage(msg);
}

self.onmessage = (event: MessageEvent<QualityWorkerInboundMessage>) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'reset') {
    analyzer.reset(msg.sampleRate, msg.channels);
    lastEmitMs = 0;
    postReport(true);
    return;
  }
  if (msg.type === 'chunk') {
    const pcm = new Float32Array(msg.pcmBuffer);
    analyzer.ingest(pcm, msg.meta);
    postReport(false);
    return;
  }
  if (msg.type === 'flush') {
    postReport(true);
  }
};
