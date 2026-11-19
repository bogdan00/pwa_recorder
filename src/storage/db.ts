import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  ActiveDraft,
  BookProject,
  DraftChunkRecord,
  PlaybackProgress,
  Recording,
} from '../types/models';

const DB_NAME = 'storytape-db';
const DB_VERSION = 1;

interface StoredBinaryRecord {
  buffer: ArrayBuffer;
  type: string;
}

async function blobToStoredRecord(blob: Blob): Promise<StoredBinaryRecord> {
  const type = blob.type || 'application/octet-stream';
  if (typeof blob.arrayBuffer === 'function') {
    const buffer = await blob.arrayBuffer();
    return { buffer, type };
  }
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  return { buffer, type };
}

function storedRecordToBlob(
  value: Blob | StoredBinaryRecord | undefined,
): Blob | undefined {
  if (!value) return undefined;
  if (value instanceof Blob) return value;
  if ('buffer' in value && value.buffer) {
    return new Blob([value.buffer], { type: value.type || 'application/octet-stream' });
  }
  return undefined;
}

interface StoryTapeDBSchema extends DBSchema {
  projects: {
    key: string;
    value: BookProject;
    indexes: { 'by-updated': number };
  };
  projectCovers: {
    key: string;
    value: Blob | StoredBinaryRecord;
  };
  recordings: {
    key: string;
    value: Recording;
    indexes: { 'by-project': string };
  };
  recordingBlobs: {
    key: string;
    value: Blob | StoredBinaryRecord;
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
  }
  await tx.done;
}

export async function putProjectCover(
  projectId: string,
  blob: Blob,
): Promise<void> {
  const stored = await blobToStoredRecord(blob);
  const db = await getDb();
  await db.put('projectCovers', stored, projectId);
}

export async function getProjectCover(
  projectId: string,
): Promise<Blob | undefined> {
  const db = await getDb();
  const raw = await db.get('projectCovers', projectId);
  return storedRecordToBlob(raw);
}

export async function deleteProjectCover(projectId: string): Promise<void> {
  const db = await getDb();
  await db.delete('projectCovers', projectId);
}

// ============================================================================
// Recordings (Chapters)
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
): Promise<void> {
  const db = await getDb();
  if (blob) {
    const stored = await blobToStoredRecord(blob);
    const tx = db.transaction(['recordings', 'recordingBlobs'], 'readwrite');
    await tx.objectStore('recordings').put(recording);
    await tx.objectStore('recordingBlobs').put(stored, recording.id);
    await tx.done;
  } else {
    await db.put('recordings', recording);
  }
}

export async function putRecordingBlob(
  recordingId: string,
  blob: Blob,
): Promise<void> {
  const stored = await blobToStoredRecord(blob);
  const db = await getDb();
  await db.put('recordingBlobs', stored, recordingId);
}

export async function getRecordingBlob(
  recordingId: string,
): Promise<Blob | undefined> {
  const db = await getDb();
  const raw = await db.get('recordingBlobs', recordingId);
  return storedRecordToBlob(raw);
}

export async function deleteRecordingBlob(recordingId: string): Promise<void> {
  const db = await getDb();
  await db.delete('recordingBlobs', recordingId);
}

export async function deleteRecording(recordingId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['recordings', 'recordingBlobs'], 'readwrite');
  await tx.objectStore('recordings').delete(recordingId);
  await tx.objectStore('recordingBlobs').delete(recordingId);
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
