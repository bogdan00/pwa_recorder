import type { ChannelCountOption } from '../types/models';
import { writeNyquistKeepalive } from './inputStrip';
import { PEAKS_PER_SECOND } from './pcmTimeline';

export interface PcmCaptureChunk {
  pcm: Float32Array;
  peaks: number[];
  liveLevel: number;
}

export interface PcmCaptureHandle {
  workletNode: AudioWorkletNode | null;
  workletOutputGain: GainNode | null;
  scriptNode: ScriptProcessorNode | null;
  scriptOutputGain: GainNode | null;
}

export interface AttachPcmCaptureOptions {
  channels: ChannelCountOption;
  isActive: () => boolean;
  isAborted?: () => boolean;
  onChunk: (chunk: PcmCaptureChunk) => void;
  computeFallbackPeaks?: boolean;
}

// Track per-AudioContext worklet module registration (calling addModule twice throws on Resume)
const loadedWorkletContexts = new WeakSet<AudioContext>();

function resolveWorkletUrl(): string {
  const base =
    (typeof import.meta !== 'undefined' &&
      import.meta.env &&
      import.meta.env.BASE_URL) ||
    '/';
  return `${base.endsWith('/') ? base : `${base}/`}audio/pcm-capture-worklet.js`;
}

/**
 * Attaches off-main-thread AudioWorklet PCM capture (with automatic ScriptProcessorNode fallback)
 * to `sourceNode`. Routes through a unity GainNode(1) -> ctx.destination so the inaudible
 * -100 dBFS ultrasonic Nyquist keepalive keeps iOS Safari WebKit pulling quanta and prevents
 * Chromium's 30-second SilentSinkSuspender from closing the hardware audio sink.
 */
export async function attachPcmCapture(
  ctx: AudioContext,
  sourceNode: AudioNode,
  options: AttachPcmCaptureOptions,
): Promise<PcmCaptureHandle> {
  const {
    channels,
    isActive,
    isAborted = () => false,
    onChunk,
    computeFallbackPeaks = false,
  } = options;

  // 1. Prefer off-main-thread AudioWorkletNode
  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      if (!loadedWorkletContexts.has(ctx)) {
        await ctx.audioWorklet.addModule(resolveWorkletUrl());
        loadedWorkletContexts.add(ctx);
      }

      if (isAborted()) {
        return {
          workletNode: null,
          workletOutputGain: null,
          scriptNode: null,
          scriptOutputGain: null,
        };
      }

      const node = new AudioWorkletNode(ctx, 'pcm-capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: channels,
        channelCountMode: 'explicit',
        processorOptions: { channels },
      });

      node.port.onmessage = (event) => {
        const msg = event.data;
        if (!msg || msg.type !== 'chunk' || !isActive()) return;
        const pcm =
          msg.pcm instanceof Float32Array ? msg.pcm : new Float32Array(msg.pcm);
        onChunk({
          pcm,
          peaks: Array.isArray(msg.peaks) ? msg.peaks : [],
          liveLevel: typeof msg.liveLevel === 'number' ? msg.liveLevel : 0,
        });
      };

      const outputGain = ctx.createGain();
      outputGain.gain.value = 1;

      sourceNode.connect(node);
      node.connect(outputGain);
      outputGain.connect(ctx.destination);

      return {
        workletNode: node,
        workletOutputGain: outputGain,
        scriptNode: null,
        scriptOutputGain: null,
      };
    } catch {
      // Fall through to ScriptProcessorNode fallback
    }
  }

  // 2. Fallback: ScriptProcessorNode with matching Nyquist keepalive
  if (isAborted() || typeof ctx.createScriptProcessor !== 'function') {
    return {
      workletNode: null,
      workletOutputGain: null,
      scriptNode: null,
      scriptOutputGain: null,
    };
  }

  try {
    const processor = ctx.createScriptProcessor(4096, channels, channels);
    const outputGain = ctx.createGain();
    outputGain.gain.value = 1;
    let keepaliveSign: 1 | -1 = 1;

    processor.onaudioprocess = (event) => {
      const active = isActive();
      if (event.outputBuffer && event.outputBuffer.numberOfChannels > 0) {
        const out0 = event.outputBuffer.getChannelData(0);
        if (active) {
          keepaliveSign = writeNyquistKeepalive(out0, keepaliveSign);
        } else {
          out0.fill(0);
        }
        for (let ch = 1; ch < event.outputBuffer.numberOfChannels; ch += 1) {
          event.outputBuffer.getChannelData(ch).fill(0);
        }
      }
      if (!active) return;

      const ch0 = event.inputBuffer.getChannelData(0);
      const ch1 =
        channels === 2
          ? event.inputBuffer.numberOfChannels > 1
            ? event.inputBuffer.getChannelData(1)
            : ch0
          : null;

      const frames = ch0.length;
      const interleaved = new Float32Array(frames * channels);
      let peak = 0;

      for (let i = 0; i < frames; i += 1) {
        const s0 = ch0[i];
        interleaved[i * channels] = s0;
        const a0 = Math.abs(s0);
        if (a0 > peak) peak = a0;
        if (channels === 2 && ch1) {
          const s1 = ch1[i];
          interleaved[i * channels + 1] = s1;
          const a1 = Math.abs(s1);
          if (a1 > peak) peak = a1;
        }
      }

      const peaks: number[] = [];
      if (computeFallbackPeaks) {
        const framesPerPeak = Math.max(
          1,
          Math.round(ctx.sampleRate / PEAKS_PER_SECOND),
        );
        for (let f = 0; f < frames; f += framesPerPeak) {
          let localMax = 0;
          const end = Math.min(frames, f + framesPerPeak);
          for (let j = f; j < end; j += 1) {
            const a = Math.abs(ch0[j]);
            if (a > localMax) localMax = a;
          }
          peaks.push(Math.min(1, localMax));
        }
      }

      onChunk({ pcm: interleaved, peaks, liveLevel: peak });
    };

    sourceNode.connect(processor);
    processor.connect(outputGain);
    outputGain.connect(ctx.destination);

    return {
      workletNode: null,
      workletOutputGain: null,
      scriptNode: processor,
      scriptOutputGain: outputGain,
    };
  } catch {
    return {
      workletNode: null,
      workletOutputGain: null,
      scriptNode: null,
      scriptOutputGain: null,
    };
  }
}

/**
 * Safely disconnects and detaches an AudioWorklet / ScriptProcessor PCM capture handle.
 */
export function teardownPcmCapture(handle: Partial<PcmCaptureHandle>): void {
  if (handle.workletNode) {
    try {
      handle.workletNode.port.onmessage = null;
      handle.workletNode.port.postMessage({ type: 'setActive', active: false });
      handle.workletNode.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }
  if (handle.workletOutputGain) {
    try {
      handle.workletOutputGain.disconnect();
    } catch {
      // Ignore
    }
  }
  if (handle.scriptNode) {
    try {
      handle.scriptNode.disconnect();
    } catch {
      // Ignore
    }
    handle.scriptNode.onaudioprocess = null;
  }
  if (handle.scriptOutputGain) {
    try {
      handle.scriptOutputGain.disconnect();
    } catch {
      // Ignore
    }
  }
}
