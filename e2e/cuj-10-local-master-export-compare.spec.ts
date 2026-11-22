import { expect, test } from './fixtures';
import { createBook, recordAndSaveChapter, waitForStudioTimer } from './helpers';

test.describe('CUJ-10: Local Lossless Master Archival, Multi-Bitrate Export & Quality Lab', () => {
  test('saves local 32-bit Float WAV master alongside chapter, runs blind threshold flow, exports multi-bitrate set, and reclaims master storage', async ({
    page,
  }) => {
    await page.goto('./');

    // 1. Enable "Save Local Lossless Master" in Studio Settings
    await page.locator('#open-settings-btn').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();

    const masterSwitch = page.getByRole('switch', {
      name: 'Save Local Lossless Master',
    });
    await expect(masterSwitch).toHaveAttribute('aria-checked', 'false');
    await masterSwitch.click();
    await expect(masterSwitch).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('Close settings').click();

    // 2. Create book & record a chapter — verify Save sheet reflects master switch
    await createBook(page, { title: 'Quality Benchmark Book' });
    await page.locator('#record-chapter-btn').click();
    await expect(page.getByTestId('recording-studio-view')).toBeVisible();

    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('REC');
    await waitForStudioTimer(page, (sec) => sec >= 0.6, 'studio timer >= 0.6s');

    await page.locator('#small-stop-btn').click();
    await expect(
      page.getByRole('switch', { name: 'Keep local lossless master' }),
    ).toHaveAttribute('aria-checked', 'true');

    await page.locator('#recording-name-input').fill('Master Take 1');
    await page.locator('#confirm-save-recording-btn').click();
    await expect(page.locator('#record-chapter-btn')).toBeVisible();

    // Verify Master badge renders on the chapter card
    await expect(page.getByTestId('recording-master-badge')).toBeVisible();

    // Verify IndexedDB recordingMasters holds a valid 32-bit IEEE Float WAV
    const masterHeader = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('storytape-db');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction('recordingMasters', 'readonly');
      const all = await new Promise<Array<{ buffer: ArrayBuffer; type: string }>>(
        (resolve, reject) => {
          const req = tx.objectStore('recordingMasters').getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        },
      );
      db.close();
      const first = all[0];
      const v = new DataView(first.buffer);
      const ascii = (o: number) =>
        String.fromCharCode(
          v.getUint8(o),
          v.getUint8(o + 1),
          v.getUint8(o + 2),
          v.getUint8(o + 3),
        );
      return {
        count: all.length,
        mime: first.type,
        riff: ascii(0),
        wave: ascii(8),
        formatTag: v.getUint16(20, true),
        bitDepth: v.getUint16(34, true),
        byteLength: first.buffer.byteLength,
      };
    });

    expect(masterHeader.count).toBe(1);
    expect(masterHeader.mime).toBe('audio/wav');
    expect(masterHeader.riff).toBe('RIFF');
    expect(masterHeader.wave).toBe('WAVE');
    expect(masterHeader.formatTag).toBe(3); // IEEE Float
    expect(masterHeader.bitDepth).toBe(32);
    expect(masterHeader.byteLength).toBeGreaterThan(44);

    // 3. Open Export & Quality Lab dedicated screen
    await page.getByLabel('More actions for Master Take 1').click();
    await page.getByRole('menuitem', { name: 'Export & Quality Lab' }).click();

    await expect(page.getByTestId('quality-lab-view')).toBeVisible();
    await expect(page.getByTestId('quality-lab-source-badge')).toHaveText(
      'Lossless Master',
    );

    // 4. Tab 1: Guided Blind A/B Threshold Finder
    const blindA = page.getByTestId('blind-play-a');
    const blindB = page.getByTestId('blind-play-b');
    await expect(blindA).toBeVisible();
    await expect(page.getByTestId('ql-progress-bar').locator('button')).toHaveCount(0);

    // Sample A toggles Play -> Pause -> Play, and switching to Sample B stops A and turns B into Pause
    await expect(blindA).toHaveAttribute('aria-pressed', 'false');
    await blindA.click();
    await expect(blindA).toHaveAttribute('aria-pressed', 'true');
    await expect(blindA).toHaveAttribute('aria-label', 'Pause Sample A');
    await expect(blindB).toHaveAttribute('aria-pressed', 'false');

    await blindA.click();
    await expect(blindA).toHaveAttribute('aria-pressed', 'false');

    await blindA.click();
    await expect(blindA).toHaveAttribute('aria-pressed', 'true');

    await blindB.click();
    await expect(blindA).toHaveAttribute('aria-pressed', 'false');
    await expect(blindA).toHaveAttribute('aria-label', 'Play Sample A');
    await expect(blindB).toHaveAttribute('aria-pressed', 'true');
    await expect(blindB).toHaveAttribute('aria-label', 'Pause Sample B');

    // Mark 64k as indistinguishable ("Can't tell") -> should reveal & recommend 64 kbps!
    await page.getByTestId('blind-vote-same').click();
    await expect(page.getByTestId('blind-reveal-box')).toBeVisible();
    await expect(page.getByTestId('threshold-recommendation-card')).toBeVisible();
    await expect(page.getByTestId('threshold-recommendation-card')).toContainText(
      '64 kbps',
    );

    // Apply recommended bitrate directly to Studio Settings
    await page.getByTestId('apply-recommended-quality-btn').click();

    // 5. Tab 2: Open Side-by-Side A/B Listen
    await page.getByTestId('ql-tab-ab').click();
    await expect(page.getByTestId('ql-panel-ab')).toBeVisible();
    await expect(page.getByTestId('ab-savings-badge')).toBeVisible();
    await expect(page.getByTestId('ql-progress-bar').locator('button')).toHaveCount(0);

    const abMaster = page.getByTestId('ab-play-master');
    const abExport = page.getByTestId('ab-play-export');
    await abMaster.click();
    await expect(abMaster).toHaveAttribute('aria-pressed', 'true');
    await expect(abMaster).toHaveAttribute('aria-label', 'Pause Master');

    await abExport.click();
    await expect(abMaster).toHaveAttribute('aria-pressed', 'false');
    await expect(abMaster).toHaveAttribute('aria-label', 'Play Master');
    await expect(abExport).toHaveAttribute('aria-pressed', 'true');

    await abExport.click();
    await expect(abExport).toHaveAttribute('aria-pressed', 'false');

    // 6. Tab 3: Export Files (Single + Batch Comparison Set)
    await page.getByTestId('ql-tab-export').click();
    await expect(page.getByTestId('ql-panel-export')).toBeVisible();

    await page.getByTestId('single-export-download-btn').click();
    await expect(page.getByTestId('single-export-result')).toBeVisible();

    await page.getByTestId('batch-encode-btn').click();
    await expect(page.getByTestId('batch-export-results')).toBeVisible();
    await expect(
      page.getByTestId('batch-export-results').locator('.ql-result-row'),
    ).toHaveCount(6);

    // 7. Reclaim local master storage right from Quality Lab topbar (Cancel keeps master, Confirm deletes)
    await page.getByTestId('delete-local-master-btn').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId('quality-lab-source-badge')).toHaveText(
      'Lossless Master',
    );

    await page.getByTestId('delete-local-master-btn').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('quality-lab-source-badge')).toHaveText(
      'Chapter Source',
    );

    // Navigate back to Book Detail -> Master badge gone, chapter still intact
    await page.getByRole('button', { name: 'Back to book' }).click();
    await expect(page.getByText('Master Take 1')).toBeVisible();
    await expect(page.getByTestId('recording-master-badge')).toHaveCount(0);

    // Verify recordingMasters store is now empty while recordingBlobs still has chapter
    const counts = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('storytape-db');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction(['recordingBlobs', 'recordingMasters'], 'readonly');
      const [blobs, masters] = await Promise.all([
        new Promise<number>((res, rej) => {
          const r = tx.objectStore('recordingBlobs').count();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        }),
        new Promise<number>((res, rej) => {
          const r = tx.objectStore('recordingMasters').count();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        }),
      ]);
      db.close();
      return { blobs, masters };
    });
    expect(counts.blobs).toBe(1);
    expect(counts.masters).toBe(0);
  });

  test('allows bulk deleting local masters from Studio Settings storage section', async ({
    page,
  }) => {
    await page.goto('./');
    await page.locator('#open-settings-btn').click();
    await page.getByRole('switch', { name: 'Save Local Lossless Master' }).click();
    await page.getByLabel('Close settings').click();

    await createBook(page, { title: 'Bulk Master Cleanup' });
    await recordAndSaveChapter(page, { name: 'Take A', minDurationSec: 0.5 });
    await expect(page.getByTestId('recording-master-badge')).toBeVisible();

    // Go back to Library -> Settings -> App -> Delete Local Masters (requires confirmation)
    await page.getByLabel('Back to library').click();
    await page.locator('#open-settings-btn').click();
    await page.getByTestId('settings-tab-app').click();
    const clearBtn = page.getByTestId('clear-local-masters-btn');
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(clearBtn).toHaveCount(0);
  });

  test('launches A/B Quality Lab directly from Settings Test Mic, runs blind threshold test, applies bitrate, and supports re-recording inside Quality Lab', async ({
    page,
  }) => {
    await page.goto('./');

    // 1. Open Studio Settings -> run Test Mic until a lossless clip is captured
    await page.locator('#open-settings-btn').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();

    await page.getByRole('button', { name: 'Test Mic' }).click();
    await expect(page.getByRole('button', { name: 'Stop Test' })).toBeVisible();
    await expect(page.locator('.mic-telemetry')).toContainText(/\d{2}:\d{2}/);

    await page.getByRole('button', { name: 'Stop Test' }).click();
    await expect(page.locator('.mic-telemetry')).toContainText(
      /Last test clip ready:/i,
    );

    // 2. Open A/B Quality Lab directly from Settings (no book/chapter needed)
    const openLabBtn = page.getByTestId('open-mic-quality-lab-btn');
    await expect(openLabBtn).toContainText(/Open in A\/B Lab/i);
    await openLabBtn.click();

    await expect(page.getByTestId('quality-lab-view')).toBeVisible();
    await expect(page.getByTestId('quality-lab-source')).toContainText(
      'Microphone Test Clip',
    );
    await expect(page.getByTestId('quality-lab-source-badge')).toHaveText(
      'Lossless Master',
    );

    // 3. Run blind A/B threshold test on the mic test clip and apply sweet spot
    await expect(page.getByTestId('blind-play-a')).toBeVisible();
    await page.getByTestId('blind-play-a').click();
    await page.getByTestId('blind-play-b').click();
    await page.getByTestId('blind-vote-same').click();
    await expect(page.getByTestId('threshold-recommendation-card')).toContainText(
      '64 kbps',
    );
    await page.getByTestId('apply-recommended-quality-btn').click();

    // 4. Re-record a fresh test clip right inside Quality Lab using Settings mic
    const recBtn = page.getByTestId('ql-mic-record-btn');
    await expect(recBtn).toContainText('Re-record Clip');
    await recBtn.click();
    await expect(recBtn).toContainText('Stop Recording');
    await expect(page.getByTestId('ql-mic-recorder')).toContainText(/00:0[1-9]/);
    await recBtn.click();
    await expect(page.getByTestId('blind-play-a')).toBeVisible();
  });
});
