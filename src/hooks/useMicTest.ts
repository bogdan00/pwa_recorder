import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioDeviceSettings, AudioQualitySettings } from '../types/models';
import {
  type CapturedMicTestAudio,
  MicLevelTester,
  type MicTestTelemetry,
} from '../audio/audioDevices';

export interface UseMicTestOptions {
  device: AudioDeviceSettings;
  quality: AudioQualitySettings;
  onCaptured?: (capture: CapturedMicTestAudio) => void;
  onFallbackToast?: (message: string) => void;
  onStarted?: () => void;
}

export function useMicTest({
  device,
  quality,
  onCaptured,
  onFallbackToast,
  onStarted,
}: UseMicTestOptions) {
  const [isTesting, setIsTesting] = useState(false);
  const [telemetry, setTelemetry] = useState<MicTestTelemetry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const testerRef = useRef<MicLevelTester | null>(null);

  const onCapturedRef = useRef(onCaptured);
  onCapturedRef.current = onCaptured;

  const stop = useCallback((): CapturedMicTestAudio | null => {
    const tester = testerRef.current;
    testerRef.current = null;
    let captured: CapturedMicTestAudio | null = null;
    if (tester) {
      tester.stop();
      captured = tester.getCapturedAudio();
      if (captured) {
        onCapturedRef.current?.(captured);
      }
    }
    setIsTesting(false);
    setTelemetry(null);
    return captured;
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    const tester = new MicLevelTester();
    testerRef.current = tester;
    setIsTesting(true);
    try {
      const res = await tester.start(device, quality, setTelemetry);
      if (res.usedFallback && res.fallbackReason) {
        onFallbackToast?.(res.fallbackReason);
      }
      onStarted?.();
      return true;
    } catch (err) {
      stop();
      setError(
        err instanceof Error ? err.message : 'Unable to access microphone.',
      );
      return false;
    }
  }, [device, quality, onFallbackToast, onStarted, stop]);

  useEffect(() => {
    return () => {
      testerRef.current?.stop();
      testerRef.current = null;
    };
  }, []);

  return {
    isTesting,
    telemetry,
    error,
    setError,
    start,
    stop,
  };
}
