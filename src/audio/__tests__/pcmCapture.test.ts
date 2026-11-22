import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachPcmCapture, teardownPcmCapture } from '../pcmCapture';

describe('pcmCapture channelInterpretation (mono discrete vs stereo speakers)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('configures AudioWorkletNode with channelInterpretation="discrete" for mono and "speakers" for stereo', async () => {
    const capturedOptions: Array<AudioWorkletNodeOptions | undefined> = [];

    class MockAudioWorkletNode {
      port = { onmessage: null as ((ev: MessageEvent) => void) | null, postMessage: vi.fn() };
      connect = vi.fn();
      disconnect = vi.fn();
      constructor(_ctx: AudioContext, _name: string, options?: AudioWorkletNodeOptions) {
        capturedOptions.push(options);
      }
    }

    vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);

    const mockCtx = {
      sampleRate: 48000,
      destination: {},
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
    } as unknown as AudioContext;
    const mockSource = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;

    const monoHandle = await attachPcmCapture(mockCtx, mockSource, {
      channels: 1,
      isActive: () => true,
      onChunk: vi.fn(),
    });
    expect(capturedOptions[0]).toMatchObject({
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });
    teardownPcmCapture(monoHandle);

    const stereoHandle = await attachPcmCapture(mockCtx, mockSource, {
      channels: 2,
      isActive: () => true,
      onChunk: vi.fn(),
    });
    expect(capturedOptions[1]).toMatchObject({
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    teardownPcmCapture(stereoHandle);
  });

  it('configures ScriptProcessorNode fallback with channelInterpretation="discrete" for mono and "speakers" for stereo', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined);

    const createdProcessors: Array<{
      channelCount: number;
      channelCountMode: string;
      channelInterpretation: string;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      onaudioprocess: unknown;
    }> = [];

    const mockCtx = {
      sampleRate: 48000,
      destination: {},
      createScriptProcessor: vi.fn(() => {
        const proc = {
          channelCount: 2,
          channelCountMode: 'max',
          channelInterpretation: 'speakers',
          connect: vi.fn(),
          disconnect: vi.fn(),
          onaudioprocess: null,
        };
        createdProcessors.push(proc);
        return proc;
      }),
      createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
    } as unknown as AudioContext;
    const mockSource = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;

    const monoHandle = await attachPcmCapture(mockCtx, mockSource, {
      channels: 1,
      isActive: () => true,
      onChunk: vi.fn(),
    });
    expect(createdProcessors[0].channelCount).toBe(1);
    expect(createdProcessors[0].channelCountMode).toBe('explicit');
    expect(createdProcessors[0].channelInterpretation).toBe('discrete');
    teardownPcmCapture(monoHandle);

    const stereoHandle = await attachPcmCapture(mockCtx, mockSource, {
      channels: 2,
      isActive: () => true,
      onChunk: vi.fn(),
    });
    expect(createdProcessors[1].channelCount).toBe(2);
    expect(createdProcessors[1].channelCountMode).toBe('explicit');
    expect(createdProcessors[1].channelInterpretation).toBe('speakers');
    teardownPcmCapture(stereoHandle);
  });
});
