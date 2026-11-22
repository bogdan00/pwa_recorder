import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  ActiveDraft,
  BookProject,
  DraftChunkRecord,
  PlaybackProgress,
  Recording,
} from '../types/models';
import { blobToArrayBuffer } from '../utils/blob';

const DB_NAME = 'storytape-db';
const DB_VERSION = 2;

interface StoredBinaryRecord {
  buffer: ArrayBuffer;
  type: string;
}

type StoredBinaryValue = Blob | StoredBinaryRecord;
type BinaryStoreName = 'projectCovers' | 'recordingBlobs' | 'recordingMasters';

async function blobToStoredRecord(blob: Blob): Promise<StoredBinaryRecord> {
  const type = blob.type || 'application/octet-stream';
  const buffer = await blobToArrayBuffer(blob);
  return { buffer, type };
}

function storedRecordToBlob(
  value: StoredBinaryValue | undefined,
): Blob | undefined {
  if (!value) return undefined;
  if (value instanceof Blob) return value;
  if ('buffer' in value && value.buffer) {
    return new Blob([value.buffer], { type: value.type || 'application/octet-stream' });
  }
  return undefined;
}

function storedBinaryByteLength(value: StoredBinaryValue | undefined): number {
  if (!value) return 0;
  if (value instanceof Blob) return value.size;
  if ('buffer' in value && value.buffer) return value.buffer.byteLength;
  return 0;
}

function stripLocalMasterFields(rec: Recording): Recording {
  return {
    ...rec,
    hasLocalMaster: false,
    localMasterBytes: undefined,
    localMasterSampleRate: undefined,
    localMasterBitDepth: undefined,
    localMasterChannels: undefined,
  };
}

interface StoryTapeDBSchema extends DBSchema {
  projects: {
    key: string;
    value: BookProject;
    indexes: { 'by-updated': number };
  };
  projectCovers: {
    key: string;
    value: StoredBinaryValue;
  };
  recordings: {
    key: string;
    value: Recording;
    indexes: { 'by-project': string };
  };
  recordingBlobs: {
    key: string;
    value: StoredBinaryValue;
  };
  recordingMasters: {
    key: string;
    value: StoredBinaryValue;
  };
  playbackProgress: {
    key: string;
    value: PlaybackProgress;
    indexes: { 'by-updated': number };
  };
  drafts: {
    key: string;
    value: ActiveDraft;
  };
  draftChunks: {
    key: string;
    value: DraftChunkRecord;
    indexes: { 'by-draft': string };
  };
}

let dbPromise: Promise<IDBPDatabase<StoryTapeDBSchema>> | null = null;

export function getDb(): Promise<IDBPDatabase<StoryTapeDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<StoryTapeDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          const store = db.createObjectStore('projects', { keyPath: 'id' });
          store.createIndex('by-updated', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('projectCovers')) {
          db.createObjectStore('projectCovers');
        }
        if (!db.objectStoreNames.contains('recordings')) {
          const store = db.createObjectStore('recordings', { keyPath: 'id' });
          store.createIndex('by-project', 'projectId');
        }
        if (!db.objectStoreNames.contains('recordingBlobs')) {
          db.createObjectStore('recordingBlobs');
        }
        if (!db.objectStoreNames.contains('recordingMasters')) {
          db.createObjectStore('recordingMasters');
        }
        if (!db.objectStoreNames.contains('playbackProgress')) {
          const store = db.createObjectStore('playbackProgress', {
            keyPath: 'projectId',
          });
          store.createIndex('by-updated', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('drafts')) {
          db.createObjectStore('drafts', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('draftChunks')) {
          const store = db.createObjectStore('draftChunks', { keyPath: 'key' });
          store.createIndex('by-draft', 'draftId');
        }
      },
    });
  }
  return dbPromise;
}

export async function resetDbConnectionForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}

async function putBinary(
  store: BinaryStoreName,
  key: string,
  blob: Blob,
): Promise<void> {
  const stored = await blobToStoredRecord(blob);
  const db = await getDb();
  await db.put(store, stored, key);
}

async function getBinary(
  store: BinaryStoreName,
  key: string,
): Promise<Blob | undefined> {
  const db = await getDb();
  const raw = await db.get(store, key);
  return storedRecordToBlob(raw);
}

// ============================================================================
// Book Projects
// ============================================================================

