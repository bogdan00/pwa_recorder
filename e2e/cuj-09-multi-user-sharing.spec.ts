import { expect, test, type Page } from './fixtures';
import {
  createBook,
  createSilentWavBuffer,
  recordAndSaveChapter,
} from './helpers';

interface MockDriveState {
  driveFiles: Map<
    string,
    {
      id: string;
      name: string;
      mimeType: string;
      parents?: string[];
      ownedByMe?: boolean;
      shared?: boolean;
      trashed?: boolean;
      capabilities?: { canEdit?: boolean; canAddChildren?: boolean; canShare?: boolean };
      content?: unknown;
      binary?: Buffer;
    }
  >;
  permissions: Map<
    string,
    Array<{
      id: string;
      type: 'user' | 'anyone';
      role: 'owner' | 'writer' | 'reader';
      emailAddress?: string;
      displayName?: string;
    }>
  >;
  accessProposals?: Map<
    string,
    Array<{
      proposalId: string;
      requesterEmailAddress?: string;
      recipientEmailAddress?: string;
      rolesAndViews?: Array<{ role?: string; view?: string }>;
      requestMessage?: string;
    }>
  >;
  unlockedFolders: Set<string>;
  pushedManifests: Array<{ folderId: string; payload: Record<string, unknown> }>;
  writeAttemptsById: string[];
}

async function stubGoogleIdentity(
  page: Page,
  options?: {
    withPicker?: { folderId: string; name: string };
    withWebShare?: boolean;
  },
) {
  await page.addInitScript(
    ({ pickerFolder, enableWebShare }) => {
      const w = window as unknown as Record<string, unknown>;
      w.google = {
        accounts: {
          oauth2: {
            initTokenClient: (cfg: {
              callback: (resp: { access_token: string; expires_in: number }) => void;
            }) => ({
              requestAccessToken: () => {
                cfg.callback({ access_token: 'e2e-collab-token', expires_in: 3600 });
              },
            }),
            revoke: () => {},
          },
        },
        ...(pickerFolder
          ? {
              picker: {
                ViewId: { FOLDERS: 'FOLDERS', DOCS: 'DOCS' },
                Action: { PICKED: 'picked', CANCEL: 'cancel' },
                DocsView: class {
                  setIncludeFolders() {
                    return this;
                  }
                  setSelectFolderEnabled() {
                    return this;
                  }
                  setMimeTypes() {
                    return this;
                  }
                },
                PickerBuilder: class {
                  private cb: ((data: unknown) => void) | null = null;
                  addView() {
                    return this;
                  }
                  setOAuthToken() {
                    return this;
                  }
                  setDeveloperKey() {
                    return this;
                  }
                  setAppId() {
                    return this;
                  }
                  setOrigin() {
                    return this;
                  }
                  setTitle() {
                    return this;
                  }
                  setCallback(fn: (data: unknown) => void) {
                    this.cb = fn;
                    return this;
                  }
                  build() {
                    const cb = this.cb;
                    return {
                      setVisible: (visible: boolean) => {
                        if (visible && cb) {
                          // Notify test harness / unlock folder via fetch signal then fire callback
                          fetch('https://picker-signal.test/unlock', {
                            method: 'POST',
                            body: JSON.stringify(pickerFolder),
                          }).finally(() => {
                            cb({
                              action: 'picked',
                              docs: [
                                { id: pickerFolder.folderId, name: pickerFolder.name },
                              ],
                            });
                          });
                        }
                      },
                    };
                  }
                },
              },
            }
          : {}),
      };

      if (enableWebShare) {
        const sharedCalls: Array<{
          title?: string;
          text?: string;
          url?: string;
          fileNames?: string[];
        }> = [];
        w.__sharedCalls = sharedCalls;
        Object.defineProperty(navigator, 'canShare', {
          configurable: true,
          value: () => true,
        });
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async (data: ShareData) => {
            sharedCalls.push({
              title: data.title,
              text: data.text,
              url: data.url,
              fileNames: data.files ? data.files.map((f) => f.name) : undefined,
            });
          },
        });
      }
    },
    {
      pickerFolder: options?.withPicker ?? null,
      enableWebShare: Boolean(options?.withWebShare),
    },
  );

  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '// mocked GSI',
    }),
  );
  await page.route('https://apis.google.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '// mocked gapi',
    }),
  );
}

