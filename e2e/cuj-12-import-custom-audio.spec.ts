import { expect, test } from './fixtures';
import { createBook, createSilentWavBuffer } from './helpers';

test.describe('CUJ-12: Import Custom Audio Files into a Book', () => {
  test('opens history-backed sheet, validates mixed files, renames/reorders, imports, plays, downloads, and persists across reload', async ({
    page,
  }) => {
    await page.goto('./');
    await createBook(page, {
      title: 'The Wind in the Willows',
      author: 'Kenneth Grahame',
    });

    // 1. Open Import Audio sheet and verify browser Back dismisses it cleanly (ADR-12)
    await page.locator('#import-audio-btn').click();
    await expect(page.locator('#import-audio-sheet')).toBeVisible();

    await page.goBack();
    await expect(page.locator('#import-audio-sheet')).toBeHidden();
    await expect(
      page.getByRole('heading', { name: 'The Wind in the Willows' }),
    ).toBeVisible();

    // 2. Re-open and pick multiple valid audio files + 1 invalid non-audio file
    await page.locator('#import-audio-btn').click();
    await expect(page.locator('#import-audio-sheet')).toBeVisible();

    const wav1 = createSilentWavBuffer(4.0);
    const wav2 = createSilentWavBuffer(4.0);

    await page.locator('#import-audio-file-input').setInputFiles([
      {
        name: 'Chapter 10 - Homecoming.wav',
        mimeType: 'audio/wav',
        buffer: wav2,
      },
      {
        name: 'readme.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('not an audio file', 'utf8'),
      },
      {
        name: '01 - The_River_Bank.wav',
        mimeType: 'audio/wav',
        buffer: wav1,
      },
    ]);

    // Natural sort puts 01 - The_River_Bank before Chapter 10 - Homecoming; invalid file is flagged
    const riverInput = page.getByLabel(
      'Chapter title for 01 - The_River_Bank.wav',
    );
    const homeInput = page.getByLabel(
      'Chapter title for Chapter 10 - Homecoming.wav',
    );
    await expect(riverInput).toHaveValue('The River Bank');
    await expect(homeInput).toHaveValue('Chapter 10 - Homecoming');
    await expect(page.locator('#import-audio-sheet')).toContainText(
      /1 unsupported file skipped/i,
    );
    await expect(
      page.locator('#import-audio-sheet [role="alert"]'),
    ).toContainText(/unsupported file type/i);

    // Edit title, reorder queued chapters, and set narrator attribution
    await riverInput.fill('Prologue — The River Bank');
    await page.getByLabel('Move Chapter 10 - Homecoming up').click();
    await page.locator('#import-narrator-input').fill('Grandpa');

    // Submit import
    const confirmBtn = page.locator('#confirm-import-audio-btn');
    await expect(confirmBtn).toContainText('Import 2 Chapters');
    await confirmBtn.click();

    // Sheet closes and chapters appear in chosen order with narrator attribution
    await expect(page.locator('#import-audio-sheet')).toBeHidden();
    const titles = page.locator('.rec-card__title');
    await expect(titles).toHaveText([
      'Chapter 10 - Homecoming',
      'Prologue — The River Bank',
    ]);
    await expect(page.locator('.project-hero__credits')).toContainText(
      'Read by Grandpa',
    );

    // 3. Play imported chapter in the Audiobook Player without playback errors
    await page
      .getByRole('button', { name: /Play Chapter 10 - Homecoming/i })
      .click();
    const miniPlayer = page.getByTestId('mini-player-bar');
    await expect(miniPlayer).toBeVisible();
    await expect(miniPlayer).toContainText('Chapter 10 - Homecoming');
    await miniPlayer.getByLabel('Pause audiobook').click();

    // Expand full-screen player and confirm imported chapters play and switch cleanly
    await miniPlayer
      .getByLabel('Open player for Chapter 10 - Homecoming')
      .click();
    const playerSheet = page.getByTestId('audio-player-sheet');
    await expect(playerSheet).toBeVisible();
    await expect(playerSheet).toContainText('Chapter 1 of 2');
    await expect(playerSheet).toContainText('Read by Grandpa');
    await expect(playerSheet.locator('[role="alert"]')).toHaveCount(0);

    await page.getByLabel('Next chapter').click();
    await expect(playerSheet).toContainText('Chapter 2 of 2');
    await expect(playerSheet).toContainText('Prologue — The River Bank');
    await expect(playerSheet.locator('[role="alert"]')).toHaveCount(0);

    await page.getByLabel('Minimize player').click();
    await expect(playerSheet).toBeHidden();

    // 4. Download imported chapter preserves filename & original extension
    const downloadPromise = page.waitForEvent('download');
    await page
      .getByLabel('More actions for Chapter 10 - Homecoming')
      .click();
    await page.getByRole('menuitem', { name: 'Download Audio' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(
      '01 - Chapter 10 - Homecoming.wav',
    );

    // 5. Reload and verify chapters, titles, order, and narrator survive persistence
    await page.reload();
    await expect(page.locator('.rec-card__title')).toHaveText([
      'Chapter 10 - Homecoming',
      'Prologue — The River Bank',
    ]);
    await expect(page.locator('.project-hero__credits')).toContainText(
      'Read by Grandpa',
    );
  });

  test('uploads imported custom audio chapter to Google Drive with original extension and MIME type', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).google = {
        accounts: {
          oauth2: {
            initTokenClient: (cfg: {
              callback: (resp: {
                access_token: string;
                expires_in: number;
                scope: string;
              }) => void;
            }) => ({
              requestAccessToken: () => {
                cfg.callback({
                  access_token: 'e2e-import-drive-token',
                  expires_in: 3600,
                  scope: 'https://www.googleapis.com/auth/drive',
                });
              },
            }),
            revoke: () => {},
          },
        },
      };
    });

    await page.route('https://accounts.google.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: '// mocked GSI',
      }),
    );

    const uploadedFiles: Array<{ name: string; mimeType?: string }> = [];

    await page.route('https://www.googleapis.com/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();

      if (url.includes('/drive/v3/about')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              displayName: 'Import Parent',
              emailAddress: 'import-parent@example.com',
            },
          }),
        });
      }

      if (url.includes('uploadType=resumable')) {
        const body = JSON.parse(req.postData() || '{}') as {
          name?: string;
          mimeType?: string;
        };
        const name = body.name || 'file.bin';
        uploadedFiles.push({ name, mimeType: body.mimeType });
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
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'drive-meta-import',
            name: 'project.json',
            mimeType: 'application/json',
          }),
        });
      }

      if (url.includes('/drive/v3/files') && method === 'POST') {
        const body = JSON.parse(req.postData() || '{}') as { name?: string };
        const id =
          body.name === 'StoryTape Audiobooks'
            ? 'drive-root-import'
            : 'drive-book-import';
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

      if (url.includes('/drive/v3/files/drive-root-import?fields=')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'drive-root-import',
            name: 'StoryTape Audiobooks',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
            capabilities: { canAddChildren: true, canEdit: true },
          }),
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ files: [] }),
      });
    });

    await page.route('https://upload.example.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'drive-uploaded-import-1',
          name: '01 - Bedtime Tape.wav',
          mimeType: 'audio/wav',
        }),
      }),
    );

    await page.goto('./');

    // Connect Google Drive
    await page.locator('#open-settings-btn').click();
    await page.getByTestId('settings-tab-drive').click();
    await page.getByRole('button', { name: 'Connect Google Drive' }).click();
    await expect(page.getByText('import-parent@example.com')).toBeVisible();
    await page.getByLabel('Close settings').click();

    // Create book & import an existing WAV chapter
    await createBook(page, { title: 'Bedtime Archives' });
    await page.locator('#import-audio-btn').click();
    await expect(page.locator('#import-audio-sheet')).toBeVisible();

    await page.locator('#import-audio-file-input').setInputFiles({
      name: '01 - Bedtime_Tape.wav',
      mimeType: 'audio/wav',
      buffer: createSilentWavBuffer(1.0),
    });

    await expect(
      page.getByLabel('Chapter title for 01 - Bedtime_Tape.wav'),
    ).toHaveValue('Bedtime Tape');
    await page.locator('#confirm-import-audio-btn').click();

    await expect(page.locator('#import-audio-sheet')).toBeHidden();
    await expect(page.locator('.rec-card__title')).toHaveText(['Bedtime Tape']);

    // Verify automatic Drive sync uploaded the imported file with proper name & MIME
    await expect
      .poll(() =>
        uploadedFiles.some(
          (f) => f.name === '01 - Bedtime Tape.wav' && f.mimeType === 'audio/wav',
        ),
      )
      .toBe(true);
    await expect(
      page.getByLabel('Synced to Google Drive'),
    ).toBeVisible();
  });

  test('hides Import Audio button on read-only Listener shared books', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).google = {
        accounts: {
          oauth2: {
            initTokenClient: (cfg: {
              callback: (resp: {
                access_token: string;
                expires_in: number;
                scope: string;
              }) => void;
            }) => ({
              requestAccessToken: () => {
                cfg.callback({
                  access_token: 'e2e-reader-token',
                  expires_in: 3600,
                  scope: 'https://www.googleapis.com/auth/drive',
                });
              },
            }),
            revoke: () => {},
          },
        },
      };
    });

    await page.route('https://accounts.google.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: '// mocked GSI',
      }),
    );

    const roFolderId = 'ro-book-import-guard';
    const metaPayload = {
      schemaVersion: 1,
      id: 'book-ro-import-guard',
      title: 'Grandma’s Lullabies',
      author: 'Traditional',
      narrator: 'Grandma',
      dedicatedTo: '',
      description: '',
      language: '',
      tags: [],
      coverColor: '#3D6352',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      recordings: [
        {
          id: 'rec-ro-1',
          name: 'Twinkle Star',
          notes: '',
          recordedBy: 'Grandma',
          orderIndex: 0,
          durationMs: 1500,
          mimeType: 'audio/wav',
          extension: 'wav',
          sampleRate: 8000,
          channels: 1,
          fileSizeBytes: 24044,
          peaks: [0.3, 0.5, 0.4],
          driveFileId: 'ro-audio-1',
          driveFileName: '01 - Twinkle Star.wav',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      ],
    };

    await page.route('https://www.googleapis.com/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();
      if (url.includes('/drive/v3/about')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { displayName: 'Listener', emailAddress: 'listener@example.com' },
          }),
        });
      }
      if (url.includes('/drive/v3/files') && method === 'POST') {
        const body = JSON.parse(req.postData() || '{}') as { name?: string };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'drive-root-ro',
            name: body.name || 'StoryTape Audiobooks',
            mimeType: 'application/vnd.google-apps.folder',
          }),
        });
      }
      if (url.includes('/drive/v3/files/drive-root-ro?')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'drive-root-ro',
            name: 'StoryTape Audiobooks',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
            capabilities: { canAddChildren: true, canEdit: true },
          }),
        });
      }
      if (url.includes(`/drive/v3/files/${roFolderId}?`)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: roFolderId,
            name: 'Grandma’s Lullabies',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
            capabilities: { canAddChildren: false, canEdit: false },
          }),
        });
      }
      if (url.includes(roFolderId) && url.includes('in+parents')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: [
              { id: 'ro-meta-1', name: 'project.json', mimeType: 'application/json' },
              { id: 'ro-audio-1', name: '01 - Twinkle Star.wav', mimeType: 'audio/wav' },
            ],
          }),
        });
      }
      if (url.includes('/drive/v3/files/ro-meta-1?alt=media')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(metaPayload),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ files: [] }),
      });
    });

    await page.goto('./');

    await page.locator('#open-settings-btn').click();
    await page.getByTestId('settings-tab-drive').click();
    await page.getByRole('button', { name: 'Connect Google Drive' }).click();
    await expect(page.getByText('listener@example.com')).toBeVisible();

    await page
      .locator('#join-folder-input')
      .fill(
        `https://bogdan00.github.io/pwa_recorder/#/join?folderId=${roFolderId}&name=Grandma&scope=book&role=reader`,
      );
    await page.locator('#settings-join-folder-btn').click();
    await expect(page.getByTestId('settings-collab-box')).toContainText(
      'Grandma’s Lullabies',
    );
    await page.getByLabel('Close settings').click();

    await page.getByRole('button', { name: /Grandma’s Lullabies/i }).click();
    await expect(page.locator('.project-readonly-banner')).toContainText(
      'Listener mode',
    );
    await expect(page.locator('#record-chapter-btn')).toBeHidden();
    await expect(page.locator('#import-audio-btn')).toBeHidden();
    await expect(page.locator('#rescan-drive-btn')).toBeHidden();
  });

  test('rescans the book Google Drive folder to discover dropped audio files, updates project.json, hydrates metadata on play, and persists across reload', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).google = {
        accounts: {
          oauth2: {
            initTokenClient: (cfg: {
              callback: (resp: {
                access_token: string;
                expires_in: number;
                scope: string;
              }) => void;
            }) => ({
              requestAccessToken: () => {
                cfg.callback({
                  access_token: 'e2e-rescan-drive-token',
                  expires_in: 3600,
                  scope: 'https://www.googleapis.com/auth/drive',
                });
              },
            }),
            revoke: () => {},
          },
        },
      };
    });

    await page.route('https://accounts.google.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: '// mocked GSI',
      }),
    );

    const droppedWav1 = createSilentWavBuffer(3.0);
    const droppedWav2 = createSilentWavBuffer(3.0);
    let driveHasDroppedFiles = false;
    let savedManifestJson: string | null = null;
    let manifestUpdates = 0;
    let resumableUploadsAfterRescan = 0;

    await page.route('https://www.googleapis.com/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();

      if (url.includes('/drive/v3/about')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              displayName: 'Drive Parent',
              emailAddress: 'drive-parent@example.com',
            },
          }),
        });
      }

      if (url.includes('uploadType=resumable')) {
        if (driveHasDroppedFiles) resumableUploadsAfterRescan += 1;
        return route.fulfill({
          status: 200,
          headers: {
            Location: 'https://upload.example.com/session/rescan',
            'Access-Control-Expose-Headers': 'Location',
          },
          body: '',
        });
      }

      if (url.includes('uploadType=multipart')) {
        const raw = req.postData() || '';
        const boundary = raw.split('\r\n')[0].trim();
        const parts = raw
          .split(boundary)
          .map((p) => p.trim())
          .filter((p) => p && p !== '--');
        const payloadPart = parts[1] || '';
        const splitIdx = payloadPart.indexOf('\r\n\r\n');
        if (splitIdx >= 0) {
          savedManifestJson = payloadPart.slice(splitIdx + 4);
        }
        manifestUpdates += 1;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'rescan-meta-e2e',
            name: 'project.json',
            mimeType: 'application/json',
          }),
        });
      }

      if (url.includes('/drive/v3/files') && method === 'POST') {
        const body = JSON.parse(req.postData() || '{}') as { name?: string };
        const id =
          body.name === 'StoryTape Audiobooks'
            ? 'rescan-root-e2e'
            : 'rescan-book-e2e';
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id,
            name: body.name,
            mimeType: 'application/vnd.google-apps.folder',
            ownedByMe: true,
          }),
        });
      }

      if (url.includes('/drive/v3/files/rescan-root-e2e?')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'rescan-root-e2e',
            name: 'StoryTape Audiobooks',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
            ownedByMe: true,
            capabilities: { canAddChildren: true, canEdit: true },
          }),
        });
      }

      if (url.includes('/drive/v3/files/rescan-book-e2e?')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'rescan-book-e2e',
            name: 'Secret Garden',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
            ownedByMe: true,
            capabilities: { canAddChildren: true, canEdit: true },
          }),
        });
      }

      if (url.includes('rescan-book-e2e') && url.includes('in+parents')) {
        const baseFiles = savedManifestJson
          ? [{ id: 'rescan-meta-e2e', name: 'project.json', mimeType: 'application/json' }]
          : [];
        const droppedFiles = driveHasDroppedFiles
          ? [
              {
                id: 'dropped-audio-10',
                name: 'Chapter 10 - Epilogue.wav',
                mimeType: 'audio/wav',
                size: String(droppedWav2.byteLength),
              },
              {
                id: 'dropped-audio-2',
                name: '01 - Behind_the_Ivy.wav',
                mimeType: 'audio/wav',
                size: String(droppedWav1.byteLength),
              },
              {
                id: 'dropped-notes-txt',
                name: 'notes.txt',
                mimeType: 'text/plain',
                size: '16',
              },
            ]
          : [];
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: [...baseFiles, ...droppedFiles] }),
        });
      }

      if (url.includes('/drive/v3/files/rescan-meta-e2e?alt=media')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: savedManifestJson || '{}',
        });
      }

      if (url.includes('/drive/v3/files/dropped-audio-2?alt=media')) {
        return route.fulfill({
          status: 200,
          contentType: 'audio/wav',
          body: droppedWav1,
        });
      }

      if (url.includes('/drive/v3/files/dropped-audio-10?alt=media')) {
        return route.fulfill({
          status: 200,
          contentType: 'audio/wav',
          body: droppedWav2,
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ files: [] }),
      });
    });

    await page.goto('./');

    // Connect Google Drive
    await page.locator('#open-settings-btn').click();
    await page.getByTestId('settings-tab-drive').click();
    await page.getByRole('button', { name: 'Connect Google Drive' }).click();
    await expect(page.getByText('drive-parent@example.com')).toBeVisible();
    await page.getByLabel('Close settings').click();

    // Create book & wait for initial sync to establish its Drive folder
    await createBook(page, { title: 'Secret Garden' });
    await expect(page.locator('#sync-book-btn')).toContainText('Synced');
    const updatesBeforeRescan = manifestUpdates;

    // Simulate user dropping 2 WAV files + 1 non-audio file directly into the book's Drive folder
    driveHasDroppedFiles = true;

    // Tap Rescan in the Chapters header
    await page.locator('#rescan-drive-btn').click();

    // Newly discovered chapters appear in natural order (non-audio notes.txt ignored)
    const titles = page.locator('.rec-card__title');
    await expect(titles).toHaveText([
      'Behind the Ivy',
      'Chapter 10 - Epilogue',
    ]);
    expect(resumableUploadsAfterRescan).toBe(0);
    expect(manifestUpdates).toBeGreaterThan(updatesBeforeRescan);

    // Play the first Drive-discovered chapter -> downloads, hydrates duration (00:03), and plays cleanly
    await page
      .getByRole('button', { name: /Play Behind the Ivy/i })
      .click();
    const miniPlayer = page.getByTestId('mini-player-bar');
    await expect(miniPlayer).toBeVisible();
    await expect(miniPlayer).toContainText('Behind the Ivy');
    await miniPlayer.getByLabel('Pause audiobook').click();

    // Verify metadata hydrated in IndexedDB and survives reload
    await page.reload();
    await expect(page.locator('.rec-card__title')).toHaveText([
      'Behind the Ivy',
      'Chapter 10 - Epilogue',
    ]);
    await expect(page.locator('.rec-card').first()).toContainText('00:03');
  });
});