export async function listProjects(): Promise<BookProject[]> {
  const db = await getDb();
  const all = await db.getAll('projects');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<BookProject | undefined> {
  const db = await getDb();
  return db.get('projects', id);
}

export async function putProject(project: BookProject): Promise<void> {
  const db = await getDb();
  await db.put('projects', project);
}

export async function deleteProject(projectId: string): Promise<void> {
  const db = await getDb();
  const recs = await db.getAllFromIndex('recordings', 'by-project', projectId);
  const tx = db.transaction(
    [
      'projects',
      'projectCovers',
      'recordings',
      'recordingBlobs',
      'recordingMasters',
      'playbackProgress',
    ],
    'readwrite',
  );
  await tx.objectStore('projects').delete(projectId);
  await tx.objectStore('projectCovers').delete(projectId);
  await tx.objectStore('playbackProgress').delete(projectId);
  for (const rec of recs) {
    await tx.objectStore('recordings').delete(rec.id);
    await tx.objectStore('recordingBlobs').delete(rec.id);
    await tx.objectStore('recordingMasters').delete(rec.id);
  }
  await tx.done;
}

export function putProjectCover(projectId: string, blob: Blob): Promise<void> {
  return putBinary('projectCovers', projectId, blob);
}

export function getProjectCover(projectId: string): Promise<Blob | undefined> {
  return getBinary('projectCovers', projectId);
}

export async function deleteProjectCover(projectId: string): Promise<void> {
  const db = await getDb();
  await db.delete('projectCovers', projectId);
}

// ============================================================================
// Recordings (Chapters) & Local-Only Lossless Masters
// ============================================================================

export async function listAllRecordings(): Promise<Recording[]> {
  const db = await getDb();
  return db.getAll('recordings');
}

export async function listProjectRecordings(
  projectId: string,
): Promise<Recording[]> {
  const db = await getDb();
  const list = await db.getAllFromIndex('recordings', 'by-project', projectId);
  return list.sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt - b.createdAt);
}

export async function getRecording(id: string): Promise<Recording | undefined> {
  const db = await getDb();
  return db.get('recordings', id);
}

export async function putRecording(
  recording: Recording,
  blob?: Blob,
  masterBlob?: Blob,
): Promise<void> {
  const db = await getDb();
  if (blob || masterBlob) {
    const [storedBlob, storedMaster] = await Promise.all([
      blob ? blobToStoredRecord(blob) : Promise.resolve(null),
      masterBlob ? blobToStoredRecord(masterBlob) : Promise.resolve(null),
    ]);
    const stores: Array<'recordings' | 'recordingBlobs' | 'recordingMasters'> = [
      'recordings',
    ];
    if (storedBlob) stores.push('recordingBlobs');
    if (storedMaster) stores.push('recordingMasters');
    const tx = db.transaction(stores, 'readwrite');
    await tx.objectStore('recordings').put(recording);
    if (storedBlob) {
      await tx.objectStore('recordingBlobs').put(storedBlob, recording.id);
    }
    if (storedMaster) {
      await tx.objectStore('recordingMasters').put(storedMaster, recording.id);
    }
    await tx.done;
  } else {
    await db.put('recordings', recording);
  }
}

export function putRecordingBlob(recordingId: string, blob: Blob): Promise<void> {
  return putBinary('recordingBlobs', recordingId, blob);
}

export function getRecordingBlob(recordingId: string): Promise<Blob | undefined> {
  return getBinary('recordingBlobs', recordingId);
}

export function getRecordingMaster(recordingId: string): Promise<Blob | undefined> {
  return getBinary('recordingMasters', recordingId);
}

export async function deleteRecordingMaster(recordingId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['recordings', 'recordingMasters'], 'readwrite');
  await tx.objectStore('recordingMasters').delete(recordingId);
  const rec = await tx.objectStore('recordings').get(recordingId);
  if (rec && rec.hasLocalMaster) {
    await tx.objectStore('recordings').put(stripLocalMasterFields(rec));
  }
  await tx.done;
}

export async function getLocalMastersSummary(): Promise<{
  count: number;
  totalBytes: number;
}> {
  const db = await getDb();
  const all = await db.getAll('recordingMasters');
  let totalBytes = 0;
  for (const item of all) {
    totalBytes += storedBinaryByteLength(item);
  }
  return { count: all.length, totalBytes };
}

export async function clearAllLocalMasters(): Promise<{
  count: number;
  freedBytes: number;
}> {
  const db = await getDb();
  const tx = db.transaction(['recordings', 'recordingMasters'], 'readwrite');
  const keys = await tx.objectStore('recordingMasters').getAllKeys();
  let freedBytes = 0;
  for (const key of keys) {
    const raw = await tx.objectStore('recordingMasters').get(key);
    freedBytes += storedBinaryByteLength(raw);
    await tx.objectStore('recordingMasters').delete(key);
  }
  const recs = await tx.objectStore('recordings').getAll();
  for (const rec of recs) {
    if (rec.hasLocalMaster) {
      await tx.objectStore('recordings').put(stripLocalMasterFields(rec));
    }
  }
  await tx.done;
  return { count: keys.length, freedBytes };
}

export async function deleteRecording(recordingId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(
    ['recordings', 'recordingBlobs', 'recordingMasters'],
    'readwrite',
  );
  await tx.objectStore('recordings').delete(recordingId);
  await tx.objectStore('recordingBlobs').delete(recordingId);
  await tx.objectStore('recordingMasters').delete(recordingId);
  await tx.done;
}