async function installMockDriveBackend(
  page: Page,
  user: { displayName: string; emailAddress: string },
  state: MockDriveState,
) {
  let idSeq = 100;
  let permSeq = 10;

  await page.route('https://picker-signal.test/unlock', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}') as {
      folderId?: string;
    };
    if (body.folderId) {
      state.unlockedFolders.add(body.folderId);
    }
    return route.fulfill({ status: 200, body: 'ok' });
  });

  await page.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();

    if (url.includes('/drive/v3/about')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user }),
      });
    }

    // Permissions API: GET / POST / PATCH / DELETE /drive/v3/files/:id/permissions(/:permId)
    const permMatch = url.match(/\/drive\/v3\/files\/([^/?]+)\/permissions(?:\/([^/?]+))?/);
    if (permMatch) {
      const fileId = decodeURIComponent(permMatch[1]);
      const permId = permMatch[2] ? decodeURIComponent(permMatch[2]) : null;
      const list = state.permissions.get(fileId) ?? [];

      if (method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ permissions: list }),
        });
      }

      if (method === 'POST') {
        const body = JSON.parse(req.postData() || '{}') as {
          type: 'user' | 'anyone';
          role: 'writer' | 'reader';
          emailAddress?: string;
        };
        const created = {
          id: `perm-${++permSeq}`,
          type: body.type,
          role: body.role,
          emailAddress: body.emailAddress,
          displayName:
            body.type === 'anyone'
              ? 'Anyone with link'
              : body.emailAddress?.split('@')[0],
        };
        state.permissions.set(fileId, [...list, created]);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(created),
        });
      }

      if (method === 'PATCH' && permId) {
        const body = JSON.parse(req.postData() || '{}') as { role: 'writer' | 'reader' };
        const updated = list.map((p) =>
          p.id === permId ? { ...p, role: body.role } : p,
        );
        state.permissions.set(fileId, updated);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(updated.find((p) => p.id === permId) || {}),
        });
      }

      if (method === 'DELETE' && permId) {
        state.permissions.set(
          fileId,
          list.filter((p) => p.id !== permId),
        );
        return route.fulfill({ status: 204, body: '' });
      }
    }

    // Access Proposals API: GET /drive/v3/files/:id/accessproposals & POST .../:proposalId:resolve
    const proposalResolveMatch = url.match(
      /\/drive\/v3\/files\/([^/?]+)\/accessproposals\/([^/?:]+):resolve/,
    );
    if (proposalResolveMatch && method === 'POST') {
      const fileId = decodeURIComponent(proposalResolveMatch[1]);
      const proposalId = decodeURIComponent(proposalResolveMatch[2]);
      const body = JSON.parse(req.postData() || '{}') as {
        action: 'ACCEPT' | 'DENY';
        role?: string[];
      };
      const existing = state.accessProposals?.get(fileId) ?? [];
      const target = existing.find((p) => p.proposalId === proposalId);
      state.accessProposals?.set(
        fileId,
        existing.filter((p) => p.proposalId !== proposalId),
      );
      if (body.action === 'ACCEPT' && target) {
        const email =
          target.recipientEmailAddress || target.requesterEmailAddress || '';
        const role = body.role?.[0] === 'writer' ? 'writer' : 'reader';
        const curPerms = state.permissions.get(fileId) ?? [];
        state.permissions.set(fileId, [
          ...curPerms,
          {
            id: `perm-${++permSeq}`,
            type: 'user',
            role,
            emailAddress: email,
            displayName: email.split('@')[0],
          },
        ]);
      }
      return route.fulfill({ status: 200, body: '' });
    }

    const proposalListMatch = url.match(
      /\/drive\/v3\/files\/([^/?]+)\/accessproposals(?:\?|$)/,
    );
    if (proposalListMatch && method === 'GET') {
      const fileId = decodeURIComponent(proposalListMatch[1]);
      const proposals = state.accessProposals?.get(fileId) ?? [];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accessProposals: proposals }),
      });
    }

    // Resumable binary upload init
    if (url.includes('uploadType=resumable')) {
      const body = JSON.parse(req.postData() || '{}') as {
        name?: string;
        mimeType?: string;
        parents?: string[];
      };
      const fileMatch = url.match(/\/upload\/drive\/v3\/files\/([^/?]+)/);
      const existingId = fileMatch ? decodeURIComponent(fileMatch[1]) : null;
      const fileId = existingId || `drive-bin-${++idSeq}`;
      const parentId = body.parents?.[0];
      if (parentId) state.writeAttemptsById.push(parentId);
      if (existingId) state.writeAttemptsById.push(existingId);

      const prev = existingId ? state.driveFiles.get(existingId) : undefined;
      state.driveFiles.set(fileId, {
        id: fileId,
        name: body.name || prev?.name || 'audio.webm',
        mimeType: body.mimeType || prev?.mimeType || 'audio/webm',
        parents: body.parents || prev?.parents,
        ownedByMe: true,
      });

      return route.fulfill({
        status: 200,
        headers: {
          Location: `https://upload.collab.test/session/${encodeURIComponent(fileId)}`,
          'Access-Control-Expose-Headers': 'Location',
        },
        body: '',
      });
    }

    // Multipart JSON upload (project.json)
    if (url.includes('uploadType=multipart')) {
      const raw = req.postData() || '';
      const parts = raw.split(/\r?\n\r?\n/);
      // Part 1 = metadata JSON, Part 2 = payload JSON (before closing boundary)
      const metaText = (parts[1] || '').split(/\r?\n--/)[0];
      const payloadText = (parts[2] || '').split(/\r?\n--/)[0];
      const meta = JSON.parse(metaText || '{}') as {
        name?: string;
        parents?: string[];
      };
      const payload = JSON.parse(payloadText || '{}') as Record<string, unknown>;

      const fileMatch = url.match(/\/upload\/drive\/v3\/files\/([^/?]+)/);
      const existingId = fileMatch ? decodeURIComponent(fileMatch[1]) : null;
      const fileId = existingId || `drive-json-${++idSeq}`;
      const prev = existingId ? state.driveFiles.get(existingId) : undefined;
      const parentId = meta.parents?.[0] || prev?.parents?.[0] || '';
      if (parentId) state.writeAttemptsById.push(parentId);

      state.driveFiles.set(fileId, {
        id: fileId,
        name: meta.name || 'project.json',
        mimeType: 'application/json',
        parents: parentId ? [parentId] : prev?.parents,
        content: payload,
        ownedByMe: true,
      });
      state.pushedManifests.push({ folderId: parentId, payload });

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: fileId,
          name: 'project.json',
          mimeType: 'application/json',
        }),
      });
    }

    // File download (?alt=media)
    const mediaMatch = url.match(/\/drive\/v3\/files\/([^/?]+)\?alt=media/);
    if (method === 'GET' && mediaMatch) {
      const fileId = decodeURIComponent(mediaMatch[1]);
      const entry = state.driveFiles.get(fileId);
      if (!entry) {
        return route.fulfill({ status: 404, body: '{"error":{"message":"Not found"}}' });
      }
      if (entry.binary) {
        return route.fulfill({
          status: 200,
          contentType: entry.mimeType,
          body: entry.binary,
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(entry.content ?? {}),
      });
    }

    // Server-side file copy (POST /drive/v3/files/:id/copy)
    const copyMatch = url.match(/\/drive\/v3\/files\/([^/?]+)\/copy/);
    if (method === 'POST' && copyMatch) {
      const sourceId = decodeURIComponent(copyMatch[1]);
      const source = state.driveFiles.get(sourceId);
      if (!source || source.trashed) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Source file not found' } }),
        });
      }
      const body = JSON.parse(req.postData() || '{}') as {
        name?: string;
        parents?: string[];
      };
      const copiedId = `drive-copy-${++idSeq}`;
      const parentId = body.parents?.[0];
      if (parentId) state.writeAttemptsById.push(parentId);
      state.driveFiles.set(copiedId, {
        id: copiedId,
        name: body.name || source.name,
        mimeType: source.mimeType,
        parents: body.parents ?? ['root'],
        ownedByMe: true,
        shared: false,
        content: source.content,
        binary: source.binary,
        capabilities: { canEdit: true, canAddChildren: true, canShare: true },
      });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: copiedId,
          name: body.name || source.name,
          mimeType: source.mimeType,
          size: source.binary ? String(source.binary.byteLength) : undefined,
        }),
      });
    }

    // Single file metadata lookup / verifyFileExists
    const fileMetaMatch = url.match(/\/drive\/v3\/files\/([^/?]+)(?:\?|$)/);
    if (method === 'GET' && fileMetaMatch) {
      const fileId = decodeURIComponent(fileMetaMatch[1]);
      const entry = state.driveFiles.get(fileId);
      const isUnlocked = (() => {
        let cur = entry;
        let depth = 0;
        while (cur && depth < 10) {
          if (state.unlockedFolders.has(cur.id)) return true;
          const parentId = cur.parents?.[0];
          cur = parentId ? state.driveFiles.get(parentId) : undefined;
          depth += 1;
        }
        return false;
      })();
      if (!isUnlocked) {
        // Simulate drive.file scope hiding un-picked shared folders until Picker unlocks them
        if (entry?.shared && !entry.ownedByMe) {
          return route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'File not found' } }),
          });
        }
      }
      if (!entry || entry.trashed) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'File not found' } }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: entry.id,
          name: entry.name,
          mimeType: entry.mimeType,
          trashed: Boolean(entry.trashed),
          ownedByMe: entry.ownedByMe ?? true,
          shared: entry.shared ?? false,
          capabilities: entry.capabilities ?? {
            canEdit: true,
            canAddChildren: true,
            canShare: true,
          },
        }),
      });
    }

    // Rename / trash / PATCH file metadata
    if (method === 'PATCH' && fileMetaMatch) {
      const fileId = decodeURIComponent(fileMetaMatch[1]);
      state.writeAttemptsById.push(fileId);
      const body = JSON.parse(req.postData() || '{}') as {
        name?: string;
        trashed?: boolean;
      };
      const entry = state.driveFiles.get(fileId);
      if (entry) {
        if (body.name) entry.name = body.name;
        if (typeof body.trashed === 'boolean') entry.trashed = body.trashed;
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: fileId, name: entry?.name || body.name || '' }),
      });
    }

    // Create folder (POST /drive/v3/files)
    if (method === 'POST' && url.includes('/drive/v3/files')) {
      const body = JSON.parse(req.postData() || '{}') as {
        name: string;
        mimeType: string;
        parents?: string[];
      };
      const newId = `drive-folder-${++idSeq}`;
      if (body.parents?.[0]) state.writeAttemptsById.push(body.parents[0]);
      state.driveFiles.set(newId, {
        id: newId,
        name: body.name,
        mimeType: body.mimeType,
        parents: body.parents ?? ['root'],
        ownedByMe: true,
        capabilities: { canEdit: true, canAddChildren: true, canShare: true },
      });
      state.permissions.set(newId, [
        {
          id: `perm-owner-${newId}`,
          type: 'user',
          role: 'owner',
          emailAddress: user.emailAddress,
          displayName: user.displayName,
        },
      ]);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: newId,
          name: body.name,
          mimeType: body.mimeType,
          ownedByMe: true,
          capabilities: { canEdit: true, canAddChildren: true, canShare: true },
        }),
      });
    }

    // Query files (GET /drive/v3/files?q=...)
    if (method === 'GET' && url.includes('/drive/v3/files?')) {
      const parsed = new URL(url);
      const q = parsed.searchParams.get('q') || '';
      const parentMatch = q.match(/'([^']+)' in parents/);
      const nameMatch = q.match(/name = '([^']+)'/);
      const parentId = parentMatch?.[1];
      const wantedName = nameMatch?.[1];

      const matches = Array.from(state.driveFiles.values())
        .filter((f) => {
          if (f.trashed) return false;
          if (parentId && !(f.parents ?? []).includes(parentId)) return false;
          if (wantedName && f.name !== wantedName) return false;
          return true;
        })
        .map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          ownedByMe: f.ownedByMe ?? true,
          shared: f.shared ?? false,
          capabilities: f.capabilities ?? {
            canEdit: true,
            canAddChildren: true,
            canShare: true,
          },
        }));

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ files: matches }),
      });
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.route('https://upload.collab.test/**', async (route) => {
    const fileId = decodeURIComponent(route.request().url().split('/').pop() || 'bin');
    const entry = state.driveFiles.get(fileId);
    if (entry) {
      const rawBuf = route.request().postDataBuffer();
      if (rawBuf) entry.binary = rawBuf;
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: fileId,
        name: entry?.name || 'audio.webm',
        mimeType: entry?.mimeType || 'audio/webm',
      }),
    });
  });
}

