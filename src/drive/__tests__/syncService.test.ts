import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookProject, DriveProjectMetadataFile, Recording } from '../../types/models';
import { getDefaultSettings } from '../../storage/settings';
import {
  getProject,
  getRecording,
  getRecordingBlob,
  putProject,
  putProjectCover,
  putRecording,
  resetDbConnectionForTests,
} from '../../storage/db';
import { DriveClient } from '../driveClient';
import { downloadCloudRecording, syncAllWithDrive } from '../syncService';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('Google Drive client & two-way syncService', () => {
  beforeEach(async () => {
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
  });

  it('pushes local book folder, cover.jpg, audio via resumable upload, project.json, and pulls remote cloud_only book', async () => {
    const localBook: BookProject = {
      id: 'book-local',
      title: 'The Gruffalo',
      author: 'Julia Donaldson',
      narrator: 'Dad',
      dedicatedTo: 'Mia',
      description: 'Bedtime story',
      language: 'English',
      tags: ['Bedtime'],
      coverColor: '#9E4736',
      hasCover: true,
      coverMimeType: 'image/jpeg',
      coverUpdatedAt: 1000,
      syncStatus: 'pending_upload',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const localRec: Recording = {
      id: 'rec-local',
      projectId: 'book-local',
      name: 'Into the Wood',
      notes: '',
      orderIndex: 0,
      durationMs: 15000,
      mimeType: 'audio/mp4',
      extension: 'm4a',
      sampleRate: 48000,
      bitrateKbps: 320,
      channels: 1,
      fileSizeBytes: 10,
      peaks: [0.2, 0.8],
      syncStatus: 'pending_upload',
      createdAt: 1000,
      updatedAt: 1000,
    };

    await putProject(localBook);
    await putProjectCover('book-local', new Blob(['fake-jpg'], { type: 'image/jpeg' }));
    await putRecording(localRec, new Blob(['fake-audio'], { type: 'audio/mp4' }));

    const remoteMeta: DriveProjectMetadataFile = {
      schemaVersion: 1,
      id: 'book-remote',
      title: 'Room on the Broom',
      author: 'Julia Donaldson',
      narrator: 'Mom',
      dedicatedTo: 'Mia',
      description: 'Recorded on iPad',
      language: 'English',
      tags: ['Favorites'],
      coverColor: '#3D6352',
      createdAt: 2000,
      updatedAt: 3000,
      recordings: [
        {
          id: 'rec-remote',
          name: 'Chapter 1',
          notes: '',
          orderIndex: 0,
          durationMs: 25000,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 44100,
          bitrateKbps: 128,
          channels: 1,
          fileSizeBytes: 12,
          peaks: [0.3, 0.6],
          driveFileId: 'drive-remote-audio',
          driveFileName: '01 - Chapter 1.m4a',
          createdAt: 2000,
          updatedAt: 2000,
        },
      ],
    };

    const resumableInitCalls: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      // Root folder lookup
      if (url.includes('/drive/v3/files?q=') && url.includes('StoryTape')) {
        return jsonResponse({ files: [] });
      }
      // Subfolder lookup for The Gruffalo
      if (url.includes('/drive/v3/files?q=') && url.includes('The%20Gruffalo')) {
        return jsonResponse({ files: [] });
      }
      // Create folder (root or book folder)
      if (url.includes('/drive/v3/files?fields=') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { name: string };
        return jsonResponse({
          id: body.name === 'StoryTape Audiobooks' ? 'root-folder-1' : 'book-folder-1',
          name: body.name,
          mimeType: 'application/vnd.google-apps.folder',
        });
      }
      // Resumable upload init (cover.jpg or 01 - Into the Wood.m4a)
      if (url.includes('uploadType=resumable')) {
        const meta = JSON.parse(String(init?.body)) as { name: string };
        resumableInitCalls.push(meta.name);
        return new Response('', {
          status: 200,
          headers: {
            Location: `https://upload.example.com/session/${encodeURIComponent(meta.name)}`,
          },
        });
      }
      // Resumable upload PUT bytes
      if (url.startsWith('https://upload.example.com/session/') && method === 'PUT') {
        const fileName = decodeURIComponent(url.split('/').pop() || '');
        return jsonResponse({
          id: fileName === 'cover.jpg' ? 'drive-cover-1' : 'drive-audio-1',
          name: fileName,
          mimeType: 'application/octet-stream',
        });
      }
      // Multipart project.json upload
      if (url.includes('uploadType=multipart')) {
        return jsonResponse({
          id: 'drive-meta-1',
          name: 'project.json',
          mimeType: 'application/json',
        });
      }
      // List children of root-folder-1 (pull step)
      if (url.includes('root-folder-1') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            {
              id: 'remote-folder-2',
              name: 'Room on the Broom',
              mimeType: 'application/vnd.google-apps.folder',
            },
          ],
        });
      }
      // List children of remote-folder-2
      if (url.includes('remote-folder-2') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            { id: 'remote-meta-file', name: 'project.json', mimeType: 'application/json' },
            { id: 'drive-remote-audio', name: '01 - Chapter 1.m4a', mimeType: 'audio/mp4' },
          ],
        });
      }
      // Download remote project.json
      if (url.includes('/files/remote-meta-file?alt=media')) {
        return jsonResponse(remoteMeta);
      }
      // Download remote audio on demand
      if (url.includes('/files/drive-remote-audio?alt=media')) {
        return new Response(new Blob(['remote-m4a-bytes'], { type: 'audio/mp4' }), {
          status: 200,
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const client = new DriveClient('test-token');
    const result = await syncAllWithDrive(getDefaultSettings(), undefined, client);

    expect(result.rootFolderId).toBe('root-folder-1');
    expect(result.pushedProjects).toBe(1);
    expect(result.pushedRecordings).toBe(1);
    expect(result.pulledProjects).toBe(1);
    expect(result.errors).toEqual([]);
    expect(resumableInitCalls).toEqual(['cover.jpg', '01 - Into the Wood.m4a']);

    // Local book & recording marked synced
    const syncedBook = await getProject('book-local');
    expect(syncedBook?.syncStatus).toBe('synced');
    expect(syncedBook?.driveMetadataFileId).toBe('drive-meta-1');
    const syncedRec = await getRecording('rec-local');
    expect(syncedRec?.syncStatus).toBe('synced');
    expect(syncedRec?.driveFileId).toBe('drive-audio-1');

    // Remote book pulled as cloud_only
    const pulledBook = await getProject('book-remote');
    expect(pulledBook?.title).toBe('Room on the Broom');
    const pulledRec = await getRecording('rec-remote');
    expect(pulledRec?.syncStatus).toBe('cloud_only');

    // On-demand download caches audio locally and flips to synced
    const downloadedBlob = await downloadCloudRecording('rec-remote', client);
    expect(downloadedBlob.size).toBeGreaterThan(0);
    expect((await getRecordingBlob('rec-remote'))?.size).toBeGreaterThan(0);
    expect((await getRecording('rec-remote'))?.syncStatus).toBe('synced');

    expect(fetchMock).toHaveBeenCalled();
  });
});
