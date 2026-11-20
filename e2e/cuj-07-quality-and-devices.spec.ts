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

    // 2. Test Studio Raw (320k) preset -> verifies raw mic DSP toggles flip OFF!
    await page.getByRole('button', { name: /Studio Raw \(320k\)/i }).click();
    await expect(page.getByTestId('quality-preset-badge')).toHaveText('Studio Raw (320k)');
    await expect(page.getByRole('switch', { name: 'Browser Noise Suppression' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: 'Browser Auto Gain Control' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: '80 Hz Rumble Filter' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Anti-Clip Safety Limiter' })).toHaveAttribute('aria-checked', 'true');

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
});
