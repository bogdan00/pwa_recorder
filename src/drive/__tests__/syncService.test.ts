import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookProject, DriveProjectMetadataFile, Recording } from '../../types/models';
import { getDefaultSettings } from '../../storage/settings';
import {
  getProject,
  getProjectCover,
  getRecording,
  getRecordingBlob,
  listProjectRecordings,
  putProject,
  putProjectCover,
  putRecording,
  resetDbConnectionForTests,
} from '../../storage/db';
import { DriveClient } from '../driveClient';
import {
  downloadCloudRecording,
  importSharedBookIntoLibrary,
  isUnsharedPersonalBook,
  mirrorImportedBookFromSource,
  shareLocalBooksIntoSharedLibrary,
  syncAllWithDrive,
} from '../syncService';

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

  it('imports a colleague book copy server-side via files.copy, caches cover, records importedFrom, and never writes to the source folder', async () => {
    const sourceMeta: DriveProjectMetadataFile = {
      schemaVersion: 1,
      id: 'colleague-book-id',
      title: 'Dragon Stories',
      author: 'Alex',
      narrator: 'Alex',
      dedicatedTo: 'Kids',
      description: 'Bedtime dragon adventures.',
      language: 'English',
      tags: ['Fantasy'],
      coverColor: '#3D6352',
      coverFileName: 'cover.jpg',
      coverMimeType: 'image/jpeg',
      coverUpdatedAt: 1500,
      createdAt: 1000,
      updatedAt: 2000,
      recordings: [
        {
          id: 'src-rec-1',
          name: 'The Silver Egg',
          notes: 'Chapter 1',
          recordedBy: 'Alex',
          orderIndex: 0,
          durationMs: 4200,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 48000,
          bitrateKbps: 128,
          channels: 1,
          fileSizeBytes: 64,
          peaks: [0.3, 0.7],
          driveFileId: 'src-audio-1',
          driveFileName: '01 - The Silver Egg.m4a',
          createdAt: 1100,
          updatedAt: 1100,
        },
        {
          id: 'src-rec-deleted',
          name: 'Deleted Take',
          notes: '',
          recordedBy: 'Alex',
          orderIndex: 1,
          durationMs: 1000,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 48000,
          channels: 1,
          fileSizeBytes: 32,
          peaks: [0.2],
          driveFileId: 'src-audio-deleted',
          driveFileName: '02 - Deleted Take.m4a',
          createdAt: 1200,
          updatedAt: 1200,
        },
      ],
      deletedRecordingIds: ['src-rec-deleted'],
    };

    const copyCalls: Array<{ sourceId: string; name: string; parentId: string }> = [];
    const writeTargets: string[] = [];
    let uploadedManifest: DriveProjectMetadataFile | null = null;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      // Own family root folder
      if (url.includes('/drive/v3/files/family-root-1?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'family-root-1',
          name: 'StoryTape Audiobooks',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
        });
      }
      if (url.includes('family-root-1') && url.includes('in+parents') && method === 'GET') {
        return jsonResponse({ files: [] });
      }

      // Colleague source folder (read-only)
      if (url.includes('/drive/v3/files/colleague-folder-1?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'colleague-folder-1',
          name: 'Dragon Stories',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: false,
          shared: true,
          capabilities: { canEdit: false, canAddChildren: false },
        });
      }
      if (url.includes('colleague-folder-1') && url.includes('in+parents') && method === 'GET') {
        return jsonResponse({
          files: [
            { id: 'src-meta-1', name: 'project.json', mimeType: 'application/json' },
            { id: 'src-cover-1', name: 'cover.jpg', mimeType: 'image/jpeg' },
            { id: 'src-audio-1', name: '01 - The Silver Egg.m4a', mimeType: 'audio/mp4' },
          ],
        });
      }
      if (url.includes('/files/src-meta-1?alt=media') && method === 'GET') {
        return jsonResponse(sourceMeta);
      }
      if (url.includes('/files/src-cover-1?alt=media') && method === 'GET') {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }

      // Create destination folder inside family-root-1
      if (url.includes('/drive/v3/files?fields=') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          name: string;
          parents?: string[];
        };
        if (body.parents?.[0]) writeTargets.push(body.parents[0]);
        return jsonResponse({
          id: 'copied-book-folder-1',
          name: body.name,
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
        });
      }

      // Server-side copyFile
      const copyMatch = url.match(/\/drive\/v3\/files\/([^/?]+)\/copy/);
      if (copyMatch && method === 'POST') {
        const sourceId = decodeURIComponent(copyMatch[1]);
        const body = JSON.parse(String(init?.body || '{}')) as {
          name: string;
          parents: string[];
        };
        copyCalls.push({ sourceId, name: body.name, parentId: body.parents[0] });
        writeTargets.push(body.parents[0]);
        return jsonResponse({
          id: `copied-${sourceId}`,
          name: body.name,
          mimeType: sourceId.includes('cover') ? 'image/jpeg' : 'audio/mp4',
        });
      }

      // Multipart upload of copied project.json
      if (url.includes('uploadType=multipart') && method === 'POST') {
        uploadedManifest = extractMultipartJsonPayload<DriveProjectMetadataFile>(
          String(init?.body || ''),
        );
        return jsonResponse({
          id: 'copied-meta-1',
          name: 'project.json',
          mimeType: 'application/json',
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const client = new DriveClient('test-token');
    const settings = {
      ...getDefaultSettings(),
      driveRootFolderId: 'family-root-1',
      driveLibraryMode: 'personal' as const,
    };

    const result = await importSharedBookIntoLibrary('colleague-folder-1', settings, {
      currentUserEmail: 'bogdan@example.com',
      clientOverride: client,
    });

    expect(result.alreadyExisted).toBe(false);
    expect(result.copiedChapters).toBe(1);
    expect(result.title).toBe('Dragon Stories');

    // Server-side files.copy copied cover + non-deleted chapter into copied-book-folder-1
    expect(copyCalls).toEqual([
      { sourceId: 'src-cover-1', name: 'cover.jpg', parentId: 'copied-book-folder-1' },
      {
        sourceId: 'src-audio-1',
        name: '01 - The Silver Egg.m4a',
        parentId: 'copied-book-folder-1',
      },
    ]);

    // Zero writes ever hit colleague-folder-1
    expect(writeTargets).not.toContain('colleague-folder-1');

    // Local project has fresh ID, Drive ownership, importedFrom metadata, and cached cover
    const importedProject = await getProject(result.projectId);
    expect(importedProject).toBeTruthy();
    expect(importedProject?.id).not.toBe('colleague-book-id');
    expect(importedProject?.driveFolderId).toBe('copied-book-folder-1');
    expect(importedProject?.accessRole).toBe('owner');
    expect(importedProject?.importedFrom?.folderId).toBe('colleague-folder-1');
    expect(importedProject?.importedFrom?.importedByEmail).toBe('bogdan@example.com');
    expect(importedProject?.importedFrom?.sourceUnavailable).toBe(false);

    const coverBlob = await getProjectCover(result.projectId);
    expect(coverBlob).toBeTruthy();

    const recs = await listProjectRecordings(result.projectId);
    expect(recs).toHaveLength(1);
    expect(recs[0].id).not.toBe('src-rec-1');
    expect(recs[0].sourceRecordingId).toBe('src-rec-1');
    expect(recs[0].driveFileId).toBe('copied-src-audio-1');
    expect(recs[0].recordedBy).toBe('Alex');

    // Uploaded manifest inside family Drive carries importedFrom and sourceRecordingId
    expect(uploadedManifest).toBeTruthy();
    expect((uploadedManifest as unknown as DriveProjectMetadataFile).importedFrom?.folderId).toBe(
      'colleague-folder-1',
    );
    expect((uploadedManifest as unknown as DriveProjectMetadataFile).recordings[0]?.sourceRecordingId).toBe(
      'src-rec-1',
    );
  });

  it('falls back to download + resumable upload when server-side files.copy fails during import', async () => {
    const sourceMeta: DriveProjectMetadataFile = {
      schemaVersion: 1,
      id: 'colleague-book-fallback',
      title: 'Fallback Tale',
      author: 'Alex',
      narrator: 'Alex',
      dedicatedTo: '',
      description: '',
      language: 'English',
      tags: [],
      coverColor: '#2F4562',
      createdAt: 1000,
      updatedAt: 2000,
      recordings: [
        {
          id: 'src-fb-1',
          name: 'Opening',
          notes: '',
          recordedBy: 'Alex',
          orderIndex: 0,
          durationMs: 2500,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 48000,
          channels: 1,
          fileSizeBytes: 8,
          peaks: [0.5],
          driveFileId: 'src-fb-audio-1',
          driveFileName: '01 - Opening.m4a',
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    };

    let resumableUploadCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/drive/v3/files/family-root-fb?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'family-root-fb',
          name: 'StoryTape Audiobooks',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
        });
      }
      if (url.includes('family-root-fb') && url.includes('in+parents') && method === 'GET') {
        return jsonResponse({ files: [] });
      }
      if (url.includes('/drive/v3/files/colleague-fb?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'colleague-fb',
          name: 'Fallback Tale',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: false,
          shared: true,
          capabilities: { canEdit: false, canAddChildren: false },
        });
      }
      if (url.includes('colleague-fb') && url.includes('in+parents') && method === 'GET') {
        return jsonResponse({
          files: [
            { id: 'src-fb-meta', name: 'project.json', mimeType: 'application/json' },
            { id: 'src-fb-audio-1', name: '01 - Opening.m4a', mimeType: 'audio/mp4' },
          ],
        });
      }
      if (url.includes('/files/src-fb-meta?alt=media') && method === 'GET') {
        return jsonResponse(sourceMeta);
      }
      if (url.includes('/drive/v3/files?fields=') && method === 'POST') {
        return jsonResponse({
          id: 'copied-fb-folder',
          name: 'Fallback Tale',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
        });
      }
      if (url.includes('/copy') && method === 'POST') {
        return jsonResponse({ error: { message: 'Copy restricted' } }, 403);
      }
      if (url.includes('/files/src-fb-audio-1?alt=media') && method === 'GET') {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mp4' },
        });
      }
      if (url.includes('uploadType=resumable') && method === 'POST') {
        return new Response('', {
          status: 200,
          headers: { Location: 'https://upload.fallback.test/put/1' },
        });
      }
      if (url === 'https://upload.fallback.test/put/1' && method === 'PUT') {
        resumableUploadCount += 1;
        return jsonResponse({
          id: 'reuploaded-audio-1',
          name: '01 - Opening.m4a',
          mimeType: 'audio/mp4',
        });
      }
      if (url.includes('uploadType=multipart') && method === 'POST') {
        return jsonResponse({
          id: 'copied-fb-meta',
          name: 'project.json',
          mimeType: 'application/json',
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const client = new DriveClient('test-token');
    const result = await importSharedBookIntoLibrary(
      'colleague-fb',
      { ...getDefaultSettings(), driveRootFolderId: 'family-root-fb' },
      { currentUserEmail: 'bogdan@example.com', clientOverride: client },
    );

    expect(result.copiedChapters).toBe(1);
    expect(resumableUploadCount).toBe(1);
    const recs = await listProjectRecordings(result.projectId);
    expect(recs[0]?.driveFileId).toBe('reuploaded-audio-1');
  });

  it('mirrors new chapters and upstream deletions into the family copy, skips non-importer family devices, and survives source 404 revocation', async () => {
    const importedBook: BookProject = {
      id: 'book-imported-local',
      title: 'Dragon Stories',
      author: 'Alex',
      narrator: 'Alex',
      dedicatedTo: '',
      description: '',
      language: 'English',
      tags: [],
      coverColor: '#3D6352',
      hasCover: false,
      driveFolderId: 'family-copy-folder-1',
      driveMetadataFileId: 'family-copy-meta-1',
      isShared: false,
      accessRole: 'owner',
      importedFrom: {
        folderId: 'colleague-src-folder',
        sourceTitle: 'Dragon Stories',
        sourceProjectId: 'colleague-book-id',
        importedByEmail: 'bogdan@example.com',
        importedAt: 1000,
        lastMirrorSyncAt: 1000,
        sourceUnavailable: false,
      },
      syncStatus: 'synced',
      createdAt: 1000,
      updatedAt: 2000,
    };

    const existingCopiedRec: Recording = {
      id: 'local-copy-rec-1',
      projectId: importedBook.id,
      sourceRecordingId: 'src-rec-1',
      name: 'The Silver Egg',
      notes: '',
      recordedBy: 'Alex',
      orderIndex: 0,
      durationMs: 3000,
      mimeType: 'audio/mp4',
      extension: 'm4a',
      sampleRate: 48000,
      channels: 1,
      fileSizeBytes: 50,
      peaks: [0.4],
      driveFileId: 'family-audio-1',
      driveFileName: '01 - The Silver Egg.m4a',
      syncStatus: 'cloud_only',
      createdAt: 1000,
      updatedAt: 1000,
    };

    await putProject(importedBook);
    await putRecording(existingCopiedRec);

    // 1. Non-importer family member (wife@example.com) silently skips upstream Drive requests!
    const wifeFetchSpy = vi.spyOn(globalThis, 'fetch');
    const wifeClient = new DriveClient('wife-token');
    const wifeSkipRes = await mirrorImportedBookFromSource(wifeClient, importedBook, {
      currentUserEmail: 'wife@example.com',
    });
    expect(wifeSkipRes).toEqual({
      updated: false,
      copiedChapters: 0,
      removedChapters: 0,
    });
    expect(wifeFetchSpy).not.toHaveBeenCalled();
    wifeFetchSpy.mockRestore();

    // 2. Importer (bogdan@example.com) mirrors Chapter 2 + upstream deletion of Chapter 1
    let sourceRevoked = false;
    const trashedIds: string[] = [];
    const copiedSourceIds: string[] = [];
    let latestFamilyManifest: DriveProjectMetadataFile = {
      schemaVersion: 1,
      id: importedBook.id,
      title: importedBook.title,
      author: importedBook.author,
      narrator: importedBook.narrator,
      dedicatedTo: '',
      description: '',
      language: 'English',
      tags: [],
      coverColor: '#3D6352',
      importedFrom: importedBook.importedFrom,
      createdAt: 1000,
      updatedAt: 2000,
      recordings: [
        {
          id: existingCopiedRec.id,
          sourceRecordingId: existingCopiedRec.sourceRecordingId,
          name: existingCopiedRec.name,
          notes: '',
          recordedBy: 'Alex',
          orderIndex: 0,
          durationMs: 3000,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 48000,
          channels: 1,
          fileSizeBytes: 50,
          peaks: [0.4],
          driveFileId: 'family-audio-1',
          driveFileName: '01 - The Silver Egg.m4a',
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    };

    const updatedSourceMeta: DriveProjectMetadataFile = {
      schemaVersion: 1,
      id: 'colleague-book-id',
      title: 'Dragon Stories',
      author: 'Alex',
      narrator: 'Alex',
      dedicatedTo: '',
      description: 'Updated with Chapter 2',
      language: 'English',
      tags: [],
      coverColor: '#3D6352',
      deletedRecordingIds: ['src-rec-1'],
      createdAt: 1000,
      updatedAt: 5000,
      recordings: [
        {
          id: 'src-rec-2',
          name: 'The Ember Bridge',
          notes: 'New chapter!',
          recordedBy: 'Alex',
          orderIndex: 0,
          durationMs: 4000,
          mimeType: 'audio/mp4',
          extension: 'm4a',
          sampleRate: 48000,
          channels: 1,
          fileSizeBytes: 80,
          peaks: [0.6, 0.8],
          driveFileId: 'src-audio-2',
          driveFileName: '01 - The Ember Bridge.m4a',
          createdAt: 4000,
          updatedAt: 4000,
        },
      ],
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/drive/v3/files/colleague-src-folder?fields=') && method === 'GET') {
        if (sourceRevoked) {
          return jsonResponse({ error: { message: 'Not found' } }, 404);
        }
        return jsonResponse({
          id: 'colleague-src-folder',
          name: 'Dragon Stories',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: false,
          shared: true,
        });
      }
      if (url.includes('colleague-src-folder') && url.includes('in+parents') && method === 'GET') {
        return jsonResponse({
          files: [
            { id: 'src-meta', name: 'project.json', mimeType: 'application/json' },
            { id: 'src-audio-2', name: '01 - The Ember Bridge.m4a', mimeType: 'audio/mp4' },
          ],
        });
      }
      if (url.includes('/files/src-meta?alt=media') && method === 'GET') {
        return jsonResponse(updatedSourceMeta);
      }

      if (url.includes('/drive/v3/files/family-copy-folder-1?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'family-copy-folder-1',
          name: 'Dragon Stories',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
        });
      }
      if (url.includes('family-copy-folder-1') && url.includes('in+parents') && method === 'GET') {
        return jsonResponse({
          files: [
            { id: 'family-copy-meta-1', name: 'project.json', mimeType: 'application/json' },
          ],
        });
      }
      if (url.includes('/files/family-copy-meta-1?alt=media') && method === 'GET') {
        return jsonResponse(latestFamilyManifest);
      }

      const copyMatch = url.match(/\/drive\/v3\/files\/([^/?]+)\/copy/);
      if (copyMatch && method === 'POST') {
        const srcId = decodeURIComponent(copyMatch[1]);
        copiedSourceIds.push(srcId);
        return jsonResponse({
          id: `copied-${srcId}`,
          name: '01 - The Ember Bridge.m4a',
          mimeType: 'audio/mp4',
        });
      }

      const patchMatch = url.match(/\/drive\/v3\/files\/([^/?]+)$/);
      if (patchMatch && method === 'PATCH') {
        const targetId = decodeURIComponent(patchMatch[1]);
        const body = JSON.parse(String(init?.body || '{}')) as { trashed?: boolean };
        if (body.trashed) trashedIds.push(targetId);
        return jsonResponse({ id: targetId });
      }

      if (url.includes('uploadType=multipart') && method === 'PATCH') {
        latestFamilyManifest = extractMultipartJsonPayload<DriveProjectMetadataFile>(
          String(init?.body || ''),
        );
        return jsonResponse({
          id: 'family-copy-meta-1',
          name: 'project.json',
          mimeType: 'application/json',
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const importerClient = new DriveClient('bogdan-token');
    const mirrorRes = await mirrorImportedBookFromSource(importerClient, importedBook, {
      currentUserEmail: 'bogdan@example.com',
    });

    expect(mirrorRes.updated).toBe(true);
    expect(mirrorRes.copiedChapters).toBe(1);
    expect(mirrorRes.removedChapters).toBe(1);
    expect(mirrorRes.sourceUnavailable).toBe(false);
    expect(copiedSourceIds).toEqual(['src-audio-2']);
    expect(trashedIds).toEqual(['family-audio-1']);

    const afterRecs = await listProjectRecordings(importedBook.id);
    expect(afterRecs).toHaveLength(1);
    expect(afterRecs[0].name).toBe('The Ember Bridge');
    expect(afterRecs[0].sourceRecordingId).toBe('src-rec-2');

    const afterBook = await getProject(importedBook.id);
    expect(afterBook?.deletedRecordingIds).toContain('local-copy-rec-1');
    expect(afterBook?.description).toBe('Updated with Chapter 2');

    // 3. Upstream source is revoked (404) -> copy stays 100% intact and marks sourceUnavailable!
    sourceRevoked = true;
    const revokedRes = await mirrorImportedBookFromSource(importerClient, afterBook!, {
      currentUserEmail: 'bogdan@example.com',
    });
    expect(revokedRes.sourceUnavailable).toBe(true);
    expect(revokedRes.updated).toBe(false);

    const preservedBook = await getProject(importedBook.id);
    expect(preservedBook?.importedFrom?.sourceUnavailable).toBe(true);
    const preservedRecs = await listProjectRecordings(importedBook.id);
    expect(preservedRecs).toHaveLength(1);
    expect(preservedRecs[0].name).toBe('The Ember Bridge');
  });

  it('skips pushing unshared personal books during shared library sync and copies/uploads them into the shared root only when explicitly shared', async () => {
    // 1. Existing Drive-synced personal book (like "Mica sirenă" in "Own StoryTape Audiobooks")
    const personalSyncedBook: BookProject = {
      id: 'book-personal-synced',
      title: 'Mica sirenă',
      author: 'H. C. Andersen',
      narrator: 'Mom',
      dedicatedTo: '',
      description: 'Recorded before joining shared library',
      language: 'Romanian',
      tags: [],
      coverColor: '#3D6352',
      hasCover: true,
      coverMimeType: 'image/jpeg',
      coverUpdatedAt: 1000,
      driveFolderId: 'personal-book-folder-1',
      driveMetadataFileId: 'personal-meta-1',
      driveCoverFileId: 'personal-cover-1',
      isShared: false,
      accessRole: 'owner',
      syncStatus: 'synced',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const personalSyncedRec: Recording = {
      id: 'rec-personal-1',
      projectId: personalSyncedBook.id,
      name: 'Chapter 1',
      notes: '',
      recordedBy: 'Mom',
      orderIndex: 0,
      durationMs: 4000,
      mimeType: 'audio/mp4',
      extension: 'm4a',
      sampleRate: 44100,
      channels: 1,
      fileSizeBytes: 128,
      peaks: [0.4],
      driveFileId: 'personal-audio-1',
      driveFileName: '01 - Chapter 1.m4a',
      syncStatus: 'synced',
      createdAt: 1000,
      updatedAt: 1000,
    };

    // 2. Local-only personal book (never synced to Drive before)
    const personalLocalBook: BookProject = {
      id: 'book-personal-local',
      title: 'Bedtime Rhymes',
      author: '',
      narrator: 'Mom',
      dedicatedTo: '',
      description: '',
      language: '',
      tags: [],
      coverColor: '#9E4736',
      hasCover: false,
      isShared: false,
      accessRole: 'owner',
      syncStatus: 'local_only',
      createdAt: 1100,
      updatedAt: 1100,
    };
    const personalLocalRec: Recording = {
      id: 'rec-local-1',
      projectId: personalLocalBook.id,
      name: 'Lullaby',
      notes: '',
      recordedBy: 'Mom',
      orderIndex: 0,
      durationMs: 2500,
      mimeType: 'audio/mp4',
      extension: 'm4a',
      sampleRate: 44100,
      channels: 1,
      fileSizeBytes: 12,
      peaks: [0.2],
      driveFileName: '01 - Lullaby.m4a',
      syncStatus: 'local_only',
      createdAt: 1100,
      updatedAt: 1100,
    };

    await putProject(personalSyncedBook);
    await putProjectCover(
      personalSyncedBook.id,
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
    );
    await putRecording(
      personalSyncedRec,
      new Blob([new Uint8Array([4, 5, 6])], { type: 'audio/mp4' }),
    );

    await putProject(personalLocalBook);
    await putRecording(
      personalLocalRec,
      new Blob([new Uint8Array([7, 8, 9])], { type: 'audio/mp4' }),
    );

    expect(isUnsharedPersonalBook(personalSyncedBook)).toBe(true);
    expect(isUnsharedPersonalBook(personalLocalBook)).toBe(true);

    const createdFolders: Array<{ id: string; name: string; parents?: string[] }> = [];
    const copiedFiles: Array<{ srcId: string; name: string; parents?: string[] }> = [];
    const uploadedBinaries: Array<{ name: string; parents?: string[] }> = [];
    const uploadedManifests: Array<{ parentId?: string; manifest: DriveProjectMetadataFile }> = [];
    let folderCounter = 0;
    let uploadCounter = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      // Verify shared root folder
      if (url.includes('/drive/v3/files/shared-root-family?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'shared-root-family',
          name: 'StoryTape Audiobooks',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['other-root'],
          ownedByMe: false,
          shared: true,
          capabilities: { canEdit: true, canAddChildren: true, canShare: true },
        });
      }

      // Verify existing personal book folder -> lives inside personal root, NOT shared root
      if (url.includes('/drive/v3/files/personal-book-folder-1?fields=') && method === 'GET') {
        return jsonResponse({
          id: 'personal-book-folder-1',
          name: 'Mica sirenă',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['personal-own-root'],
          ownedByMe: true,
          shared: false,
          capabilities: { canEdit: true, canAddChildren: true, canShare: true },
        });
      }

      // List children of shared root or findFolderByName -> empty initially
      if (url.includes('/drive/v3/files?q=') && method === 'GET') {
        return jsonResponse({ files: [] });
      }

      // Create book subfolder inside shared-root-family
      if (url.includes('/drive/v3/files?fields=') && method === 'POST') {
        folderCounter += 1;
        const body = JSON.parse(String(init?.body || '{}')) as {
          name: string;
          parents?: string[];
        };
        const created = {
          id: `shared-book-sub-${folderCounter}`,
          name: body.name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: body.parents,
          ownedByMe: true,
          shared: true,
          capabilities: { canEdit: true, canAddChildren: true, canShare: true },
        };
        createdFolders.push(created);
        return jsonResponse(created);
      }

      // Server-side files.copy for already-synced personal cover/audio
      const copyMatch = url.match(/\/drive\/v3\/files\/([^/?]+)\/copy/);
      if (copyMatch && method === 'POST') {
        const srcId = decodeURIComponent(copyMatch[1]);
        const body = JSON.parse(String(init?.body || '{}')) as {
          name: string;
          parents?: string[];
        };
        copiedFiles.push({ srcId, name: body.name, parents: body.parents });
        return jsonResponse({
          id: `copied-${srcId}`,
          name: body.name,
          mimeType: srcId.includes('cover') ? 'image/jpeg' : 'audio/mp4',
        });
      }

      // Resumable upload init for local-only recording
      if (url.includes('uploadType=resumable') && method === 'POST') {
        uploadCounter += 1;
        const body = JSON.parse(String(init?.body || '{}')) as {
          name: string;
          parents?: string[];
        };
        uploadedBinaries.push({ name: body.name, parents: body.parents });
        return new Response(null, {
          status: 200,
          headers: {
            Location: `https://upload.example.test/session/${uploadCounter}`,
          },
        });
      }
      if (url.startsWith('https://upload.example.test/session/') && method === 'PUT') {
        const idx = url.split('/').pop();
        return jsonResponse({
          id: `uploaded-bin-${idx}`,
          name: '01 - Lullaby.m4a',
          mimeType: 'audio/mp4',
        });
      }

      // Multipart JSON project.json upload (POST = fresh file in shared subfolder)
      if (url.includes('uploadType=multipart') && method === 'POST') {
        const raw = String(init?.body || '');
        const boundary = raw.split('\r\n')[0].trim();
        const parts = raw
          .split(boundary)
          .map((p) => p.trim())
          .filter((p) => p && p !== '--');
        const metaPart = parts[0].slice(parts[0].indexOf('\r\n\r\n') + 4);
        const metaObj = JSON.parse(metaPart) as { parents?: string[] };
        const manifest = extractMultipartJsonPayload<DriveProjectMetadataFile>(raw);
        uploadedManifests.push({
          parentId: metaObj.parents?.[0],
          manifest,
        });
        return jsonResponse({
          id: `shared-meta-${uploadedManifests.length}`,
          name: 'project.json',
          mimeType: 'application/json',
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const sharedSettings = {
      ...getDefaultSettings(),
      driveLibraryMode: 'shared' as const,
      driveRootFolderId: 'shared-root-family',
      driveSharedFolderName: 'StoryTape Audiobooks',
      driveAccessRole: 'writer' as const,
    };

    const client = new DriveClient('mom-token');

    // Step A: Routine syncAllWithDrive MUST NOT silently upload unshared personal books
    const syncRes = await syncAllWithDrive(sharedSettings, undefined, client);
    expect(syncRes.errors).toEqual([]);
    expect(syncRes.pushedProjects).toBe(0);
    expect(createdFolders).toHaveLength(0);
    expect(copiedFiles).toHaveLength(0);
    expect(uploadedBinaries).toHaveLength(0);

    // Step B: User explicitly chooses to share both existing personal books into the shared library
    const shareRes = await shareLocalBooksIntoSharedLibrary(
      [personalSyncedBook.id, personalLocalBook.id],
      sharedSettings,
      { clientOverride: client },
    );

    expect(shareRes.errors).toEqual([]);
    expect(shareRes.sharedProjects).toBe(2);
    expect(shareRes.sharedRecordings).toBe(2);

    // Both subfolders created directly inside shared-root-family
    expect(createdFolders).toEqual([
      expect.objectContaining({
        id: 'shared-book-sub-1',
        name: 'Mica sirenă',
        parents: ['shared-root-family'],
      }),
      expect.objectContaining({
        id: 'shared-book-sub-2',
        name: 'Bedtime Rhymes',
        parents: ['shared-root-family'],
      }),
    ]);

    // Previously Drive-synced book's cover + chapter copied server-side into shared subfolder
    expect(copiedFiles).toEqual([
      {
        srcId: 'personal-cover-1',
        name: 'cover.jpg',
        parents: ['shared-book-sub-1'],
      },
      {
        srcId: 'personal-audio-1',
        name: '01 - Chapter 1.m4a',
        parents: ['shared-book-sub-1'],
      },
    ]);

    // Local-only book's chapter uploaded directly into its shared subfolder
    expect(uploadedBinaries).toEqual([
      {
        name: '01 - Lullaby.m4a',
        parents: ['shared-book-sub-2'],
      },
    ]);

    // Both local BookProjects are now marked isShared: true and point to the new shared subfolders
    const updatedSynced = await getProject(personalSyncedBook.id);
    expect(updatedSynced).toMatchObject({
      driveFolderId: 'shared-book-sub-1',
      driveMetadataFileId: 'shared-meta-1',
      driveCoverFileId: 'copied-personal-cover-1',
      isShared: true,
      accessRole: 'writer',
      syncStatus: 'synced',
    });
    expect(isUnsharedPersonalBook(updatedSynced!)).toBe(false);

    const updatedLocal = await getProject(personalLocalBook.id);
    expect(updatedLocal).toMatchObject({
      driveFolderId: 'shared-book-sub-2',
      driveMetadataFileId: 'shared-meta-2',
      isShared: true,
      accessRole: 'writer',
      syncStatus: 'synced',
    });
    expect(isUnsharedPersonalBook(updatedLocal!)).toBe(false);

    const updatedSyncedRec = await getRecording(personalSyncedRec.id);
    expect(updatedSyncedRec?.driveFileId).toBe('copied-personal-audio-1');
    const updatedLocalRec = await getRecording(personalLocalRec.id);
    expect(updatedLocalRec?.driveFileId).toBe('uploaded-bin-1');
  });
});
