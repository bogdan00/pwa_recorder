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

function extractMultipartJsonPayload<T>(rawBody: string): T {
  const boundary = rawBody.split('\r\n')[0].trim();
  const parts = rawBody
    .split(boundary)
    .map((p) => p.trim())
    .filter((p) => p && p !== '--');
  const payloadPart = parts[1];
  const headerSplit = payloadPart.indexOf('\r\n\r\n');
  const jsonText = headerSplit >= 0 ? payloadPart.slice(headerSplit + 4) : payloadPart;
  return JSON.parse(jsonText) as T;
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
          ownedByMe: true,
        });
      }
      // Verify newly created local book folder
      if (url.includes('/drive/v3/files/book-folder-1?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'book-folder-1',
          name: 'The Gruffalo',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
        });
      }
      // Verify remote book folder
      if (url.includes('/drive/v3/files/remote-folder-2?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'remote-folder-2',
          name: 'Room on the Broom',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
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
          id: method === 'PATCH' ? 'remote-meta-file' : 'drive-meta-1',
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
              ownedByMe: true,
            },
          ],
        });
      }
      // List children of newly created book-folder-1 (pre-push pull check)
      if (url.includes('book-folder-1') && url.includes('in+parents')) {
        return jsonResponse({ files: [] });
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
    expect(result.pushedProjects).toBe(2);
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

  it('merges concurrent multi-narrator chapters conflict-safely without overwriting remote chapters', async () => {
    const sharedBook: BookProject = {
      id: 'book-collab',
      title: 'Family Bedtime Tales',
      author: 'The Smiths',
      narrator: 'Dad & Mom',
      dedicatedTo: 'Leo',
      description: 'Co-narrated audiobook',
      language: 'English',
      tags: ['Family'],
      coverColor: '#2F4562',
      hasCover: false,
      driveFolderId: 'collab-folder-1',
      driveMetadataFileId: 'collab-meta-1',
      isShared: true,
      accessRole: 'writer',
      syncStatus: 'pending_upload',
      createdAt: 1000,
      updatedAt: 5000,
    };

    const localCh1: Recording = {
      id: 'rec-ch1',
      projectId: 'book-collab',
      name: 'Chapter 1',
      notes: 'Read before bed',
      recordedBy: 'Dad',
      orderIndex: 0,
      durationMs: 18000,
      mimeType: 'audio/mp4',
      extension: 'm4a',
      sampleRate: 48000,
      bitrateKbps: 128,
      channels: 1,
      fileSizeBytes: 14,
      peaks: [0.1, 0.7],
      syncStatus: 'pending_upload',
      createdAt: 4000,
      updatedAt: 4000,
    };

    await putProject(sharedBook);
    await putRecording(localCh1, new Blob(['dad-chapter-1'], { type: 'audio/mp4' }));

    const remoteMeta: DriveProjectMetadataFile = {
      schemaVersion: 1,
      id: 'book-collab',
      title: 'Family Bedtime Tales',
      author: 'The Smiths',
      narrator: 'Dad & Mom',
      dedicatedTo: 'Leo',
      description: 'Co-narrated audiobook',
      language: 'English',
      tags: ['Family'],
      coverColor: '#2F4562',
      createdAt: 1000,
      updatedAt: 4500,
      recordings: [
        {
          id: 'rec-ch2',
          name: 'Chapter 2',
          notes: 'Recorded while traveling',
          recordedBy: 'Mom',
          orderIndex: 1,
          durationMs: 22000,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 48000,
          bitrateKbps: 128,
          channels: 1,
          fileSizeBytes: 16,
          peaks: [0.3, 0.9],
          driveFileId: 'drive-audio-ch2',
          driveFileName: '02 - Chapter 2.m4a',
          createdAt: 4500,
          updatedAt: 4500,
        },
      ],
    };

    const resumableInitCalls: string[] = [];
    let pushedManifest: DriveProjectMetadataFile | null = null;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/drive/v3/files/shared-root-1?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'shared-root-1',
          name: 'Shared Family Library',
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
              id: 'collab-folder-1',
              name: 'Family Bedtime Tales',
              mimeType: 'application/vnd.google-apps.folder',
              ownedByMe: false,
              shared: true,
              capabilities: { canEdit: true, canAddChildren: true },
            },
          ],
        });
      }
      if (url.includes('/drive/v3/files/collab-folder-1?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'collab-folder-1',
          name: 'Family Bedtime Tales',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: false,
          shared: true,
          capabilities: { canEdit: true, canAddChildren: true },
        });
      }
      if (url.includes('collab-folder-1') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            { id: 'collab-meta-1', name: 'project.json', mimeType: 'application/json' },
            { id: 'drive-audio-ch2', name: '02 - Chapter 2.m4a', mimeType: 'audio/mp4' },
          ],
        });
      }
      if (url.includes('/files/collab-meta-1?alt=media')) {
        return jsonResponse(remoteMeta);
      }
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
      if (url.startsWith('https://upload.example.com/session/') && method === 'PUT') {
        const fileName = decodeURIComponent(url.split('/').pop() || '');
        return jsonResponse({
          id: 'drive-audio-ch1',
          name: fileName,
          mimeType: 'audio/mp4',
        });
      }
      if (url.includes('uploadType=multipart')) {
        pushedManifest = extractMultipartJsonPayload<DriveProjectMetadataFile>(
          String(init?.body),
        );
        return jsonResponse({
          id: 'collab-meta-1',
          name: 'project.json',
          mimeType: 'application/json',
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const settings = {
      ...getDefaultSettings(),
      driveRootFolderId: 'shared-root-1',
      driveLibraryMode: 'shared' as const,
      driveAccessRole: 'writer' as const,
    };

    const client = new DriveClient('test-token');
    const result = await syncAllWithDrive(settings, undefined, client);

    expect(result.errors).toEqual([]);
    expect(result.pulledProjects).toBe(1);
    expect(result.pushedProjects).toBe(1);
    expect(result.pushedRecordings).toBe(1);
    expect(resumableInitCalls).toEqual(['01 - Chapter 1.m4a']);

    // Chapter 2 from Mom was pulled and merged as cloud_only with recordedBy preserved
    const mergedCh2 = await getRecording('rec-ch2');
    expect(mergedCh2).toBeDefined();
    expect(mergedCh2?.syncStatus).toBe('cloud_only');
    expect(mergedCh2?.recordedBy).toBe('Mom');
    expect(mergedCh2?.driveFileId).toBe('drive-audio-ch2');

    // Chapter 1 from Dad was uploaded and marked synced
    const syncedCh1 = await getRecording('rec-ch1');
    expect(syncedCh1?.syncStatus).toBe('synced');
    expect(syncedCh1?.recordedBy).toBe('Dad');
    expect(syncedCh1?.driveFileId).toBe('drive-audio-ch1');

    // Merged project.json pushed to Drive contains BOTH chapters
    expect(pushedManifest).not.toBeNull();
    const manifestRecs = pushedManifest!.recordings;
    expect(manifestRecs).toHaveLength(2);
    expect(manifestRecs.find((r) => r.id === 'rec-ch1')).toMatchObject({
      name: 'Chapter 1',
      recordedBy: 'Dad',
      driveFileId: 'drive-audio-ch1',
    });
    expect(manifestRecs.find((r) => r.id === 'rec-ch2')).toMatchObject({
      name: 'Chapter 2',
      recordedBy: 'Mom',
      driveFileId: 'drive-audio-ch2',
    });
  });

  it('respects deletion tombstones so deleted chapters are not resurrected and are removed on push', async () => {
    const bookWithTombstone: BookProject = {
      id: 'book-tomb',
      title: 'The Hobbit',
      author: 'J.R.R. Tolkien',
      narrator: 'Dad',
      dedicatedTo: 'Mia',
      description: '',
      language: 'English',
      tags: [],
      coverColor: '#3D6352',
      hasCover: false,
      driveFolderId: 'tomb-folder-1',
      driveMetadataFileId: 'tomb-meta-1',
      deletedRecordingIds: ['rec-deleted'],
      syncStatus: 'pending_upload',
      createdAt: 1000,
      updatedAt: 5000,
    };

    const keptRec: Recording = {
      id: 'rec-kept',
      projectId: 'book-tomb',
      name: 'An Unexpected Party',
      notes: '',
      recordedBy: 'Dad',
      orderIndex: 0,
      durationMs: 30000,
      mimeType: 'audio/mp4',
      extension: 'm4a',
      sampleRate: 44100,
      bitrateKbps: 128,
      channels: 1,
      fileSizeBytes: 20,
      peaks: [0.2, 0.5],
      driveFileId: 'drive-kept-audio',
      driveFileName: '01 - An Unexpected Party.m4a',
      syncStatus: 'synced',
      createdAt: 1000,
      updatedAt: 1000,
    };

    await putProject(bookWithTombstone);
    await putRecording(keptRec);

    // Remote project.json still lists the deleted chapter alongside the kept one
    const remoteMeta: DriveProjectMetadataFile = {
      schemaVersion: 1,
      id: 'book-tomb',
      title: 'The Hobbit',
      author: 'J.R.R. Tolkien',
      narrator: 'Dad',
      dedicatedTo: 'Mia',
      description: '',
      language: 'English',
      tags: [],
      coverColor: '#3D6352',
      createdAt: 1000,
      updatedAt: 6000,
      recordings: [
        {
          id: 'rec-kept',
          name: 'An Unexpected Party',
          notes: '',
          recordedBy: 'Dad',
          orderIndex: 0,
          durationMs: 30000,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 44100,
          bitrateKbps: 128,
          channels: 1,
          fileSizeBytes: 20,
          peaks: [0.2, 0.5],
          driveFileId: 'drive-kept-audio',
          driveFileName: '01 - An Unexpected Party.m4a',
          createdAt: 1000,
          updatedAt: 1000,
        },
        {
          id: 'rec-deleted',
          name: 'Outtake To Remove',
          notes: '',
          recordedBy: 'Dad',
          orderIndex: 1,
          durationMs: 9000,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 44100,
          bitrateKbps: 128,
          channels: 1,
          fileSizeBytes: 8,
          peaks: [0.1],
          driveFileId: 'drive-deleted-audio',
          driveFileName: '02 - Outtake To Remove.m4a',
          createdAt: 2000,
          updatedAt: 2000,
        },
      ],
    };

    let pushedManifest: DriveProjectMetadataFile | null = null;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/drive/v3/files/personal-root?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'personal-root',
          name: 'StoryTape Audiobooks',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
        });
      }
      if (url.includes('personal-root') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            {
              id: 'tomb-folder-1',
              name: 'The Hobbit',
              mimeType: 'application/vnd.google-apps.folder',
              ownedByMe: true,
            },
          ],
        });
      }
      if (url.includes('/drive/v3/files/tomb-folder-1?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'tomb-folder-1',
          name: 'The Hobbit',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
        });
      }
      if (url.includes('tomb-folder-1') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            { id: 'tomb-meta-1', name: 'project.json', mimeType: 'application/json' },
            { id: 'drive-kept-audio', name: '01 - An Unexpected Party.m4a', mimeType: 'audio/mp4' },
            { id: 'drive-deleted-audio', name: '02 - Outtake To Remove.m4a', mimeType: 'audio/mp4' },
          ],
        });
      }
      if (url.includes('/files/tomb-meta-1?alt=media')) {
        return jsonResponse(remoteMeta);
      }
      if (url.includes('uploadType=multipart')) {
        pushedManifest = extractMultipartJsonPayload<DriveProjectMetadataFile>(
          String(init?.body),
        );
        return jsonResponse({
          id: 'tomb-meta-1',
          name: 'project.json',
          mimeType: 'application/json',
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const settings = {
      ...getDefaultSettings(),
      driveRootFolderId: 'personal-root',
    };

    const client = new DriveClient('test-token');
    const result = await syncAllWithDrive(settings, undefined, client);

    expect(result.errors).toEqual([]);
    // Deleted recording was NOT resurrected locally
    expect(await getRecording('rec-deleted')).toBeUndefined();
    expect(await getRecording('rec-kept')).toBeDefined();

    // Tombstone preserved locally and pushed manifest removes rec-deleted
    const updatedProject = await getProject('book-tomb');
    expect(updatedProject?.deletedRecordingIds).toEqual(['rec-deleted']);

    expect(pushedManifest).not.toBeNull();
    expect(pushedManifest!.recordings.map((r) => r.id)).toEqual(['rec-kept']);
    expect(pushedManifest!.deletedRecordingIds).toEqual(['rec-deleted']);
  });

  it('protects read-only Listener (reader) folders by pulling as reader and never uploading', async () => {
    const remoteReadOnlyMeta: DriveProjectMetadataFile = {
      schemaVersion: 1,
      id: 'book-readonly',
      title: 'Grandpa Folktales',
      author: 'Traditional',
      narrator: 'Grandpa',
      dedicatedTo: 'Everyone',
      description: 'Read-only shared collection',
      language: 'English',
      tags: ['Classics'],
      coverColor: '#A6722E',
      createdAt: 1000,
      updatedAt: 2000,
      recordings: [
        {
          id: 'rec-ro-1',
          name: 'The Fox and the Crow',
          notes: '',
          recordedBy: 'Grandpa',
          orderIndex: 0,
          durationMs: 20000,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 44100,
          bitrateKbps: 128,
          channels: 1,
          fileSizeBytes: 15,
          peaks: [0.2, 0.6],
          driveFileId: 'drive-ro-audio-1',
          driveFileName: '01 - The Fox and the Crow.m4a',
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
    };

    // Even if there is an unlinked local book while connected to a read-only shared library,
    // syncAllWithDrive must not attempt any uploads into the read-only folder.
    await putProject({
      id: 'book-local-unlinked',
      title: 'Local Draft',
      author: '',
      narrator: '',
      dedicatedTo: '',
      description: '',
      language: '',
      tags: [],
      coverColor: '#9E4736',
      hasCover: false,
      syncStatus: 'local_only',
      createdAt: 1500,
      updatedAt: 1500,
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/drive/v3/files/readonly-root-1?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'readonly-root-1',
          name: 'Grandpa Shared Library',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: false,
          shared: true,
          capabilities: { canEdit: false, canAddChildren: false },
        });
      }
      if (url.includes('readonly-root-1') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            {
              id: 'readonly-book-folder-1',
              name: 'Grandpa Folktales',
              mimeType: 'application/vnd.google-apps.folder',
              ownedByMe: false,
              shared: true,
              capabilities: { canEdit: false, canAddChildren: false },
            },
          ],
        });
      }
      if (url.includes('readonly-book-folder-1') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            { id: 'readonly-meta-1', name: 'project.json', mimeType: 'application/json' },
            { id: 'drive-ro-audio-1', name: '01 - The Fox and the Crow.m4a', mimeType: 'audio/mp4' },
          ],
        });
      }
      if (url.includes('/files/readonly-meta-1?alt=media')) {
        return jsonResponse(remoteReadOnlyMeta);
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const client = new DriveClient('test-token');
    const uploadBinarySpy = vi.spyOn(client, 'uploadBinaryResumable');
    const uploadJsonSpy = vi.spyOn(client, 'uploadJsonFile');

    const settings = {
      ...getDefaultSettings(),
      driveRootFolderId: 'readonly-root-1',
      driveLibraryMode: 'shared' as const,
      driveAccessRole: 'reader' as const,
    };

    const result = await syncAllWithDrive(settings, undefined, client);

    expect(result.errors).toEqual([]);
    expect(result.rootAccessRole).toBe('reader');
    expect(result.pulledProjects).toBe(1);
    expect(result.pushedProjects).toBe(0);
    expect(result.pushedRecordings).toBe(0);

    // Pulled book & chapter have reader role and cloud_only status
    const pulledBook = await getProject('book-readonly');
    expect(pulledBook?.accessRole).toBe('reader');
    expect(pulledBook?.isShared).toBe(true);
    expect(pulledBook?.syncStatus).toBe('synced');

    const pulledRec = await getRecording('rec-ro-1');
    expect(pulledRec?.syncStatus).toBe('cloud_only');
    expect(pulledRec?.recordedBy).toBe('Grandpa');

    // NEVER calls uploadBinaryResumable or uploadJsonFile on read-only folders
    expect(uploadBinarySpy).not.toHaveBeenCalled();
    expect(uploadJsonSpy).not.toHaveBeenCalled();
  });

  it('pulls an individually linked shared book via settings.sharedBookFolders alongside the personal library', async () => {
    const personalMeta: DriveProjectMetadataFile = {
      schemaVersion: 1,
      id: 'book-personal',
      title: 'My Personal Book',
      author: 'Me',
      narrator: 'Me',
      dedicatedTo: '',
      description: '',
      language: 'English',
      tags: [],
      coverColor: '#9E4736',
      createdAt: 1000,
      updatedAt: 1000,
      recordings: [
        {
          id: 'rec-personal-1',
          name: 'Intro',
          notes: '',
          orderIndex: 0,
          durationMs: 12000,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 44100,
          bitrateKbps: 128,
          channels: 1,
          fileSizeBytes: 10,
          peaks: [0.3],
          driveFileId: 'drive-personal-audio-1',
          driveFileName: '01 - Intro.m4a',
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    };

    const linkedSharedMeta: DriveProjectMetadataFile = {
      schemaVersion: 1,
      id: 'book-linked-shared',
      title: 'Aunt Clara Stories',
      author: 'Clara',
      narrator: 'Aunt Clara',
      dedicatedTo: 'Family',
      description: 'Individually shared book link',
      language: 'English',
      tags: ['Shared'],
      coverColor: '#683B54',
      createdAt: 2000,
      updatedAt: 2500,
      recordings: [
        {
          id: 'rec-linked-1',
          name: 'Summer by the Lake',
          notes: '',
          recordedBy: 'Aunt Clara',
          orderIndex: 0,
          durationMs: 24000,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 48000,
          bitrateKbps: 128,
          channels: 1,
          fileSizeBytes: 18,
          peaks: [0.4, 0.8],
          driveFileId: 'drive-linked-audio-1',
          driveFileName: '01 - Summer by the Lake.m4a',
          createdAt: 2000,
          updatedAt: 2500,
        },
      ],
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      // Personal library root
      if (url.includes('/drive/v3/files/personal-root-1?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'personal-root-1',
          name: 'StoryTape Audiobooks',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
        });
      }
      if (url.includes('personal-root-1') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            {
              id: 'personal-book-folder-1',
              name: 'My Personal Book',
              mimeType: 'application/vnd.google-apps.folder',
              ownedByMe: true,
              shared: false,
            },
          ],
        });
      }
      if (url.includes('/drive/v3/files/personal-book-folder-1?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'personal-book-folder-1',
          name: 'My Personal Book',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
          shared: false,
        });
      }
      if (url.includes('personal-book-folder-1') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            { id: 'personal-meta-1', name: 'project.json', mimeType: 'application/json' },
            { id: 'drive-personal-audio-1', name: '01 - Intro.m4a', mimeType: 'audio/mp4' },
          ],
        });
      }
      if (url.includes('/files/personal-meta-1?alt=media')) {
        return jsonResponse(personalMeta);
      }

      // Individually linked shared book folder (outside personal-root-1)
      if (url.includes('/drive/v3/files/linked-book-folder-9?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'linked-book-folder-9',
          name: 'Aunt Clara Stories',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: false,
          shared: true,
          capabilities: { canEdit: false, canAddChildren: false },
        });
      }
      if (url.includes('linked-book-folder-9') && url.includes('in+parents')) {
        return jsonResponse({
          files: [
            { id: 'linked-meta-9', name: 'project.json', mimeType: 'application/json' },
            {
              id: 'drive-linked-audio-1',
              name: '01 - Summer by the Lake.m4a',
              mimeType: 'audio/mp4',
            },
          ],
        });
      }
      if (url.includes('/files/linked-meta-9?alt=media')) {
        return jsonResponse(linkedSharedMeta);
      }

      // Multipart update for personal book metadata
      if (url.includes('uploadType=multipart')) {
        return jsonResponse({
          id: 'personal-meta-1',
          name: 'project.json',
          mimeType: 'application/json',
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const client = new DriveClient('test-token');
    const uploadBinarySpy = vi.spyOn(client, 'uploadBinaryResumable');
    const uploadJsonSpy = vi.spyOn(client, 'uploadJsonFile');

    const settings = {
      ...getDefaultSettings(),
      driveRootFolderId: 'personal-root-1',
      driveLibraryMode: 'personal' as const,
      sharedBookFolders: [
        {
          folderId: 'linked-book-folder-9',
          title: 'Aunt Clara Stories',
          role: 'reader' as const,
          addedAt: 2000,
        },
      ],
    };

    const result = await syncAllWithDrive(settings, undefined, client);

    expect(result.errors).toEqual([]);
    expect(result.pulledProjects).toBe(2);
    expect(result.pushedProjects).toBe(1); // Only the personal book, never the read-only linked book

    // Personal book pulled as owner
    const personalBook = await getProject('book-personal');
    expect(personalBook?.title).toBe('My Personal Book');
    expect(personalBook?.accessRole).toBe('owner');
    expect(personalBook?.isShared).toBe(false);

    // Individually linked shared book pulled alongside personal library
    const linkedBook = await getProject('book-linked-shared');
    expect(linkedBook?.title).toBe('Aunt Clara Stories');
    expect(linkedBook?.driveFolderId).toBe('linked-book-folder-9');
    expect(linkedBook?.isShared).toBe(true);
    expect(linkedBook?.accessRole).toBe('reader');

    const linkedRec = await getRecording('rec-linked-1');
    expect(linkedRec?.syncStatus).toBe('cloud_only');
    expect(linkedRec?.recordedBy).toBe('Aunt Clara');

    // No uploads targeted the read-only linked book folder
    expect(uploadBinarySpy).not.toHaveBeenCalled();
    expect(uploadJsonSpy).toHaveBeenCalledTimes(1);
    expect(uploadJsonSpy).toHaveBeenCalledWith(
      'project.json',
      'personal-book-folder-1',
      expect.objectContaining({ id: 'book-personal' }),
      'personal-meta-1',
    );
  });
});
