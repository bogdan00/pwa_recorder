import { beforeEach, describe, expect, it } from 'vitest';
import type { ActiveDraft, BookProject, Recording } from '../../types/models';
import {
  clearAllLocalMasters,
  clearSyncedAudioCache,
  deleteDraft,
  deleteProject,
  deleteRecording,
  deleteRecordingMaster,
  getLocalMastersSummary,
  getPlaybackProgress,
  getProject,
  getProjectCover,
  getRecording,
  getRecordingBlob,
  getRecordingMaster,
  listDrafts,
  listProjectRecordings,
  listProjects,
  loadDraftChunks,
  putPlaybackProgress,
  putProject,
  putProjectCover,
  putRecording,
  reorderProjectRecordings,
  replaceDraftSnapshot,
  resetDbConnectionForTests,
} from '../db';

function makeProject(id: string, title: string, updatedAt = 1000): BookProject {
  return {
    id,
    title,
    author: 'Julia Donaldson',
    narrator: 'Dad',
    dedicatedTo: 'Emma',
    description: 'Bedtime favorite',
    language: 'English',
    tags: ['Bedtime'],
    coverColor: '#9E4736',
    hasCover: false,
    syncStatus: 'local_only',
    createdAt: updatedAt,
    updatedAt,
  };
}

function makeRecording(
  id: string,
  projectId: string,
  orderIndex: number,
  name: string,
): Recording {
  return {
    id,
    projectId,
    name,
    notes: '',
    orderIndex,
    durationMs: 12000,
    mimeType: 'audio/mp4',
    extension: 'm4a',
    sampleRate: 48000,
    bitrateKbps: 320,
    channels: 1,
    fileSizeBytes: 512,
    peaks: [0.1, 0.5, 0.8],
    syncStatus: 'local_only',
    createdAt: 1000 + orderIndex,
    updatedAt: 1000 + orderIndex,
  };
}

