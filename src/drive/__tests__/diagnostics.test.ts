import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultSettings } from '../../storage/settings';
import {
  putProject,
  putRecording,
  resetDbConnectionForTests,
} from '../../storage/db';
import {
  clearSyncDebugLog,
  getSyncDebugLog,
  recordSyncDebugEvent,
} from '../debugLog';
import { buildSyncDiagnosticsReport } from '../diagnostics';
import { DriveClient } from '../driveClient';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Sync & Sharing diagnostics export', () => {
  beforeEach(async () => {
    clearSyncDebugLog();
    await resetDbConnectionForTests();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('storytape-db');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearSyncDebugLog();
  });

  it('redacts tokens and API keys in debug trace events', () => {
    recordSyncDebugEvent('drive_api', 'http_error', {
      url: '/drive/v3/files?key=AIzaSecretKey123&q=foo',
      authorization: 'Bearer ya29.super-secret-token',
      nested: { accessToken: 'secret-tok', note: 'Bearer abc.123' },
    });

    const events = getSyncDebugLog();
    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('AIzaSecretKey123');
    expect(serialized).not.toContain('ya29.super-secret-token');
    expect(serialized).not.toContain('secret-tok');
    expect(serialized).toContain('[REDACTED]');
  });

  it('builds a full diagnostics report including local books, live Drive visibility probe, and trace events without leaking secrets', async () => {
    await putProject({
      id: 'book-1',
      title: 'Shared Tale',
      author: 'Dad',
      narrator: 'Dad',
      dedicatedTo: '',
      description: '',
      language: 'English',
      tags: [],
      coverColor: '#9E4736',
      hasCover: false,
      driveFolderId: 'book-folder-1',
      isShared: true,
      accessRole: 'writer',
      syncStatus: 'synced',
      createdAt: 1000,
      updatedAt: 2000,
    });
    await putRecording({
      id: 'rec-1',
      projectId: 'book-1',
      name: 'Ch 1',
      notes: '',
      recordedBy: 'Dad',
      orderIndex: 0,
      durationMs: 2000,
      mimeType: 'audio/mp4',
      extension: 'm4a',
      sampleRate: 48000,
      channels: 1,
      fileSizeBytes: 512,
      peaks: [0.5],
      driveFileId: 'audio-1',
      driveFileName: '01 - Ch 1.m4a',
      syncStatus: 'cloud_only',
      createdAt: 1000,
      updatedAt: 1000,
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/drive/v3/about')) {
        return jsonResponse({
          user: { displayName: 'Wife', emailAddress: 'wife@example.com' },
        });
      }
      if (url.includes('/drive/v3/files/shared-root-1?fields=')) {
        return jsonResponse({
          id: 'shared-root-1',
          name: 'StoryTape Audiobooks',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: false,
          shared: true,
          capabilities: { canEdit: true, canAddChildren: true },
        });
      }
      if (url.includes('shared-root-1') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            {
              id: 'book-folder-1',
              name: 'Shared Tale',
              mimeType: 'application/vnd.google-apps.folder',
              ownedByMe: false,
              shared: true,
            },
          ],
        });
      }
      if (url.includes('/drive/v3/files/book-folder-1?fields=')) {
        return jsonResponse({
          id: 'book-folder-1',
          name: 'Shared Tale',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: false,
          shared: true,
        });
      }
      if (url.includes('book-folder-1') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            { id: 'meta-1', name: 'project.json', mimeType: 'application/json' },
          ],
        });
      }
      if (url.includes('/files/meta-1?alt=media')) {
        return jsonResponse({
          schemaVersion: 1,
          id: 'book-1',
          title: 'Shared Tale',
          recordings: [{ id: 'rec-1' }],
          updatedAt: 2000,
        });
      }
      if (url.includes('q=trashed+%3D+false') || url.includes('trashed%20%3D%20false')) {
        return jsonResponse({
          files: [
            {
              id: 'shared-root-1',
              name: 'StoryTape Audiobooks',
              mimeType: 'application/vnd.google-apps.folder',
              ownedByMe: false,
              shared: true,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const client = new DriveClient('ya29.super-secret-live-token');
    const settings = {
      ...getDefaultSettings(),
      googleClientId: '12345.apps.googleusercontent.com',
      googleApiKey: 'AIzaSecretPickerKey',
      driveLibraryMode: 'shared' as const,
      driveRootFolderId: 'shared-root-1',
      driveSharedFolderName: 'StoryTape Audiobooks',
      driveAccessRole: 'writer' as const,
    };

    const report = await buildSyncDiagnosticsReport(settings, client);
    const rawJson = JSON.stringify(report);

    expect(rawJson).not.toContain('ya29.super-secret-live-token');
    expect(rawJson).not.toContain('AIzaSecretPickerKey');
    expect(report.localDb.projectCount).toBe(1);
    expect(report.localDb.recordingCount).toBe(1);
    expect(report.liveDriveProbe.ran).toBe(true);
    expect(report.liveDriveProbe.userInfo?.email).toBe('wife@example.com');
    expect(report.liveDriveProbe.rootFolderCheck?.children).toHaveLength(1);
    expect(
      report.liveDriveProbe.rootChildSubtrees?.[0]?.manifestSummary?.title,
    ).toBe('Shared Tale');
    expect(report.liveDriveProbe.visibleDriveItems).toHaveLength(1);
    expect(report.recentEvents.length).toBeGreaterThan(0);
  });
});