test.describe('CUJ-09: Multi-User Family Sharing, Invite Links, Picker Unlock, Co-Narrator Merge & Listener Mode', () => {
  test('host shares a book folder by email, toggles anyone-with-link, builds invite link, revokes access, and shares chapter audio via Web Share API', async ({
    page,
  }) => {
    const state: MockDriveState = {
      driveFiles: new Map(),
      permissions: new Map(),
      accessProposals: new Map(),
      unlockedFolders: new Set(),
      pushedManifests: [],
      writeAttemptsById: [],
    };

    await stubGoogleIdentity(page, { withWebShare: true });
    await installMockDriveBackend(
      page,
      { displayName: 'Dad', emailAddress: 'dad@example.com' },
      state,
    );

    await page.goto('./');

    // Connect Google Drive directly & set default narrator in Settings (no Client ID input)
    await page.locator('#open-settings-btn').click();
    await page.getByTestId('settings-tab-app').click();
    await page.locator('#default-narrator-input').fill('Dad');
    await page.getByTestId('settings-tab-drive').click();
    await expect(page.locator('#drive-client-id-input')).toHaveCount(0);
    await page.getByRole('button', { name: 'Connect Google Drive' }).click();
    await expect(page.getByText('dad@example.com')).toBeVisible();
    await page.getByLabel('Close settings').click();

    // Create book & record Chapter 1 -> verifies per-chapter and auto-derived book "Read by Dad" attribution
    await createBook(page, {
      title: 'The Magic Faraway Tree',
      author: 'Enid Blyton',
    });
    await recordAndSaveChapter(page, {
      name: 'The Enchanted Wood',
      minDurationSec: 0.6,
    });
    await expect(page.locator('.project-hero__credits')).toContainText('Read by Dad');
    await expect(page.locator('.rec-card__meta')).toContainText('Read by Dad');

    // Zero-account quick Share Audio via Web Share API
    await page.getByLabel('More actions for The Enchanted Wood').click();
    await page.getByRole('menuitem', { name: 'Share Audio' }).click();
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __sharedCalls?: Array<{ fileNames?: string[] }>;
              }
            ).__sharedCalls?.length ?? 0,
        ),
      )
      .toBe(1);

    // Open Book Share Sheet -> invite Mom (Co-Narrator) & Grandma (Listener)
    await page.locator('#share-book-btn').click();
    const shareSheet = page.getByTestId('share-sheet');
    await expect(shareSheet).toBeVisible();
    await expect(shareSheet).not.toContainText('Testing mode');

    // Wait reactively for either prepare button or invite input
    await expect(
      page.locator('#prepare-share-folder-btn, #share-email-input').first(),
    ).toBeVisible();
    if (await page.locator('#prepare-share-folder-btn').isVisible()) {
      await page.locator('#prepare-share-folder-btn').click();
    }
    await expect(page.locator('#share-email-input')).toBeVisible();

    // Invite Mom as Co-Narrator (writer)
    await page.locator('#share-email-input').fill('mom@example.com');
    await page.getByRole('radio', { name: /Co-Narrator/i }).click();
    await page.locator('#share-invite-btn').click();
    await expect(shareSheet).toContainText('mom@example.com');

    // Invite Grandma as Listener (reader)
    await page.locator('#share-email-input').fill('grandma@example.com');
    await page.getByRole('radio', { name: /Listener/i }).click();
    await page.locator('#share-invite-btn').click();
    await expect(shareSheet).toContainText('grandma@example.com');

    // Toggle "Anyone with the link can listen" ON
    const anyoneSwitch = page.getByRole('switch', {
      name: /Anyone with the link can listen/i,
    });
    await expect(anyoneSwitch).toHaveAttribute('aria-checked', 'false');
    await anyoneSwitch.click();
    await expect(anyoneSwitch).toHaveAttribute('aria-checked', 'true');

    // Verify generated StoryTape join link contains folderId and scope=book without exposing clientId
    const inviteLinkInput = page.getByRole('textbox', {
      name: 'StoryTape invite link',
    });
    await expect(inviteLinkInput).toHaveValue(/#\/join\?folderId=/);
    await expect(inviteLinkInput).toHaveValue(/scope=book/);
    await expect(inviteLinkInput).not.toHaveValue(/clientId=/);

    // Invite link must wrap cleanly without cropping or horizontal scrolling (never scrolling into an empty box)
    const beforeMetrics = await inviteLinkInput.evaluate((el) => ({
      tagName: el.tagName,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    }));
    expect(beforeMetrics.tagName).toBe('TEXTAREA');
    expect(beforeMetrics.scrollWidth).toBeLessThanOrEqual(beforeMetrics.clientWidth + 1);
    expect(beforeMetrics.scrollHeight).toBeLessThanOrEqual(beforeMetrics.clientHeight + 1);
    expect(beforeMetrics.scrollLeft).toBe(0);
    expect(beforeMetrics.scrollTop).toBe(0);
    expect(beforeMetrics.clientHeight).toBeGreaterThan(44);

    // Focusing, attempting horizontal scroll, and blurring must keep scroll offsets locked at 0
    await inviteLinkInput.click();
    const afterInteractionMetrics = await inviteLinkInput.evaluate((el) => {
      el.scrollLeft = 500;
      el.scrollTop = 200;
      el.blur();
      return {
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    });
    expect(afterInteractionMetrics.scrollLeft).toBe(0);
    expect(afterInteractionMetrics.scrollTop).toBe(0);
    expect(afterInteractionMetrics.scrollWidth).toBeLessThanOrEqual(
      afterInteractionMetrics.clientWidth + 1,
    );
    expect(afterInteractionMetrics.scrollHeight).toBeLessThanOrEqual(
      afterInteractionMetrics.clientHeight + 1,
    );

    // Trigger native Share Invite Link (Web Share API)
    await page.locator('#share-link-native-btn').click();
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __sharedCalls?: Array<{ url?: string }>;
              }
            ).__sharedCalls?.some((c) => c.url?.includes('#/join?folderId=')) ??
            false,
        ),
      )
      .toBe(true);

    // Revoke Grandma's access cleanly (requires confirmation)
    await page.getByLabel('Remove grandma@example.com').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await expect(page.getByTestId('confirm-dialog')).toContainText('grandma@example.com');
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(shareSheet).toContainText('grandma@example.com');

    await page.getByLabel('Remove grandma@example.com').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(shareSheet).not.toContainText('grandma@example.com');
    await expect(shareSheet).toContainText('mom@example.com');

    // Pending Google Drive access requests appear for the owner and can be approved or denied in-app
    const inviteHref = await inviteLinkInput.inputValue();
    const sharedFolderIdMatch = inviteHref.match(/folderId=([^&]+)/);
    expect(sharedFolderIdMatch?.[1]).toBeTruthy();
    const bookFolderId = decodeURIComponent(sharedFolderIdMatch![1]);
    state.accessProposals!.set(bookFolderId, [
      {
        proposalId: 'prop-uncle',
        requesterEmailAddress: 'uncle@example.com',
        recipientEmailAddress: 'uncle@example.com',
        rolesAndViews: [{ role: 'reader' }],
        requestMessage: 'Can I listen to bedtime stories?',
      },
      {
        proposalId: 'prop-unknown',
        requesterEmailAddress: 'stranger@example.com',
        recipientEmailAddress: 'stranger@example.com',
        rolesAndViews: [{ role: 'writer' }],
      },
    ]);

    await page.getByLabel('Refresh collaborators').click();
    const requestsSection = page.getByTestId('share-access-requests-section');
    await expect(requestsSection).toBeVisible();
    await expect(requestsSection).toContainText('uncle@example.com');
    await expect(requestsSection).toContainText('Can I listen to bedtime stories?');
    await expect(requestsSection).toContainText('stranger@example.com');

    // Approve Uncle as Listener -> moves from Pending Access Requests into People with Access
    await page
      .getByTestId('access-proposal-prop-uncle')
      .getByRole('button', { name: /Approve as Listener/i })
      .click();
    await expect(page.getByTestId('access-proposal-prop-uncle')).toBeHidden();
    await expect(shareSheet).toContainText('uncle@example.com');

    // Deny unknown request -> Pending Access Requests section disappears cleanly
    await page
      .getByTestId('access-proposal-prop-unknown')
      .getByRole('button', { name: /Deny/i })
      .click();
    await expect(requestsSection).toBeHidden();
  });

  test('collaborator opens #/join link, unlocks shared folder via Google Picker, records Chapter 2 alongside Dad’s Chapter 1 with conflict-safe merge, and switches back to personal library', async ({
    page,
  }) => {
    const remoteAudio = createSilentWavBuffer(1.5);
    const sharedLibId = 'shared-family-lib-1';
    const sharedBookFolderId = 'shared-book-folder-1';
    const sharedMetaId = 'shared-book-meta-1';
    const dadChapterFileId = 'dad-ch1-audio-1';

    const state: MockDriveState = {
      driveFiles: new Map([
        [
          sharedLibId,
          {
            id: sharedLibId,
            name: 'Family Audiobooks',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['other-root'],
            ownedByMe: false,
            shared: true,
            capabilities: { canEdit: true, canAddChildren: true, canShare: true },
          },
        ],
        [
          sharedBookFolderId,
          {
            id: sharedBookFolderId,
            name: 'Bedtime Classics',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [sharedLibId],
            ownedByMe: false,
            shared: true,
            capabilities: { canEdit: true, canAddChildren: true, canShare: true },
          },
        ],
        [
          sharedMetaId,
          {
            id: sharedMetaId,
            name: 'project.json',
            mimeType: 'application/json',
            parents: [sharedBookFolderId],
            ownedByMe: false,
            shared: true,
            content: {
              schemaVersion: 1,
              id: 'book-family-1',
              title: 'Bedtime Classics',
              author: 'Family Stories',
              narrator: 'Dad & Mom',
              dedicatedTo: 'Emma',
              description: 'Recorded together by both parents.',
              language: 'English',
              tags: ['Bedtime'],
              coverColor: '#3D6352',
              createdAt: 1700000000000,
              updatedAt: 1700000001000,
              recordings: [
                {
                  id: 'rec-dad-1',
                  name: 'Goodnight Stars',
                  notes: 'Recorded before dinner',
                  recordedBy: 'Dad',
                  orderIndex: 0,
                  durationMs: 1500,
                  mimeType: 'audio/wav',
                  extension: 'wav',
                  sampleRate: 8000,
                  channels: 1,
                  fileSizeBytes: remoteAudio.byteLength,
                  peaks: [0.3, 0.6, 0.4],
                  driveFileId: dadChapterFileId,
                  driveFileName: '01 - Goodnight Stars.wav',
                  createdAt: 1700000000500,
                  updatedAt: 1700000000500,
                },
              ],
            },
          },
        ],
        [
          dadChapterFileId,
          {
            id: dadChapterFileId,
            name: '01 - Goodnight Stars.wav',
            mimeType: 'audio/wav',
            parents: [sharedBookFolderId],
            ownedByMe: false,
            shared: true,
            binary: remoteAudio,
          },
        ],
      ]),
      permissions: new Map(),
      unlockedFolders: new Set(), // Initially NOT unlocked under drive.file -> triggers Google Picker!
      pushedManifests: [],
      writeAttemptsById: [],
    };

    await stubGoogleIdentity(page, {
      withPicker: { folderId: sharedLibId, name: 'Family Audiobooks' },
    });
    await installMockDriveBackend(
      page,
      { displayName: 'Mom', emailAddress: 'mom@example.com' },
      state,
    );

    // 1. Mom opens the invite link directly (no Client ID needed in URL or UI)
    await page.goto(
      `./#/join?folderId=${sharedLibId}&name=Family%20Audiobooks&scope=library&role=writer`,
    );

    const joinModal = page.getByTestId('join-share-modal');
    await expect(joinModal).toBeVisible();
    await expect(joinModal).toContainText('Family Audiobooks');
    await expect(joinModal).toContainText('Co-Narrator');
    await expect(page.locator('#join-client-id-input')).toHaveCount(0);

    // Step 1: Connect Google Drive directly from the modal
    await page.locator('#join-connect-drive-btn').click();
    await expect(page.locator('#join-confirm-btn')).toBeVisible();

    // Step 2: Try joining -> Drive returns 404 under drive.file -> Picker unlock & Request Access cards appear!
    await page.locator('#join-confirm-btn').click();
    await expect(page.locator('#join-google-picker-btn')).toBeVisible();
    await expect(page.getByTestId('join-request-access-card')).toBeVisible();
    const requestAccessBtn = page.locator('#join-request-access-btn');
    await expect(requestAccessBtn).toBeVisible();
    await expect(requestAccessBtn).toHaveAttribute(
      'href',
      `https://drive.google.com/drive/folders/${sharedLibId}`,
    );
    await expect(requestAccessBtn).toHaveAttribute('target', '_blank');

    // Step 3: Pick folder via Google Picker -> unlocks folder & syncs immediately!
    await page.locator('#join-google-picker-btn').click();
    await expect(joinModal).toBeHidden();

    // Shared Family Library banner & Dad's book appear in Library!
    await expect(page.getByTestId('shared-library-banner')).toContainText(
      'Family Audiobooks',
    );
    await expect(page.getByLabel('Audiobook library')).toContainText(
      'Bedtime Classics',
    );

    // Open shared book -> verify Dad's chapter and auto-derived "Read by Dad" credit
    await page.getByRole('button', { name: /Bedtime Classics/i }).click();
    await expect(page.getByTestId('book-shared-role-badge')).toContainText(
      'Shared · Co-Narrator',
    );
    await expect(page.locator('.project-hero__credits')).toContainText('Read by Dad');
    await expect(page.locator('.rec-card__meta')).toContainText('Read by Dad');

    // Mom records Chapter 2 into the same shared book -> both Dad's & Mom's chapters merge and book narrator becomes "Read by Dad & Mom"!
    await recordAndSaveChapter(page, {
      name: 'Moonbeam Express',
      minDurationSec: 0.6,
    });

    await expect(page.locator('.project-hero__credits')).toContainText(
      'Read by Dad & Mom',
    );
    await expect(page.locator('.rec-card__title')).toHaveText([
      'Goodnight Stars',
      'Moonbeam Express',
    ]);
    await expect(page.locator('.rec-card__meta').nth(1)).toContainText(
      'Read by Mom',
    );

    // Wait reactively until merged project.json containing BOTH chapters is uploaded to Drive
    await expect
      .poll(() => {
        const latest = state.pushedManifests[state.pushedManifests.length - 1];
        const recs = (latest?.payload?.recordings as Array<{ name: string; recordedBy?: string }>) ?? [];
        return recs.map((r) => `${r.name}:${r.recordedBy ?? ''}`);
      })
      .toEqual(['Goodnight Stars:Dad', 'Moonbeam Express:Mom']);

    // Switch back to Personal Library via Shared Library banner Manage button (deep-links to Drive tab, requires confirmation)
    await page.getByLabel('Back to library').click();
    await page
      .getByTestId('shared-library-banner')
      .getByRole('button', { name: 'Manage' })
      .click();
    await expect(page.getByTestId('settings-tab-drive')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.locator('#switch-personal-library-btn').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('settings-collab-box')).toContainText(
      'Personal Library',
    );
    await page.getByLabel('Close settings').click();
    await expect(page.getByTestId('shared-library-banner')).toBeHidden();
  });

  test('listener joins a read-only shared book via Settings paste, plays chapters on demand, sees read-only UI, and never sends Drive writes', async ({
    page,
  }) => {
    const remoteAudio = createSilentWavBuffer(1.5);
    const roBookFolderId = 'shared-book-ro-1';
    const roMetaId = 'shared-book-ro-meta-1';
    const roAudioId = 'shared-book-ro-audio-1';

    const state: MockDriveState = {
      driveFiles: new Map([
        [
          roBookFolderId,
          {
            id: roBookFolderId,
            name: 'Grandpa’s Adventure Tales',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['other-root'],
            ownedByMe: false,
            shared: true,
            capabilities: {
              canEdit: false,
              canAddChildren: false,
              canShare: false,
            },
          },
        ],
        [
          roMetaId,
          {
            id: roMetaId,
            name: 'project.json',
            mimeType: 'application/json',
            parents: [roBookFolderId],
            ownedByMe: false,
            shared: true,
            content: {
              schemaVersion: 1,
              id: 'book-grandpa-ro',
              title: 'Grandpa’s Adventure Tales',
              author: 'Grandpa',
              narrator: 'Grandpa',
              dedicatedTo: 'Emma',
              description: 'Read-only bedtime collection.',
              language: 'English',
              tags: ['Grandpa'],
              coverColor: '#2F4562',
              createdAt: 1700000000000,
              updatedAt: 1700000002000,
              recordings: [
                {
                  id: 'rec-grandpa-1',
                  name: 'The Lighthouse Storm',
                  notes: '',
                  recordedBy: 'Grandpa',
                  orderIndex: 0,
                  durationMs: 1500,
                  mimeType: 'audio/wav',
                  extension: 'wav',
                  sampleRate: 8000,
                  channels: 1,
                  fileSizeBytes: remoteAudio.byteLength,
                  peaks: [0.4, 0.7, 0.5],
                  driveFileId: roAudioId,
                  driveFileName: '01 - The Lighthouse Storm.wav',
                  createdAt: 1700000001000,
                  updatedAt: 1700000001000,
                },
              ],
            },
          },
        ],
        [
          roAudioId,
          {
            id: roAudioId,
            name: '01 - The Lighthouse Storm.wav',
            mimeType: 'audio/wav',
            parents: [roBookFolderId],
            ownedByMe: false,
            shared: true,
            binary: remoteAudio,
          },
        ],
      ]),
      permissions: new Map(),
      unlockedFolders: new Set([roBookFolderId]),
      pushedManifests: [],
      writeAttemptsById: [],
    };

    await stubGoogleIdentity(page);
    await installMockDriveBackend(
      page,
      { displayName: 'Grandma', emailAddress: 'grandma@example.com' },
      state,
    );

    await page.goto('./');

    // Connect Drive directly in Settings -> Drive & paste a single-book invite link
    await page.locator('#open-settings-btn').click();
    await page.getByTestId('settings-tab-drive').click();
    await page.getByRole('button', { name: 'Connect Google Drive' }).click();
    await expect(page.getByText('grandma@example.com')).toBeVisible();

    await page
      .locator('#join-folder-input')
      .fill(
        `https://bogdan00.github.io/pwa_recorder/#/join?folderId=${roBookFolderId}&name=Grandpa&scope=book&role=reader`,
      );
    await page.locator('#settings-join-folder-btn').click();

    // Linked Shared Books list shows the book cleanly
    await expect(page.getByTestId('settings-collab-box')).toContainText(
      'Grandpa’s Adventure Tales',
    );
    await page.getByLabel('Close settings').click();

    // Open the read-only shared book
    await expect(page.getByLabel('Audiobook library')).toContainText(
      'Grandpa’s Adventure Tales',
    );
    await page
      .getByRole('button', { name: /Grandpa’s Adventure Tales/i })
      .click();

    // Verify Listener (Read-Only) UI: badge + banner visible, Record & Edit hidden
    await expect(page.getByTestId('book-shared-role-badge')).toContainText(
      'Shared · Listener',
    );
    await expect(page.locator('.project-readonly-banner')).toContainText(
      'Listener mode',
    );
    await expect(page.locator('#record-chapter-btn')).toBeHidden();
    await expect(page.locator('#edit-book-btn')).toBeHidden();

    // Chapter menu hides write actions (Rename/Delete) while keeping Share & Download
    await page.getByLabel('More actions for The Lighthouse Storm').click();
    await expect(page.getByRole('menuitem', { name: 'Download Audio' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Share Audio' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeHidden();
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeHidden();
    await page.keyboard.press('Escape');

    // Play the cloud-only shared chapter on demand!
    await page.getByRole('button', { name: /Play The Lighthouse Storm/i }).click();
    await expect(page.getByTestId('mini-player-bar')).toBeVisible();
    await expect(page.getByTestId('mini-player-bar')).toContainText(
      'The Lighthouse Storm',
    );

    // Verify ZERO write attempts were ever sent to the read-only Drive folder!
    expect(state.writeAttemptsById).not.toContain(roBookFolderId);
    expect(state.writeAttemptsById).not.toContain(roMetaId);
  });

  test('imports a colleague finished book copy into library, mirrors new chapters on sync, survives source revocation, and detaches to editable', async ({
    page,
  }) => {
    const ch1Audio = createSilentWavBuffer(1.2);
    const ch2Audio = createSilentWavBuffer(1.2);
    const colleagueFolderId = 'colleague-book-1';
    const colleagueMetaId = 'colleague-meta-1';
    const colleagueAudio1Id = 'colleague-audio-1';
    const colleagueAudio2Id = 'colleague-audio-2';

    const state: MockDriveState = {
      driveFiles: new Map([
        [
          colleagueFolderId,
          {
            id: colleagueFolderId,
            name: 'Dragon Stories',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['colleague-root'],
            ownedByMe: false,
            shared: true,
            capabilities: {
              canEdit: false,
              canAddChildren: false,
              canShare: false,
            },
          },
        ],
        [
          colleagueMetaId,
          {
            id: colleagueMetaId,
            name: 'project.json',
            mimeType: 'application/json',
            parents: [colleagueFolderId],
            ownedByMe: false,
            shared: true,
            content: {
              schemaVersion: 1,
              id: 'book-colleague-dragon',
              title: 'Dragon Stories',
              author: 'Alex',
              narrator: 'Alex',
              dedicatedTo: '',
              description: 'Finished bedtime dragon stories.',
              language: 'English',
              tags: ['Fantasy'],
              coverColor: '#3D6352',
              createdAt: 1700000000000,
              updatedAt: 1700000001000,
              recordings: [
                {
                  id: 'colleague-rec-1',
                  name: 'The Silver Egg',
                  notes: '',
                  recordedBy: 'Alex',
                  orderIndex: 0,
                  durationMs: 1200,
                  mimeType: 'audio/wav',
                  extension: 'wav',
                  sampleRate: 8000,
                  channels: 1,
                  fileSizeBytes: ch1Audio.byteLength,
                  peaks: [0.3, 0.7, 0.5],
                  driveFileId: colleagueAudio1Id,
                  driveFileName: '01 - The Silver Egg.wav',
                  createdAt: 1700000000500,
                  updatedAt: 1700000000500,
                },
              ],
            },
          },
        ],
        [
          colleagueAudio1Id,
          {
            id: colleagueAudio1Id,
            name: '01 - The Silver Egg.wav',
            mimeType: 'audio/wav',
            parents: [colleagueFolderId],
            ownedByMe: false,
            shared: true,
            binary: ch1Audio,
          },
        ],
      ]),
      permissions: new Map(),
      unlockedFolders: new Set(), // Requires Google Picker unlock first under drive.file
      pushedManifests: [],
      writeAttemptsById: [],
    };

    await stubGoogleIdentity(page, {
      withPicker: { folderId: colleagueFolderId, name: 'Dragon Stories' },
    });
    await installMockDriveBackend(
      page,
      { displayName: 'Dad', emailAddress: 'dad@example.com' },
      state,
    );

    // 1. Open colleague's single-book Listener invite link
    await page.goto(
      `./#/join?folderId=${colleagueFolderId}&name=Dragon%20Stories&scope=book&role=reader`,
    );

    const joinModal = page.getByTestId('join-share-modal');
    await expect(joinModal).toBeVisible();
    await expect(page.getByTestId('join-book-mode-selector')).toBeVisible();
    await expect(page.locator('#join-mode-import')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Connect Drive -> try import -> Picker unlock -> completes server-side copy into own library
    await page.locator('#join-connect-drive-btn').click();
    await expect(page.locator('#join-confirm-btn')).toContainText(
      'Import to My Library',
    );
    await page.locator('#join-confirm-btn').click();
    await expect(page.locator('#join-google-picker-btn')).toBeVisible();
    await page.locator('#join-google-picker-btn').click();
    await expect(joinModal).toBeHidden();

    // Verify ZERO writes targeted colleague's original folder or files
    expect(state.writeAttemptsById).not.toContain(colleagueFolderId);
    expect(state.writeAttemptsById).not.toContain(colleagueMetaId);
    expect(state.writeAttemptsById).not.toContain(colleagueAudio1Id);

    // Book appears on shelf with Imported badge & Listen-only UI
    await expect(page.getByLabel('Audiobook library')).toContainText(
      'Dragon Stories',
    );
    await page.getByRole('button', { name: /Dragon Stories/i }).click();
    await expect(page.getByTestId('book-imported-badge')).toContainText(
      'Imported Copy',
    );
    await expect(page.getByTestId('project-imported-banner')).toContainText(
      'Imported copy',
    );
    await expect(page.locator('#record-chapter-btn')).toBeHidden();
    await expect(page.locator('#edit-book-btn')).toBeHidden();
    await expect(page.locator('.rec-card__title')).toHaveText(['The Silver Egg']);

    // Play copied chapter from our own Drive folder
    await page.getByRole('button', { name: /Play The Silver Egg/i }).click();
    await expect(page.getByTestId('mini-player-bar')).toContainText(
      'The Silver Egg',
    );

    // 2. Colleague adds Chapter 2 upstream -> tap Updates to mirror delta into our copy
    state.driveFiles.set(colleagueAudio2Id, {
      id: colleagueAudio2Id,
      name: '02 - The Ember Bridge.wav',
      mimeType: 'audio/wav',
      parents: [colleagueFolderId],
      ownedByMe: false,
      shared: true,
      binary: ch2Audio,
    });
    const metaEntry = state.driveFiles.get(colleagueMetaId)!;
    const prevMeta = metaEntry.content as {
      updatedAt: number;
      recordings: Array<Record<string, unknown>>;
    };
    metaEntry.content = {
      ...prevMeta,
      updatedAt: 1700000005000,
      recordings: [
        ...prevMeta.recordings,
        {
          id: 'colleague-rec-2',
          name: 'The Ember Bridge',
          notes: 'Bonus chapter',
          recordedBy: 'Alex',
          orderIndex: 1,
          durationMs: 1200,
          mimeType: 'audio/wav',
          extension: 'wav',
          sampleRate: 8000,
          channels: 1,
          fileSizeBytes: ch2Audio.byteLength,
          peaks: [0.5, 0.8, 0.4],
          driveFileId: colleagueAudio2Id,
          driveFileName: '02 - The Ember Bridge.wav',
          createdAt: 1700000004000,
          updatedAt: 1700000004000,
        },
      ],
    };

    await page.locator('#sync-book-btn').click();
    await expect(page.locator('.rec-card__title')).toHaveText([
      'The Silver Egg',
      'The Ember Bridge',
    ]);
    expect(state.writeAttemptsById).not.toContain(colleagueFolderId);

    // 3. Colleague revokes access (404) -> sync succeeds, copy stays intact with both chapters
    state.unlockedFolders.delete(colleagueFolderId);
    await page.locator('#sync-book-btn').click();
    await expect(page.getByTestId('book-imported-badge')).toContainText(
      'Source Unavailable',
    );
    await expect(page.locator('.rec-card__title')).toHaveText([
      'The Silver Egg',
      'The Ember Bridge',
    ]);

    // 4. Detach & Make Editable unlocks Record Chapter & Edit
    await page.locator('#detach-imported-book-btn').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('book-imported-badge')).toBeHidden();
    await expect(page.locator('#record-chapter-btn')).toBeVisible();
    await expect(page.locator('#edit-book-btn')).toBeVisible();
  });

  test('family co-narrator syncing shared library automatically receives colleague book imported by spouse with zero Picker prompts, and Remove Copy trashes only the family copy', async ({
    page,
  }) => {
    const ch1Audio = createSilentWavBuffer(1.2);
    const ch2Audio = createSilentWavBuffer(1.2);
    const familyLibId = 'family-lib-root-9';
    const copiedBookFolderId = 'family-copied-dragon-1';
    const copiedMetaId = 'family-copied-dragon-meta-1';
    const copiedAudio1Id = 'family-copied-audio-1';
    const copiedAudio2Id = 'family-copied-audio-2';
    const colleagueFolderId = 'colleague-private-book-9';

    const state: MockDriveState = {
      driveFiles: new Map([
        [
          familyLibId,
          {
            id: familyLibId,
            name: 'Family Audiobooks',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['dad-root'],
            ownedByMe: false,
            shared: true,
            capabilities: {
              canEdit: true,
              canAddChildren: true,
              canShare: false,
            },
          },
        ],
        [
          copiedBookFolderId,
          {
            id: copiedBookFolderId,
            name: 'Dragon Stories',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [familyLibId],
            ownedByMe: false,
            shared: true,
            capabilities: {
              canEdit: true,
              canAddChildren: true,
              canShare: false,
            },
          },
        ],
        [
          copiedMetaId,
          {
            id: copiedMetaId,
            name: 'project.json',
            mimeType: 'application/json',
            parents: [copiedBookFolderId],
            ownedByMe: false,
            shared: true,
            content: {
              schemaVersion: 1,
              id: 'book-family-copy-dragon',
              title: 'Dragon Stories',
              author: 'Alex',
              narrator: 'Alex',
              dedicatedTo: '',
              description: 'Imported from work colleague.',
              language: 'English',
              tags: ['Fantasy'],
              coverColor: '#3D6352',
              importedFrom: {
                folderId: colleagueFolderId,
                sourceTitle: 'Dragon Stories',
                sourceProjectId: 'colleague-orig-id',
                importedByEmail: 'dad@example.com',
                importedAt: 1700000000000,
                lastMirrorSyncAt: 1700000005000,
                sourceUnavailable: false,
              },
              createdAt: 1700000000000,
              updatedAt: 1700000005000,
              recordings: [
                {
                  id: 'copy-rec-1',
                  sourceRecordingId: 'colleague-rec-1',
                  name: 'The Silver Egg',
                  notes: '',
                  recordedBy: 'Alex',
                  orderIndex: 0,
                  durationMs: 1200,
                  mimeType: 'audio/wav',
                  extension: 'wav',
                  sampleRate: 8000,
                  channels: 1,
                  fileSizeBytes: ch1Audio.byteLength,
                  peaks: [0.3, 0.7],
                  driveFileId: copiedAudio1Id,
                  driveFileName: '01 - The Silver Egg.wav',
                  createdAt: 1700000001000,
                  updatedAt: 1700000001000,
                },
                {
                  id: 'copy-rec-2',
                  sourceRecordingId: 'colleague-rec-2',
                  name: 'The Ember Bridge',
                  notes: '',
                  recordedBy: 'Alex',
                  orderIndex: 1,
                  durationMs: 1200,
                  mimeType: 'audio/wav',
                  extension: 'wav',
                  sampleRate: 8000,
                  channels: 1,
                  fileSizeBytes: ch2Audio.byteLength,
                  peaks: [0.5, 0.8],
                  driveFileId: copiedAudio2Id,
                  driveFileName: '02 - The Ember Bridge.wav',
                  createdAt: 1700000004000,
                  updatedAt: 1700000004000,
                },
              ],
            },
          },
        ],
        [
          copiedAudio1Id,
          {
            id: copiedAudio1Id,
            name: '01 - The Silver Egg.wav',
            mimeType: 'audio/wav',
            parents: [copiedBookFolderId],
            ownedByMe: false,
            shared: true,
            binary: ch1Audio,
          },
        ],
        [
          copiedAudio2Id,
          {
            id: copiedAudio2Id,
            name: '02 - The Ember Bridge.wav',
            mimeType: 'audio/wav',
            parents: [copiedBookFolderId],
            ownedByMe: false,
            shared: true,
            binary: ch2Audio,
          },
        ],
        // Colleague's original book is NOT shared with Wife and NOT in unlockedFolders
        [
          colleagueFolderId,
          {
            id: colleagueFolderId,
            name: 'Dragon Stories',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['colleague-root'],
            ownedByMe: false,
            shared: true,
            capabilities: {
              canEdit: false,
              canAddChildren: false,
              canShare: false,
            },
          },
        ],
      ]),
      permissions: new Map(),
      unlockedFolders: new Set([familyLibId]), // Only Family Library is unlocked for Wife
      pushedManifests: [],
      writeAttemptsById: [],
    };

    await stubGoogleIdentity(page);
    await installMockDriveBackend(
      page,
      { displayName: 'Wife', emailAddress: 'wife@example.com' },
      state,
    );

    // Wife connects to Family Audiobooks -> sees Dragon Stories + both chapters automatically!
    await page.goto(
      `./#/join?folderId=${familyLibId}&name=Family%20Audiobooks&scope=library&role=writer`,
    );
    await page.locator('#join-connect-drive-btn').click();
    await page.locator('#join-confirm-btn').click();
    await expect(page.getByTestId('join-share-modal')).toBeHidden();

    await expect(page.getByLabel('Audiobook library')).toContainText(
      'Dragon Stories',
    );
    await page.getByRole('button', { name: /Dragon Stories/i }).click();
    await expect(page.getByTestId('book-imported-badge')).toContainText(
      'Imported Copy',
    );
    await expect(page.locator('.rec-card__title')).toHaveText([
      'The Silver Egg',
      'The Ember Bridge',
    ]);

    // Wife plays Chapter 2 seamlessly from Family Library without colleague access
    await page.getByRole('button', { name: /Play The Ember Bridge/i }).click();
    await expect(page.getByTestId('mini-player-bar')).toContainText(
      'The Ember Bridge',
    );

    // Remove Copy trashes ONLY the copied family folder, never touching colleague's original
    await page.locator('#remove-imported-book-btn').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByLabel('Audiobook library')).not.toBeVisible();
    await expect(page.getByText('Start Your First Audiobook')).toBeVisible();

    expect(state.driveFiles.get(copiedBookFolderId)?.trashed).toBe(true);
    expect(state.driveFiles.get(colleagueFolderId)?.trashed).toBeFalsy();
    expect(state.writeAttemptsById).not.toContain(colleagueFolderId);
  });
});
