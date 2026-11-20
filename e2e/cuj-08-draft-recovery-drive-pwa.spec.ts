import { expect, test } from './fixtures';
import {
  createBook,
  createSilentWavBuffer,
  createTinyPngBuffer,
  recordAndSaveChapter,
  waitForStudioTimer,
} from './helpers';

test.describe('CUJ-08: Draft Recovery, Google Drive Two-Way Sync & Subpath PWA Integrity', () => {
  test('recovers an unfinished draft after leaving studio and reloading the page', async ({
    page,
  }) => {
    await page.goto('./');
    await createBook(page, { title: 'The Snowman' });

    // Record until live timer advances AND the automatic crash-safe draft chunk flushes to IndexedDB
    await page.locator('#record-chapter-btn').click();
    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('REC');
    await waitForStudioTimer(
      page,
      (sec) => sec >= 1.6,
      'recording should advance past 1.6s before checking draft flush',
    );
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open('storytape-db');
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            const tx = db.transaction('draftChunks', 'readonly');
            return new Promise<number>((resolve, reject) => {
              const req = tx.objectStore('draftChunks').count();
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
          }),
        { message: 'automatic crash-safe draft chunk should flush to IndexedDB' },
      )
      .toBeGreaterThanOrEqual(1);

    // Tap Back -> Keep Draft & Leave
    await page.getByLabel('Leave recording studio').click();
    await expect(page.getByText('Unsaved Recording')).toBeVisible();
    await page.getByRole('button', { name: 'Keep Draft & Leave' }).click();

    // Return to Library and hard reload to prove IndexedDB crash recovery
    await page.getByLabel('Back to library').click();
    await page.reload();

    const banner = page.getByLabel('Unfinished recording draft');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('The Snowman');

    // Tapping Discard prompts for confirmation; Cancel keeps the draft intact
    await banner.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await expect(page.getByTestId('confirm-dialog')).toContainText('The Snowman');
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(banner).toBeVisible();

    // Resume draft -> opens studio in PAUSED state with recovered duration!
    await banner.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByTestId('recording-studio-view')).toBeVisible();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');
    await waitForStudioTimer(
      page,
      (sec) => sec > 1.5,
      'recovered draft should restore > 1.5s of audio',
    );

    // Stop & save the recovered draft cleanly
    await page.locator('#small-stop-btn').click();
    await page.locator('#recording-name-input').fill('Recovered Chapter 1');
    await page.locator('#confirm-save-recording-btn').click();
    await expect(
      page.locator('.rec-card__title', { hasText: 'Recovered Chapter 1' }),
    ).toBeVisible();

    // Draft banner should be gone now
    await page.getByLabel('Back to library').click();
    await expect(page.getByLabel('Unfinished recording draft')).toBeHidden();
  });

  test('connects Google Drive via OAuth, pushes book + cover + resumable audio, pulls remote cloud_only book, plays on demand, and frees synced cache', async ({
    page,
  }) => {
    // Provide mocked Google Identity Services token client before app script runs
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).google = {
        accounts: {
          oauth2: {
            initTokenClient: (cfg: {
              callback: (resp: { access_token: string; expires_in: number }) => void;
            }) => ({
              requestAccessToken: () => {
                cfg.callback({ access_token: 'e2e-drive-token', expires_in: 3600 });
              },
            }),
            revoke: () => {},
          },
        },
      };
    });

    // Prevent the real Google Identity Services script (index.html) from loading over
    // the network and overwriting our mocked window.google token client in CI / online runs.
    await page.route('https://accounts.google.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: '// mocked GSI in E2E',
      }),
    );

    const remoteWav = createSilentWavBuffer(2);
    const uploadedNames: string[] = [];

    // Intercept Google Drive REST v3 API calls
    await page.route('https://www.googleapis.com/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();

      if (url.includes('/drive/v3/about')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { displayName: 'Story Parent', emailAddress: 'parent@example.com' },
          }),
        });
      }

      if (url.includes('uploadType=resumable')) {
        const body = JSON.parse(req.postData() || '{}') as { name?: string };
        const name = body.name || 'file.bin';
        uploadedNames.push(name);
        return route.fulfill({
          status: 200,
          headers: {
            Location: `https://upload.example.com/session/${encodeURIComponent(name)}`,
            'Access-Control-Expose-Headers': 'Location',
          },
          body: '',
        });
      }

      if (url.includes('uploadType=multipart')) {
        uploadedNames.push('project.json');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'drive-meta-local',
            name: 'project.json',
            mimeType: 'application/json',
          }),
        });
      }

      if (url.includes('/drive/v3/files') && method === 'POST') {
        const body = JSON.parse(req.postData() || '{}') as { name?: string };
        const id =
          body.name === 'StoryTape Audiobooks' ? 'drive-root-1' : 'drive-book-local';
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id,
            name: body.name,
            mimeType: 'application/vnd.google-apps.folder',
          }),
        });
      }

      if (url.includes('/drive/v3/files/drive-root-1?fields=')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'drive-root-1',
            name: 'StoryTape Audiobooks',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
          }),
        });
      }

      if (url.includes('drive-root-1') && url.includes('in+parents')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: [
              {
                id: 'drive-remote-folder',
                name: 'Room on the Broom',
                mimeType: 'application/vnd.google-apps.folder',
              },
            ],
          }),
        });
      }

      if (url.includes('drive-remote-folder') && url.includes('in+parents')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: [
              { id: 'remote-meta-1', name: 'project.json', mimeType: 'application/json' },
              { id: 'remote-audio-1', name: '01 - The Witch’s Cat.wav', mimeType: 'audio/wav' },
            ],
          }),
        });
      }

      if (url.includes('/drive/v3/files/remote-meta-1?alt=media')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            schemaVersion: 1,
            id: 'book-remote-1',
            title: 'Room on the Broom',
            author: 'Julia Donaldson',
            narrator: 'Mom',
            dedicatedTo: 'Emma',
            description: 'Synced from another device.',
            language: 'English',
            tags: ['Synced'],
            coverColor: '#683B54',
            createdAt: 1000,
            updatedAt: 5000,
            recordings: [
              {
                id: 'rec-remote-1',
                name: 'The Witch’s Cat',
                notes: '',
                orderIndex: 0,
                durationMs: 2000,
                mimeType: 'audio/wav',
                extension: 'wav',
                sampleRate: 8000,
                bitDepth: 16,
                channels: 1,
                fileSizeBytes: remoteWav.byteLength,
                peaks: [0.3, 0.7, 0.5],
                driveFileId: 'remote-audio-1',
                driveFileName: '01 - The Witch’s Cat.wav',
                createdAt: 1000,
                updatedAt: 5000,
              },
            ],
          }),
        });
      }

      if (url.includes('/drive/v3/files/remote-audio-1?alt=media')) {
        return route.fulfill({
          status: 200,
          contentType: 'audio/wav',
          body: remoteWav,
        });
      }

      const verifyMatch = url.match(/\/drive\/v3\/files\/([^/?]+)\?fields=/);
      if (method === 'GET' && verifyMatch) {
        const id = decodeURIComponent(verifyMatch[1]);
        const nameMap: Record<string, string> = {
          'drive-root-1': 'StoryTape Audiobooks',
          'drive-book-local': 'Local Bedtime Book',
          'drive-remote-folder': 'Room on the Broom',
        };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id,
            name: nameMap[id] || id,
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
            ownedByMe: true,
            capabilities: { canEdit: true, canAddChildren: true, canShare: true },
          }),
        });
      }

      // Default folder lookup -> empty so app creates folders cleanly
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ files: [] }),
      });
    });

    await page.route('https://upload.example.com/**', async (route) => {
      const fileName = decodeURIComponent(route.request().url().split('/').pop() || 'file');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: fileName === 'cover.jpg' ? 'drive-cover-1' : 'drive-audio-local-1',
          name: fileName,
          mimeType: 'application/octet-stream',
        }),
      });
    });

    await page.goto('./');
    await createBook(page, {
      title: 'Local Bedtime Book',
      coverFile: {
        name: 'cover.png',
        mimeType: 'image/png',
        buffer: createTinyPngBuffer(),
      },
    });
    await recordAndSaveChapter(page, { name: 'Chapter One', minDurationSec: 0.6 });

    // Open Settings -> verify GCP Client ID & setup guide are not shown -> Connect Drive directly
    await page.getByLabel('Back to library').click();
    await page.locator('#open-settings-btn').click();
    await expect(page.locator('#drive-client-id-input')).toHaveCount(0);
    await expect(page.getByText(/Google Cloud Console/i)).toHaveCount(0);
    await page.getByRole('button', { name: 'Connect Google Drive' }).click();

    // Verify signed in & sync completes
    await expect(page.getByText('parent@example.com')).toBeVisible();
    await expect(page.getByText('Google Drive is up to date.')).toBeVisible();
    expect(uploadedNames).toContain('cover.jpg');
    expect(uploadedNames).toContain('project.json');
    expect(uploadedNames.some((n) => n.startsWith('01 - Chapter One.'))).toBe(true);

    // Free local cached audio for synced chapters (requires confirmation)
    await page
      .getByRole('button', { name: 'Free Cached Audio for Synced Chapters' })
      .click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByText(/Freed local audio cache for 1 synced chapter/i)).toBeVisible();

    await page.getByLabel('Close settings').click();

    // Verify pulled remote cloud_only book appears in Library & plays on demand from Drive!
    await expect(page.getByLabel('Audiobook library')).toContainText('Room on the Broom');
    await page.getByRole('button', { name: /Room on the Broom/i }).click();
    await page.getByRole('button', { name: /Play The Witch’s Cat/i }).click();
    await expect(page.getByTestId('mini-player-bar')).toBeVisible();
    await expect(page.getByTestId('mini-player-bar')).toContainText('The Witch’s Cat');
  });

  test('serves valid /pwa_recorder/ PWA manifest, icons, AudioWorklet, privacy.html, terms.html, and shows deploy version in Settings', async ({
    page,
    request,
  }) => {
    const manifestRes = await request.get('manifest.webmanifest');
    expect(manifestRes.status()).toBe(200);
    const manifest = (await manifestRes.json()) as {
      start_url: string;
      scope: string;
      id: string;
      display: string;
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
    };
    expect(manifest.start_url).toBe('/pwa_recorder/');
    expect(manifest.scope).toBe('/pwa_recorder/');
    expect(manifest.id).toBe('/pwa_recorder/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);

    const workletRes = await request.get('audio/pcm-capture-worklet.js');
    expect(workletRes.status()).toBe(200);
    expect(await workletRes.text()).toContain('pcm-capture-processor');

    const appleIconRes = await request.get('icons/apple-touch-icon.png');
    expect(appleIconRes.status()).toBe(200);

    const privacyRes = await request.get('privacy.html');
    expect(privacyRes.status()).toBe(200);

    const termsRes = await request.get('terms.html');
    expect(termsRes.status()).toBe(200);

    // Verify in-app deploy version (YYYY_MM_DD_HH_MM) is displayed in Studio Settings
    await page.goto('./');
    await page.locator('#open-settings-btn').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();
    const versionEl = page.getByTestId('app-version-value');
    await expect(versionEl).toBeVisible();
    await expect(versionEl).toHaveText(/^\d{4}_\d{2}_\d{2}_\d{2}_\d{2}$/);
  });

  test('prompts Chromium users to install via beforeinstallprompt, persists banner dismissal, and allows installing from Settings', async ({
    page,
  }) => {
    await page.goto('./');
    await expect(page.getByRole('heading', { name: 'StoryTape' })).toBeVisible();

    // Hidden before browser signals installability
    await expect(page.getByTestId('install-app-banner')).toHaveCount(0);

    // Simulate Chromium firing beforeinstallprompt
    await page.evaluate(() => {
      const ev = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
      };
      (window as unknown as { __installPromptCalls: number }).__installPromptCalls = 0;
      ev.prompt = async () => {
        (window as unknown as { __installPromptCalls: number }).__installPromptCalls += 1;
      };
      ev.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
      window.dispatchEvent(ev);
    });

    // Library banner appears with Install CTA
    const banner = page.getByTestId('install-app-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Install StoryTape');
    await expect(page.locator('#install-app-btn')).toHaveText(/Install/);

    // Dismissing hides banner and persists across reload
    await page.locator('#dismiss-install-banner-btn').click();
    await expect(banner).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'StoryTape' })).toBeVisible();

    // Re-fire beforeinstallprompt after reload — banner stays dismissed, Settings still offers Install App
    await page.evaluate(() => {
      const ev = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
      };
      (window as unknown as { __installPromptCalls: number }).__installPromptCalls = 0;
      ev.prompt = async () => {
        (window as unknown as { __installPromptCalls: number }).__installPromptCalls += 1;
      };
      ev.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
      window.dispatchEvent(ev);
    });

    await expect(page.getByTestId('install-app-banner')).toHaveCount(0);

    await page.locator('#open-settings-btn').click();
    const settingsCard = page.getByTestId('settings-install-card');
    await expect(settingsCard).toBeVisible();
    await expect(page.locator('#settings-install-app-btn')).toHaveText(/Install App/);

    // Trigger install from Settings -> invokes native prompt(), shows toast, marks Installed
    await page.locator('#settings-install-app-btn').click();
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __installPromptCalls: number }).__installPromptCalls,
        ),
      )
      .toBe(1);
    await expect(page.getByText('StoryTape installed to your Home Screen!')).toBeVisible();
    await expect(settingsCard).toContainText('Installed');
    await expect(page.locator('#settings-install-app-btn')).toHaveCount(0);
  });

  test('shows iOS Safari Add to Home Screen guide and hides install banner when running standalone', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, 'userAgent', {
        configurable: true,
        get: () =>
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      });
      Object.defineProperty(window.navigator, 'platform', {
        configurable: true,
        get: () => 'iPhone',
      });
      Object.defineProperty(window.navigator, 'standalone', {
        configurable: true,
        get: () => window.sessionStorage.getItem('__e2e_standalone') === '1',
      });
    });

    await page.goto('./');
    await expect(page.getByRole('heading', { name: 'StoryTape' })).toBeVisible();

    const banner = page.getByTestId('install-app-banner');
    await expect(banner).toBeVisible();
    await expect(page.locator('#install-app-btn')).toHaveText(/How to Install/);

    // Tap How to Install -> opens guided 2-step modal
    await page.locator('#install-app-btn').click();
    const guideModal = page.getByTestId('ios-install-guide-modal');
    await expect(guideModal).toBeVisible();
    await expect(guideModal).toContainText('1. Tap the Share button');
    await expect(guideModal).toContainText('Add to Home Screen');

    await guideModal.getByRole('button', { name: 'Got It' }).click();
    await expect(guideModal).toHaveCount(0);

    // When launched in standalone mode, banner stays hidden and Settings shows Installed
    await page.evaluate(() => {
      window.sessionStorage.setItem('__e2e_standalone', '1');
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'StoryTape' })).toBeVisible();
    await expect(page.getByTestId('install-app-banner')).toHaveCount(0);

    await page.locator('#open-settings-btn').click();
    await expect(page.getByTestId('settings-install-card')).toContainText('Installed');
  });
});
