import {
  ArrayBufferTarget as Mp4ArrayBufferTarget,
  Muxer as Mp4Muxer,
} from 'mp4-muxer';
import { encodeWav } from '../src/audio/wavEncoder';
import { expect, test } from './fixtures';
import { createBook, recordAndSaveChapter } from './helpers';

const WEBKIT_BUG_302253_ESDS_48K_MONO = new Uint8Array([
  3, 128, 128, 128, 34, 0, 0, 0, 4, 128, 128, 128, 20, 64, 20, 0, 24, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 5, 128, 128, 128, 2, 17, 136, 6, 128, 128, 128, 1, 2,
]);

function buildLegacyCorruptedIosM4aBytes(): number[] {
  const target = new Mp4ArrayBufferTarget();
  const muxer = new Mp4Muxer({
    target,
    audio: { codec: 'aac', numberOfChannels: 1, sampleRate: 48000 },
    fastStart: 'in-memory',
  });
  const frame = new Uint8Array([0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23]);
  muxer.addAudioChunkRaw(frame, 'key', 0, 21333, {
    decoderConfig: {
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 1,
      description: WEBKIT_BUG_302253_ESDS_48K_MONO,
    },
  });
  muxer.finalize();
  return Array.from(new Uint8Array(target.buffer));
}

