import { expect, test } from './fixtures';
import { createBook, recordAndSaveChapter } from './helpers';

test.describe('CUJ-07: Studio Audio Quality (Presets, Bitrate, Sample Rate, WAV Export) & Microphone Selection', () => {
  test('selects from multiple microphones, runs live mic tester, configures high-ceiling quality, and records valid 24-bit stereo WAV', async ({
    page,
  }) => {
    // Expose two realistic microphones to test multi-device selector while keeping real getUserMedia
    await page.addInitScript(() => {
      const originalEnum = navigator.mediaDevices?.enumerateDevices?.bind(
        navigator.mediaDevices,
      );
      if (navigator.mediaDevices) {
        navigator.mediaDevices.enumerateDevices = async () => {
          const base = originalEnum ? await originalEnum() : [];
          return [
            ...base.filter((d) => d.kind !== 'audioinput'),
            {
              deviceId: 'default',
              kind: 'audioinput',
              label: 'Built-in Phone Mic',
              groupId: 'g-default',
              toJSON: () => ({}),
            } as MediaDeviceInfo,
            {
              deviceId: 'usb-condenser-1',
              kind: 'audioinput',
              label: 'Shure MV7 USB Studio',
              groupId: 'g-usb',
              toJSON: () => ({}),
            } as MediaDeviceInfo,
          ];
        };
      }
    });

    await page.goto('./');

    // 1. Open Settings -> pick USB microphone & run live Mic Test
    await page.locator('#open-settings-btn').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();

    const usbMicRadio = page.getByRole('radio', { name: 'Shure MV7 USB Studio' });
    await expect(usbMicRadio).toBeVisible();
    await usbMicRadio.click();
    await expect(usbMicRadio).toHaveAttribute('aria-checked', 'true');

    // Run live Mic Test and wait reactively for live dB + hardware channel telemetry
    await page.getByRole('button', { name: 'Test Mic' }).click();
    await expect(page.getByRole('button', { name: 'Stop Test' })).toBeVisible();
    await expect(page.locator('.mic-telemetry')).toContainText(/-?\d+\s*dB/);
    await expect(page.locator('.mic-telemetry')).toContainText(/\d+\s*ch/);
    await page.getByRole('button', { name: 'Stop Test' }).click();
    await expect(page.getByRole('button', { name: 'Test Mic' })).toBeVisible();

    // 2. Test Studio Raw (320k) preset -> verifies live summary + collapsed Advanced Audio summary, then expands Advanced Audio to verify raw mic DSP toggles flip OFF!
    await expect(page.getByTestId('advanced-audio-panel')).toHaveCount(0);
    await page.getByRole('button', { name: /Studio Raw \(320k\)/i }).click();
    await expect(page.getByTestId('quality-preset-badge')).toHaveText('Studio Raw (320k)');
    await expect(page.getByTestId('advanced-audio-summary')).toContainText('320k');

    await page.getByTestId('advanced-audio-toggle').click();
    await expect(page.getByTestId('advanced-audio-panel')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Browser Noise Suppression' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: 'Browser Auto Gain Control' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: '80 Hz Rumble Filter' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Anti-Clip Safety Limiter' })).toHaveAttribute('aria-checked', 'true');

    // Verify tap-to-expand ? helper tooltips explain Mono vs Stereo and Bitrate
    await page.getByTestId('help-btn-channels').click();
    await expect(page.getByTestId('help-panel-channels')).toContainText(/Mono vs\. Stereo/i);
    await expect(page.getByTestId('help-panel-channels')).toContainText(/half the file size/i);
    await page.getByTestId('help-btn-channels').click();
    await expect(page.getByTestId('help-panel-channels')).toHaveCount(0);

    await page.getByTestId('help-btn-bitrate').click();
    await expect(page.getByTestId('help-panel-bitrate')).toContainText(/96k–128k/i);
    await page.getByLabel('Close Bitrate help').click();
    await expect(page.getByTestId('help-panel-bitrate')).toHaveCount(0);

    // 3. Customize to 510 kbps CBR + 96 kHz + Stereo -> preset flips to Custom & live estimator updates
    await page.getByRole('button', { name: '510k' }).click();
    await page.getByRole('button', { name: 'CBR (Constant)' }).click();
    await page.getByRole('button', { name: '96 kHz' }).click();
    await page.getByRole('button', { name: 'Stereo (2 ch · External Mic)' }).click();
    await expect(page.getByTestId('quality-preset-badge')).toHaveText('Custom');
    await expect(page.getByTestId('quality-summary-card')).toContainText('510k');
    await expect(page.getByTestId('quality-summary-card')).toContainText('Stereo');
    await expect(page.getByTestId('quality-summary-card')).toContainText('CBR');

    // 4. Switch to WAV (Lossless), 48 kHz, 24-bit PCM, Stereo and verify persistence across reload
    await page.getByRole('button', { name: 'WAV (Lossless)' }).click();
    await page.getByRole('button', { name: '48 kHz', exact: true }).click();
    await page.getByRole('button', { name: '24-bit PCM' }).click();
    await expect(page.getByTestId('quality-summary-card')).toContainText('24-bit WAV');
    await page.getByLabel('Close settings').click();

    await page.reload();
    await createBook(page, { title: 'Studio Master Test' });

    // 5. Record real audio and verify saved 24-bit Stereo WAV bytes inside IndexedDB!
    await recordAndSaveChapter(page, { name: 'Archival Chapter', minDurationSec: 0.7 });
    await expect(page.locator('.rec-card__meta')).toContainText('WAV · 48 kHz · 24-bit');
    await expect(page.locator('.rec-card__meta')).toContainText('Stereo');

    const wavHeader = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('storytape-db');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction('recordingBlobs', 'readonly');
      const all = await new Promise<Array<{ buffer: ArrayBuffer; type: string }>>((resolve, reject) => {
        const req = tx.objectStore('recordingBlobs').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      const first = all[0];
      const v = new DataView(first.buffer);
      const ascii = (o: number) =>
        String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
      return {
        mime: first.type,
        riff: ascii(0),
        wave: ascii(8),
        formatTag: v.getUint16(20, true),
        channels: v.getUint16(22, true),
        sampleRate: v.getUint32(24, true),
        bitDepth: v.getUint16(34, true),
        byteLength: first.buffer.byteLength,
      };
    });

    expect(wavHeader.mime).toBe('audio/wav');
    expect(wavHeader.riff).toBe('RIFF');
    expect(wavHeader.wave).toBe('WAVE');
    expect(wavHeader.formatTag).toBe(1);
    expect(wavHeader.channels).toBe(2);
    expect(wavHeader.sampleRate).toBe(48000);
    expect(wavHeader.bitDepth).toBe(24);
    expect(wavHeader.byteLength).toBeGreaterThan(44);
  });

  test('activates studio software auto-gain when browser lacks native autoGainControl (iOS Safari) and supports +24 dB manual gain boost', async ({
    page,
  }) => {
    // Simulate iOS Safari / WebKit: getSupportedConstraints() omits autoGainControl & noiseSuppression,
    // and track.getSettings() reports echoCancellation: false without autoGainControl.
    await page.addInitScript(() => {
      if (!navigator.mediaDevices) return;
      navigator.mediaDevices.getSupportedConstraints = () => ({
        deviceId: true,
        echoCancellation: true,
        sampleRate: true,
        channelCount: true,
      });
      const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await origGetUserMedia(constraints);
        for (const track of stream.getAudioTracks()) {
          const origGetSettings = track.getSettings.bind(track);
          track.getSettings = () => {
            const s = { ...origGetSettings() };
            delete (s as Record<string, unknown>).autoGainControl;
            delete (s as Record<string, unknown>).noiseSuppression;
            s.echoCancellation = false;
            return s;
          };
        }
        return stream;
      };
    });

    await page.goto('./');
    await page.locator('#open-settings-btn').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();

    // 1. Live Test Mic on simulated iOS Safari engages automatic studio auto-gain fallback
    await page.getByRole('button', { name: 'Test Mic' }).click();
    await expect(page.getByRole('button', { name: 'Stop Test' })).toBeVisible();
    await expect(page.locator('.mic-telemetry')).toContainText(/-?\d+\s*dB/);
    await expect(page.locator('.mic-telemetry')).toContainText(/Auto\s*[+-]?\d+\s*dB/);
    await page.getByRole('button', { name: 'Stop Test' }).click();
    await expect(page.getByRole('button', { name: 'Test Mic' })).toBeVisible();

    // 2. Manual Input Gain Boost slider, animated guide, logarithmic explainer & clickable quick-stop ticks
    await page.getByTestId('advanced-audio-toggle').click();
    await expect(page.getByTestId('gain-guide-card')).toBeVisible();
    await expect(page.getByTestId('gain-log-explainer')).toContainText(/logarithmic scale/i);
    await expect(page.getByTestId('gain-log-explainer')).toContainText(/\+6 dB doubles/i);
    await expect(page.getByTestId('gain-guidance-text')).toContainText(/Natural level/i);

    const gainSlider = page.locator('#input-gain-slider');
    await expect(gainSlider).toHaveAttribute('min', '-6');
    await expect(gainSlider).toHaveAttribute('max', '24');

    // Tapping quick-stop tick (-6 dB) softens level; tapping +18 dB (8x) boosts heavily
    await page.getByRole('button', { name: /Set input gain to -6 dB/i }).click();
    await expect(page.getByTestId('gain-guidance-text')).toContainText(/Softer/i);

    await page.getByRole('button', { name: /Set input gain to \+18 dB/i }).click();
    await expect(page.getByTestId('input-gain-readout')).toContainText(/\+18\.0 dB/);
    await expect(page.getByTestId('gain-guidance-text')).toContainText(/Heavy boost/i);
    await expect(page.getByTestId('quality-preset-badge')).toHaveText('Custom');

    // Verify neither "Input Gain Boost" + (?) nor "7.94× (+18.0 dB)" / "15.85× (+24.0 dB)" + Reset wraps onto 2 rows
    const assertSingleLineGainLayout = async () => {
      const metrics = await page.evaluate(() => {
        const countLines = (el: Element): number => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const rects = Array.from(range.getClientRects()).filter(
            (r) => r.width > 0.5 && r.height > 0.5,
          );
          const ys: number[] = [];
          for (const r of rects) {
            if (!ys.some((y) => Math.abs(y - r.top) < 3)) ys.push(r.top);
          }
          return ys.length;
        };

        const label = document.querySelector('label[for="input-gain-slider"]');
        const helpBtn = document.querySelector('[data-testid="help-btn-input-gain"]');
        const readout = document.querySelector('[data-testid="input-gain-readout"]');
        const resetBtn = document.querySelector('.gain-reset-btn');
        if (!label || !helpBtn || !readout || !resetBtn) return null;

        const labelRect = label.getBoundingClientRect();
        const helpRect = helpBtn.getBoundingClientRect();
        const readoutRect = readout.getBoundingClientRect();
        const resetRect = resetBtn.getBoundingClientRect();

        return {
          labelLines: countLines(label),
          readoutLines: countLines(readout),
          labelHelpMidDiff: Math.abs(
            labelRect.top + labelRect.height / 2 - (helpRect.top + helpRect.height / 2),
          ),
          readoutResetMidDiff: Math.abs(
            readoutRect.top + readoutRect.height / 2 - (resetRect.top + resetRect.height / 2),
          ),
          readoutResetGap: resetRect.left - readoutRect.right,
        };
      });

      expect(metrics).not.toBeNull();
      expect(metrics!.labelLines).toBe(1);
      expect(metrics!.readoutLines).toBe(1);
      expect(metrics!.labelHelpMidDiff).toBeLessThanOrEqual(4);
      expect(metrics!.readoutResetMidDiff).toBeLessThanOrEqual(4);
      expect(metrics!.readoutResetGap).toBeGreaterThanOrEqual(4);
    };

    await assertSingleLineGainLayout();

    // Also verify widest possible readout (+24.0 dB -> 15.85× (+24.0 dB)) stays single-line, then restore +18 dB
    await page.getByRole('button', { name: /Set input gain to \+24 dB/i }).click();
    await expect(page.getByTestId('input-gain-readout')).toContainText(/\+24\.0 dB/);
    await assertSingleLineGainLayout();
    await page.getByRole('button', { name: /Set input gain to \+18 dB/i }).click();
    await expect(page.getByTestId('input-gain-readout')).toContainText(/\+18\.0 dB/);

    await page.getByLabel('Close settings').click();
    await page.reload();

    await page.locator('#open-settings-btn').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();
    await expect(page.getByTestId('advanced-audio-summary')).toContainText(/\+18\.0 dB/);
    await page.getByTestId('advanced-audio-toggle').click();
    await expect(page.getByTestId('input-gain-readout')).toContainText(/\+18\.0 dB/);
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByTestId('input-gain-readout')).toHaveText('1.00× (0.0 dB)');
    await expect(page.getByTestId('gain-guidance-text')).toContainText(/Natural level/i);
  });

  test('preserves full unity gain on mono discrete extraction from asymmetric (L, 0) stereo hardware mic buffers', async ({
    page,
  }) => {
    await page.goto('./');
    const result = await page.evaluate(async () => {
      const renderPeak = async (interpretation: ChannelInterpretation): Promise<number> => {
        const ctx = new OfflineAudioContext(1, 2400, 48000);
        const buf = ctx.createBuffer(2, 2400, 48000);
        const left = buf.getChannelData(0);
        const right = buf.getChannelData(1);
        for (let i = 0; i < 2400; i += 1) {
          left[i] = 0.8766 * Math.sin((2 * Math.PI * 440 * i) / 48000);
          right[i] = 0; // iOS Safari / mono-in-stereo (L, 0) hardware buffer
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;

        const gain = ctx.createGain();
        gain.channelCount = 1;
        gain.channelCountMode = 'explicit';
        gain.channelInterpretation = interpretation;

        src.connect(gain);
        gain.connect(ctx.destination);
        src.start(0);
        const rendered = await ctx.startRendering();
        const ch0 = rendered.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < ch0.length; i += 1) {
          const a = Math.abs(ch0[i]);
          if (a > peak) peak = a;
        }
        return peak;
      };

      return {
        speakersPeak: await renderPeak('speakers'),
        discretePeak: await renderPeak('discrete'),
      };
    });

    // Proves Web Audio 'speakers' halves (L, 0) to ~0.4383 (-6 dB), whereas StoryTape's 'discrete' preserves ~0.8766 (0 dB)!
    expect(result.speakersPeak).toBeCloseTo(0.4383, 2);
    expect(result.discretePeak).toBeCloseTo(0.8766, 2);
  });
});
