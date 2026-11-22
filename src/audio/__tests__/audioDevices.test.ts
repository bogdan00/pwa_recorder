import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUDIO_QUALITY } from '../../storage/settings';
import {
  acquireMicStream,
  detectNativeAgcActive,
  listAudioInputDevices,
  requestMicPermissionAndList,
} from '../audioDevices';

function createFakeStream(label: string, deviceId: string, sampleRate = 48000): MediaStream {
  const stop = vi.fn();
  const track = {
    label,
    stop,
    getSettings: () => ({ deviceId, sampleRate, channelCount: 1 }),
  };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

describe('audioDevices', () => {
  const originalMediaDevices = navigator.mediaDevices;

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it('detects multiple audio input devices and permission state', async () => {
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: 'audiooutput', deviceId: 'spk1', label: 'Speaker', groupId: 'g0' },
      { kind: 'audioinput', deviceId: 'default', label: '', groupId: 'g1' },
      { kind: 'audioinput', deviceId: 'usb-mic', label: '', groupId: 'g2' },
    ]);

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices },
    });

    const beforePerm = await listAudioInputDevices();
    expect(beforePerm.permissionGranted).toBe(false);
    expect(beforePerm.devices).toHaveLength(2);

    // After unlocking permission, labels appear
    const getUserMedia = vi.fn().mockResolvedValue(createFakeStream('USB Mic', 'usb-mic'));
    enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'default', label: 'Default - iPhone Mic', groupId: 'g1' },
      { kind: 'audioinput', deviceId: 'usb-mic', label: 'Shure MV7 USB', groupId: 'g2' },
    ]);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices, getUserMedia },
    });

    const afterPerm = await requestMicPermissionAndList();
    expect(afterPerm.permissionGranted).toBe(true);
    expect(afterPerm.devices[1].label).toBe('Shure MV7 USB');
  });

  it('falls back gracefully to System Default if saved external mic was unplugged', async () => {
    const notFoundErr = new Error('Device not found');
    notFoundErr.name = 'OverconstrainedError';

    const fallbackStream = createFakeStream('Built-in Microphone', 'default', 48000);
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(notFoundErr)
      .mockResolvedValueOnce(fallbackStream);

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });

    const acquired = await acquireMicStream(
      { deviceId: 'usb-removed', deviceLabel: 'Shure MV7 USB' },
      {
        ...DEFAULT_AUDIO_QUALITY,
        noiseSuppression: false,
        autoGainControl: false,
        echoCancellation: false,
      },
    );

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(acquired.usedFallback).toBe(true);
    expect(acquired.fallbackReason).toContain('Shure MV7 USB');
    expect(acquired.actualDeviceLabel).toBe('Built-in Microphone');
    expect(acquired.nativeAgcActive).toBe(false);
    expect(acquired.trackSettings).toEqual(
      expect.objectContaining({ sampleRate: 48000, channelCount: 1 }),
    );
    expect(acquired.trackSettings).not.toHaveProperty('deviceId');
    expect(acquired.trackSettings).not.toHaveProperty('groupId');
    // Verify raw DSP settings were passed to constraints
    const firstCallArgs = getUserMedia.mock.calls[0][0];
    expect(firstCallArgs.audio.deviceId).toEqual({ exact: 'usb-removed' });
    expect(firstCallArgs.audio.noiseSuppression).toBe(false);
    expect(firstCallArgs.audio.autoGainControl).toBe(false);
    expect(firstCallArgs.audio.echoCancellation).toBe(false);
  });

  it('detects missing native AGC on iOS Safari RemoteIO while avoiding double-AGC on Android Chrome and iOS VPIO', () => {
    // 1. iOS Safari default (echoCancellation=false, autoGainControl unsupported) -> needs software AGC!
    expect(
      detectNativeAgcActive(
        { autoGainControl: true, echoCancellation: false },
        { echoCancellation: false, sampleRate: 48000 },
        { echoCancellation: true },
      ),
    ).toBe(false);

    // 2. iOS Safari with echoCancellation=true (Apple VoiceProcessingIO already runs hardware AGC)
    expect(
      detectNativeAgcActive(
        { autoGainControl: true, echoCancellation: true },
        { echoCancellation: true, sampleRate: 48000 },
        { echoCancellation: true },
      ),
    ).toBe(true);

    // 3. Android Chrome default (autoGainControl supported and active even with echoCancellation=false)
    expect(
      detectNativeAgcActive(
        { autoGainControl: true, echoCancellation: false },
        { autoGainControl: true, echoCancellation: false },
        { autoGainControl: true, echoCancellation: true },
      ),
    ).toBe(true);

    // 4. Hardware/driver explicitly failed to enable AGC despite request -> engage software AGC
    expect(
      detectNativeAgcActive(
        { autoGainControl: true, echoCancellation: false },
        { autoGainControl: false, echoCancellation: false },
        { autoGainControl: true, echoCancellation: true },
      ),
    ).toBe(false);

    // 5. Studio Raw / user disabled AGC -> returns false
    expect(
      detectNativeAgcActive(
        { autoGainControl: false, echoCancellation: false },
        { autoGainControl: false, echoCancellation: false },
        { autoGainControl: true, echoCancellation: true },
      ),
    ).toBe(false);
  });
});