describe('IndexedDB offline repository', () => {
  beforeEach(async () => {
    await resetDbConnectionForTests();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('storytape-db');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  it('stores & retrieves projects, covers, recordings, ordering, and playback progress', async () => {
    const book = makeProject('b1', 'The Gruffalo', 2000);
    await putProject({ ...book, hasCover: true });
    await putProjectCover('b1', new Blob(['jpg-data'], { type: 'image/jpeg' }));

    const list = await listProjects();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('The Gruffalo');
    const cover = await getProjectCover('b1');
    expect(cover?.size).toBe(8);

    const r1 = makeRecording('r1', 'b1', 0, 'Chapter 1');
    const r2 = makeRecording('r2', 'b1', 1, 'Chapter 2');
    await putRecording(r1, new Blob(['audio-1'], { type: 'audio/mp4' }));
    await putRecording(r2, new Blob(['audio-2'], { type: 'audio/mp4' }));

    await reorderProjectRecordings('b1', ['r2', 'r1']);
    const ordered = await listProjectRecordings('b1');
    expect(ordered.map((r) => r.id)).toEqual(['r2', 'r1']);

    await putPlaybackProgress({
      projectId: 'b1',
      recordingId: 'r2',
      positionSec: 42.5,
      durationSec: 120,
      completedRecordingIds: ['r1'],
      updatedAt: 5000,
    });
    const prog = await getPlaybackProgress('b1');
    expect(prog?.positionSec).toBe(42.5);
    expect(prog?.completedRecordingIds).toEqual(['r1']);

    await deleteProject('b1');
    expect(await getProject('b1')).toBeUndefined();
    expect(await getRecordingBlob('r1')).toBeUndefined();
  });

  it('frees local audio blobs only for synced chapters while keeping metadata', async () => {
    await putProject(makeProject('b2', 'Winnie-the-Pooh'));
    const syncedRec: Recording = {
      ...makeRecording('r-sync', 'b2', 0, 'Synced Ch'),
      driveFileId: 'drive-123',
      syncStatus: 'synced',
    };
    const localRec = makeRecording('r-loc', 'b2', 1, 'Local Ch');

    await putRecording(syncedRec, new Blob(['synced-bytes']));
    await putRecording(localRec, new Blob(['local-bytes']));

    const freed = await clearSyncedAudioCache();
    expect(freed).toBe(1);

    expect(await getRecordingBlob('r-sync')).toBeUndefined();
    expect((await getRecording('r-sync'))?.syncStatus).toBe('cloud_only');
    expect((await getRecordingBlob('r-loc'))?.size).toBeGreaterThan(0);
  });

  it('saves and recovers crash-safe Float32 PCM draft chunks', async () => {
    const draft: ActiveDraft = {
      id: 'draft-1',
      projectId: 'b1',
      sampleRate: 48000,
      channels: 1,
      totalFrames: 4,
      chunkCount: 2,
      peaks: [0.4, 0.7],
      updatedAt: Date.now(),
    };

    await replaceDraftSnapshot(draft, [
      new Float32Array([0.1, 0.2]),
      new Float32Array([0.3, 0.4]),
    ]);

    const allDrafts = await listDrafts();
    expect(allDrafts).toHaveLength(1);
    const chunks = await loadDraftChunks('draft-1');
    expect(chunks).toHaveLength(2);
    expect(chunks[1][1]).toBeCloseTo(0.4, 5);

    await deleteDraft('draft-1');
    expect(await listDrafts()).toHaveLength(0);
    expect(await loadDraftChunks('draft-1')).toHaveLength(0);
  });

  it('stores local-only lossless masters separately, preserves them on synced cache clear, and cleans them up cleanly', async () => {
    await putProject(makeProject('b-master', 'Master Book'));
    const r1: Recording = {
      ...makeRecording('r-m1', 'b-master', 0, 'Ch 1'),
      driveFileId: 'drv-1',
      syncStatus: 'synced',
      hasLocalMaster: true,
      localMasterBytes: 12,
      localMasterSampleRate: 48000,
      localMasterBitDepth: 32,
      localMasterChannels: 1,
    };
    const r2: Recording = {
      ...makeRecording('r-m2', 'b-master', 1, 'Ch 2'),
      hasLocalMaster: true,
      localMasterBytes: 16,
    };

    await putRecording(
      r1,
      new Blob(['compressed-1'], { type: 'audio/mp4' }),
      new Blob(['master-wav-1'], { type: 'audio/wav' }),
    );
    await putRecording(
      r2,
      new Blob(['compressed-2'], { type: 'audio/mp4' }),
      new Blob(['master-wav-two-2'], { type: 'audio/wav' }),
    );

    const summary = await getLocalMastersSummary();
    expect(summary.count).toBe(2);
    expect(summary.totalBytes).toBe(28);

    // Clearing synced Drive cache must NOT remove local masters
    await clearSyncedAudioCache();
    expect(await getRecordingBlob('r-m1')).toBeUndefined();
    expect((await getRecordingMaster('r-m1'))?.size).toBe(12);

    // Deleting a single master keeps the recording and clears hasLocalMaster
    await deleteRecordingMaster('r-m1');
    expect(await getRecordingMaster('r-m1')).toBeUndefined();
    expect((await getRecording('r-m1'))?.hasLocalMaster).toBe(false);

    // Deleting recording cascades to its master
    await deleteRecording('r-m2');
    expect(await getRecordingMaster('r-m2')).toBeUndefined();

    // Bulk clearAllLocalMasters reclaims all remaining masters
    await putRecording(
      r2,
      new Blob(['compressed-2'], { type: 'audio/mp4' }),
      new Blob(['master-wav-two-2'], { type: 'audio/wav' }),
    );
    const cleared = await clearAllLocalMasters();
    expect(cleared.count).toBe(1);
    expect(cleared.freedBytes).toBe(16);
    expect((await getLocalMastersSummary()).count).toBe(0);
    expect((await getRecording('r-m2'))?.hasLocalMaster).toBe(false);
    expect((await getRecordingBlob('r-m2'))?.size).toBe(12);
  });
});