test.describe('CUJ-05: Minimalistic Audiobook Player, Mini-Player, Speed, Sleep Timer & Continue Listening', () => {
  test('plays chapters via mini-player & full-screen sheet, switches chapters, changes speed & sleep timer, and restores Continue Listening after reload', async ({
    page,
  }) => {
    await page.goto('./');
    await page.locator('#open-settings-btn').click();
    await page.getByTestId('settings-tab-app').click();
    await page.locator('#default-narrator-input').fill('Dad');
    await page.getByLabel('Close settings').click();

    await createBook(page, {
      title: 'The Gruffalo',
      author: 'Julia Donaldson',
    });

    await recordAndSaveChapter(page, { name: 'Into the Deep Dark Wood', minDurationSec: 1.8 });
    await recordAndSaveChapter(page, { name: 'The Owl & The Snake', minDurationSec: 0.8 });

    // 1. Tap Chapter 1 to play -> floating MiniPlayerBar appears
    await page
      .getByRole('button', { name: /Play Into the Deep Dark Wood/i })
      .click();
    const miniPlayer = page.getByTestId('mini-player-bar');
    await expect(miniPlayer).toBeVisible();
    await expect(miniPlayer).toContainText('Into the Deep Dark Wood');
    await expect(miniPlayer).toContainText('The Gruffalo');
    // Pause so short 1s test recording doesn't auto-advance before we inspect Chapter 1 controls
    await miniPlayer.getByLabel('Pause audiobook').click();

    // 2. Navigate back to Library -> MiniPlayerBar persists seamlessly while browsing
    await page.getByLabel('Back to library').click();
    await expect(miniPlayer).toBeVisible();

    // 3. Expand full-screen Minimalistic Audiobook Player sheet
    await miniPlayer.getByLabel('Open player for Into the Deep Dark Wood').click();
    const sheet = page.getByTestId('audio-player-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Chapter 1 of 2');
    await expect(sheet).toContainText('Read by Dad');

    // 4. Advance to Next Chapter via transport button
    await page.getByLabel('Next chapter').click();
    await expect(sheet).toContainText('Chapter 2 of 2');
    await expect(sheet).toContainText('The Owl & The Snake');

    // 5. Open Chapters quick-drawer and jump back to Chapter 1
    await page.getByRole('button', { name: 'Chapters', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Chapters' })).toBeVisible();
    await page.getByRole('button', { name: /01\. Into the Deep Dark Wood/i }).click();
    await expect(sheet).toContainText('Chapter 1 of 2');

    // 6. Cycle playback speed (1× -> 1.15× -> 1.25×)
    const speedBtn = page.getByLabel(/Playback speed/i);
    await expect(speedBtn).toHaveText('1×');
    await speedBtn.click();
    await expect(speedBtn).toHaveText('1.15×');
    await speedBtn.click();
    await expect(speedBtn).toHaveText('1.25×');

    // 7. Activate Bedtime Sleep Timer (End of current chapter)
    await page.getByLabel('Sleep timer').click();
    await expect(page.getByRole('region', { name: 'Sleep Timer' })).toBeVisible();
    await page.getByRole('button', { name: 'End of current chapter' }).click();
    await expect(page.getByLabel('Sleep timer')).toContainText('End of Ch.');

    // 8. Minimize player & reload -> Continue Listening card appears in Library
    await page.getByLabel('Minimize player').click();
    await expect(sheet).toBeHidden();
    await expect(miniPlayer).toBeVisible();

    await page.getByLabel('Close player').click();
    await expect(miniPlayer).toBeHidden();

    await page.reload();
    const continueCard = page.getByTestId('continue-listening-card');
    await expect(continueCard).toBeVisible();
    await expect(continueCard).toContainText('The Gruffalo');
    await expect(continueCard).toContainText('Into the Deep Dark Wood');

    // Tapping Play on Continue Listening opens the minimalistic player directly
    await page.getByLabel('Continue listening to The Gruffalo').click();
    await expect(page.getByTestId('audio-player-sheet')).toBeVisible();
  });

  test('auto-repairs legacy double-wrapped iOS 26 M4A esds blobs and recovers from Safari 32-bit Float WAV NotSupportedError', async ({
    page,
  }) => {
    const corruptedM4aBytes = buildLegacyCorruptedIosM4aBytes();
    const floatWavBlob = encodeWav([new Float32Array(24000 * 5).fill(0.05)], 24000, 32);
    const floatWavBytes = Array.from(new Uint8Array(await floatWavBlob.arrayBuffer()));

    await page.goto('./');
    await expect(page.locator('#open-settings-btn')).toBeVisible();

    // Seed a book with two Safari-hostile legacy chapters in IndexedDB:
    // 1) Legacy iOS 26 double-wrapped M4A stored with generic application/octet-stream MIME
    // 2) 32-bit IEEE Float WAV stored with application/octet-stream MIME
    await page.evaluate(
      async ({ m4aBytes, wavBytes }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('storytape-db');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const now = Date.now();
        const tx = db.transaction(['projects', 'recordings', 'recordingBlobs'], 'readwrite');
        tx.objectStore('projects').put({
          id: 'book-ios-heal',
          title: 'Mica sirenă',
          author: 'Hans Christian Andersen',
          narrator: 'Claudia',
          notes: '',
          coverColor: '#1f2937',
          createdAt: now,
          updatedAt: now,
        });
        tx.objectStore('recordings').put({
          id: 'rec-ios-m4a',
          projectId: 'book-ios-heal',
          name: 'Chapter 1 (Legacy iOS M4A)',
          orderIndex: 0,
          durationMs: 43000,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sizeBytes: m4aBytes.length,
          sampleRate: 48000,
          bitrateKbps: 128,
          channels: 1,
          waveformPeaks: [0.1, 0.2, 0.15, 0.25],
          recordedBy: 'Claudia',
          createdAt: now,
          updatedAt: now,
          syncStatus: 'local_only',
        });
        tx.objectStore('recordings').put({
          id: 'rec-float32-wav',
          projectId: 'book-ios-heal',
          name: 'Chapter 2 (32-bit Float WAV)',
          orderIndex: 1,
          durationMs: 1000,
          mimeType: 'audio/wav',
          extension: 'wav',
          sizeBytes: wavBytes.length,
          sampleRate: 24000,
          bitDepth: 32,
          channels: 1,
          waveformPeaks: [0.2, 0.4, 0.3, 0.5],
          recordedBy: 'Claudia',
          createdAt: now + 1,
          updatedAt: now + 1,
          syncStatus: 'local_only',
        });
        tx.objectStore('recordingBlobs').put(
          { buffer: new Uint8Array(m4aBytes).buffer, type: 'application/octet-stream' },
          'rec-ios-m4a',
        );
        tx.objectStore('recordingBlobs').put(
          { buffer: new Uint8Array(wavBytes).buffer, type: 'application/octet-stream' },
          'rec-float32-wav',
        );
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      },
      { m4aBytes: corruptedM4aBytes, wavBytes: floatWavBytes },
    );

    await page.reload();
    await page.getByTestId('book-card-book-ios-heal').click();

    // 1. Tap legacy double-wrapped M4A -> PlayerContext repairs `esds` and persists
    // the repaired audio/mp4 blob back to IndexedDB (with `free` padding box & exact size).
    await page
      .getByRole('button', { name: /Play Chapter 1 \(Legacy iOS M4A\)/i })
      .click();

    await expect
      .poll(async () => {
        return page.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('storytape-db');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const record = await new Promise<{ buffer: ArrayBuffer; type: string } | undefined>(
            (resolve, reject) => {
              const tx = db.transaction('recordingBlobs', 'readonly');
              const req = tx.objectStore('recordingBlobs').get('rec-ios-m4a');
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            },
          );
          db.close();
          if (!record) return null;
          const bytes = Array.from(new Uint8Array(record.buffer));
          const ascii = String.fromCharCode(...bytes);
          return {
            type: record.type,
            size: bytes.length,
            hasFreePaddingBox: ascii.includes('free'),
          };
        });
      })
      .toEqual({
        type: 'audio/mp4',
        size: corruptedM4aBytes.length,
        hasFreePaddingBox: true,
      });

    // 2. Simulate iOS Safari rejecting 32-bit Float WAV once with NotSupportedError,
    // then verify PlayerContext transparently transcodes to 16-bit PCM WAV and plays with zero error!
    await page.evaluate(() => {
      const origPlay = HTMLMediaElement.prototype.play;
      let rejectedFloatOnce = false;
      HTMLMediaElement.prototype.play = function playWithIosFloat32Rejection(
        this: HTMLMediaElement,
      ) {
        if (!rejectedFloatOnce && this.src.startsWith('blob:')) {
          rejectedFloatOnce = true;
          return Promise.reject(
            new DOMException('The operation is not supported.', 'NotSupportedError'),
          );
        }
        return origPlay.call(this);
      };
    });

    await page
      .getByRole('button', { name: /Play Chapter 2 \(32-bit Float WAV\)/i })
      .click();

    const miniPlayer = page.getByTestId('mini-player-bar');
    await expect(miniPlayer).toBeVisible();
    await expect(miniPlayer).toContainText('Chapter 2 (32-bit Float WAV)');
    await miniPlayer.getByLabel('Open player for Chapter 2 (32-bit Float WAV)').click();

    const sheet = page.getByTestId('audio-player-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('alert')).toHaveCount(0);
    await expect(sheet).not.toContainText('The operation is not supported.');
    await expect(sheet.getByLabel('Pause')).toBeVisible();
  });

  test('dismisses Continue Listening card persistently and auto-clears progress when the final chapter completes', async ({
    page,
  }) => {
    const longWavBlob = encodeWav([new Float32Array(24000 * 6).fill(0.02)], 24000, 16);
    const shortWavBlob = encodeWav([new Float32Array(24000 * 0.4).fill(0.02)], 24000, 16);
    const longWavBytes = Array.from(new Uint8Array(await longWavBlob.arrayBuffer()));
    const shortWavBytes = Array.from(new Uint8Array(await shortWavBlob.arrayBuffer()));

    await page.goto('./');
    await expect(page.locator('#open-settings-btn')).toBeVisible();

    await page.evaluate(
      async ({ longBytes, shortBytes }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('storytape-db');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const now = Date.now();
        const tx = db.transaction(
          ['projects', 'recordings', 'recordingBlobs', 'playbackProgress'],
          'readwrite',
        );
        tx.objectStore('projects').put({
          id: 'book-dismiss',
          title: 'Goodnight Moon',
          author: 'Margaret Wise Brown',
          narrator: 'Mom',
          dedicatedTo: '',
          description: '',
          language: 'English',
          tags: [],
          coverColor: '#365847',
          hasCover: false,
          syncStatus: 'local_only',
          createdAt: now,
          updatedAt: now,
        });
        tx.objectStore('recordings').put({
          id: 'rec-dismiss-1',
          projectId: 'book-dismiss',
          name: 'In the Great Green Room',
          notes: '',
          orderIndex: 0,
          durationMs: 6000,
          mimeType: 'audio/wav',
          extension: 'wav',
          sampleRate: 24000,
          bitrateKbps: 384,
          channels: 1,
          fileSizeBytes: longBytes.length,
          peaks: [0.2, 0.4, 0.3, 0.5],
          recordedBy: 'Mom',
          syncStatus: 'local_only',
          createdAt: now,
          updatedAt: now,
        });
        tx.objectStore('recordingBlobs').put(
          { buffer: new Uint8Array(longBytes).buffer, type: 'audio/wav' },
          'rec-dismiss-1',
        );

        tx.objectStore('projects').put({
          id: 'book-finish',
          title: 'Very Short Tale',
          author: 'StoryTeller',
          narrator: 'Dad',
          dedicatedTo: '',
          description: '',
          language: 'English',
          tags: [],
          coverColor: '#6D4337',
          hasCover: false,
          syncStatus: 'local_only',
          createdAt: now - 1000,
          updatedAt: now - 1000,
        });
        tx.objectStore('recordings').put({
          id: 'rec-finish-1',
          projectId: 'book-finish',
          name: 'The Final Page',
          notes: '',
          orderIndex: 0,
          durationMs: 400,
          mimeType: 'audio/wav',
          extension: 'wav',
          sampleRate: 24000,
          bitrateKbps: 384,
          channels: 1,
          fileSizeBytes: shortBytes.length,
          peaks: [0.3, 0.5, 0.2],
          recordedBy: 'Dad',
          syncStatus: 'local_only',
          createdAt: now - 1000,
          updatedAt: now - 1000,
        });
        tx.objectStore('recordingBlobs').put(
          { buffer: new Uint8Array(shortBytes).buffer, type: 'audio/wav' },
          'rec-finish-1',
        );

        tx.objectStore('playbackProgress').put({
          projectId: 'book-dismiss',
          recordingId: 'rec-dismiss-1',
          positionSec: 1.5,
          durationSec: 6,
          completedRecordingIds: [],
          updatedAt: now,
        });

        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      },
      { longBytes: longWavBytes, shortBytes: shortWavBytes },
    );

    await page.reload();

    // 1. Continue Listening appears for Goodnight Moon; start playing, minimize, then dismiss via X
    const continueCard = page.getByTestId('continue-listening-card');
    await expect(continueCard).toBeVisible();
    await expect(continueCard).toContainText('Goodnight Moon');

    await page.getByLabel('Continue listening to Goodnight Moon').click();
    await expect(page.getByTestId('audio-player-sheet')).toBeVisible();
    await page.getByLabel('Minimize player').click();
    const miniPlayer = page.getByTestId('mini-player-bar');
    await expect(miniPlayer).toBeVisible();

    await page.getByTestId('dismiss-continue-listening-btn').click();
    await expect(continueCard).toBeHidden();
    await expect(miniPlayer).toBeHidden();

    // Reload to confirm the dismissal persisted in IndexedDB
    await page.reload();
    await expect(page.getByTestId('book-card-book-dismiss')).toBeVisible();
    await expect(continueCard).toHaveCount(0);

    // 2. Play the single-chapter book ("Very Short Tale") to natural completion ->
    // Continue Listening auto-clears once the final chapter finishes
    await page.getByTestId('book-card-book-finish').click();
    await page.getByRole('button', { name: /Play The Final Page/i }).click();
    await expect(miniPlayer).toBeVisible();
    // Wait reactively until the short 0.4s chapter finishes playing and switches to Play button
    await expect(miniPlayer.getByLabel('Play audiobook')).toBeVisible();

    await page.getByLabel('Back to library').click();
    await expect(page.getByTestId('book-card-book-finish')).toBeVisible();
    await expect(continueCard).toHaveCount(0);

    // Reload to confirm playbackProgress was deleted in IndexedDB
    await page.reload();
    await expect(page.getByTestId('book-card-book-finish')).toBeVisible();
    await expect(continueCard).toHaveCount(0);
  });
});