export async function reorderProjectRecordings(
  projectId: string,
  orderedIds: string[],
): Promise<void> {
  const db = await getDb();
  const recs = await db.getAllFromIndex('recordings', 'by-project', projectId);
  const byId = new Map(recs.map((r) => [r.id, r]));
  const now = Date.now();
  const tx = db.transaction('recordings', 'readwrite');
  orderedIds.forEach((id, index) => {
    const rec = byId.get(id);
    if (rec && rec.orderIndex !== index) {
      void tx.store.put({ ...rec, orderIndex: index, updatedAt: now });
    }
  });
  await tx.done;
}

export async function clearSyncedAudioCache(): Promise<number> {
  const db = await getDb();
  const recs = await db.getAll('recordings');
  let cleared = 0;
  const tx = db.transaction(['recordings', 'recordingBlobs'], 'readwrite');
  for (const rec of recs) {
    if (rec.syncStatus === 'synced' && rec.driveFileId) {
      const existingBlob = await tx.objectStore('recordingBlobs').get(rec.id);
      if (existingBlob) {
        await tx.objectStore('recordingBlobs').delete(rec.id);
        await tx.objectStore('recordings').put({
          ...rec,
          syncStatus: 'cloud_only',
        });
        cleared += 1;
      }
    }
  }
  await tx.done;
  return cleared;
}

// ============================================================================
// Playback Progress (Continue Listening)
// ============================================================================

export async function listPlaybackProgress(): Promise<PlaybackProgress[]> {
  const db = await getDb();
  const all = await db.getAll('playbackProgress');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getPlaybackProgress(
  projectId: string,
): Promise<PlaybackProgress | undefined> {
  const db = await getDb();
  return db.get('playbackProgress', projectId);
}

export async function putPlaybackProgress(
  progress: PlaybackProgress,
): Promise<void> {
  const db = await getDb();
  await db.put('playbackProgress', progress);
}

// ============================================================================
// Crash-Safe Recording Drafts (Float32 PCM Chunks)
// ============================================================================

export async function listDrafts(): Promise<ActiveDraft[]> {
  const db = await getDb();
  const all = await db.getAll('drafts');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDraft(draftId: string): Promise<ActiveDraft | undefined> {
  const db = await getDb();
  return db.get('drafts', draftId);
}

export async function saveDraftMeta(draft: ActiveDraft): Promise<void> {
  const db = await getDb();
  await db.put('drafts', draft);
}

export async function saveDraftChunk(
  draftId: string,
  chunkIndex: number,
  data: Float32Array,
): Promise<void> {
  const db = await getDb();
  await db.put('draftChunks', {
    key: `${draftId}:${chunkIndex}`,
    draftId,
    chunkIndex,
    data,
  });
}

export async function saveDraftChunkAndMeta(
  draft: ActiveDraft,
  chunkIndex: number,
  data: Float32Array,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['drafts', 'draftChunks'], 'readwrite');
  await tx.objectStore('draftChunks').put({
    key: `${draft.id}:${chunkIndex}`,
    draftId: draft.id,
    chunkIndex,
    data,
  });
  await tx.objectStore('drafts').put(draft);
  await tx.done;
}

export async function loadDraftChunks(draftId: string): Promise<Float32Array[]> {
  const db = await getDb();
  const rows = await db.getAllFromIndex('draftChunks', 'by-draft', draftId);
  rows.sort((a, b) => a.chunkIndex - b.chunkIndex);
  return rows.map((r) =>
    r.data instanceof Float32Array ? r.data : new Float32Array(r.data),
  );
}

export async function replaceDraftSnapshot(
  draft: ActiveDraft,
  chunks: Float32Array[],
): Promise<void> {
  const db = await getDb();
  const existingKeys = await db.getAllKeysFromIndex(
    'draftChunks',
    'by-draft',
    draft.id,
  );
  const tx = db.transaction(['drafts', 'draftChunks'], 'readwrite');
  for (const key of existingKeys) {
    await tx.objectStore('draftChunks').delete(key);
  }
  await tx.objectStore('drafts').put(draft);
  for (let i = 0; i < chunks.length; i += 1) {
    await tx.objectStore('draftChunks').put({
      key: `${draft.id}:${i}`,
      draftId: draft.id,
      chunkIndex: i,
      data: chunks[i],
    });
  }
  await tx.done;
}

export async function deleteDraft(draftId: string): Promise<void> {
  const db = await getDb();
  const existingKeys = await db.getAllKeysFromIndex(
    'draftChunks',
    'by-draft',
    draftId,
  );
  const tx = db.transaction(['drafts', 'draftChunks'], 'readwrite');
  await tx.objectStore('drafts').delete(draftId);
  for (const key of existingKeys) {
    await tx.objectStore('draftChunks').delete(key);
  }
  await tx.done;
}
