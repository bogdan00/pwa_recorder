import type {
  AppSettings,
  BookProject,
  DriveAccessProposal,
  DriveCollaboratorPermission,
  DriveProjectMetadataFile,
  ImportedBookSource,
  Recording,
  ShareAccessRole,
} from '../types/models';
import {
  deleteRecording,
  getProject,
  getProjectCover,
  getRecording,
  getRecordingBlob,
  listProjectRecordings,
  listProjects,
  putProject,
  putProjectCover,
  putRecording,
  putRecordingBlob,
} from '../storage/db';
import { blobToArrayBuffer } from '../utils/blob';
import {
  buildChapterDriveFileName,
  createId,
  sanitizeFileName,
} from '../utils/format';
import { recordSyncDebugEvent } from './debugLog';
import {
  DriveApiError,
  DriveClient,
  type DriveFileSummary,
} from './driveClient';
import { googleAuth } from './googleAuth';
import {
  deriveChapterNameFromFileName,
  detectImportedAudioFormat,
  inspectImportedAudioFile,
} from '../audio/audioImporter';
import { normalizeAudioBlobType } from '../player/playbackBlob';

export interface SyncProgressUpdate {
  phase: 'connecting' | 'pushing' | 'pulling' | 'done';
  message: string;
  current?: number;
  total?: number;
}

export interface SyncResult {
  rootFolderId: string;
  rootAccessRole: ShareAccessRole;
  pushedProjects: number;
  pushedRecordings: number;
  pulledProjects: number;
  errors: string[];
}

const PROJECT_METADATA_FILENAME = 'project.json';
const COVER_FILENAME = 'cover.jpg';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function resolveAccessRole(
  summary: DriveFileSummary | null | undefined,
  fallback: ShareAccessRole = 'owner',
): ShareAccessRole {
  if (!summary) return fallback;
  if (summary.ownedByMe === true) return 'owner';
  if (summary.capabilities) {
    const canWrite =
      summary.capabilities.canEdit === true ||
      summary.capabilities.canAddChildren === true;
    return canWrite ? 'writer' : 'reader';
  }
  if (summary.shared && summary.ownedByMe === false) {
    return fallback === 'reader' ? 'reader' : 'writer';
  }
  return fallback;
}

async function ensureRootFolder(
  client: DriveClient,
  settings: AppSettings,
): Promise<{ id: string; role: ShareAccessRole; name: string }> {
  if (settings.driveRootFolderId) {
    const existing = await client.verifyFileExists(settings.driveRootFolderId);
    if (existing) {
      return {
        id: existing.id,
        role: resolveAccessRole(
          existing,
          settings.driveAccessRole ??
            (settings.driveLibraryMode === 'shared' ? 'writer' : 'owner'),
        ),
        name: existing.name || settings.driveSharedFolderName || settings.driveRootFolderName,
      };
    }
    if (settings.driveLibraryMode === 'shared') {
      throw new DriveApiError(
        404,
        'Could not access the linked shared folder. Re-select it via Google Picker or check that it is shared with your account.',
      );
    }
  }
  const folderName = sanitizeFileName(
    settings.driveRootFolderName,
    'StoryTape Audiobooks',
  );
  const folder = await client.findOrCreateFolder(folderName);
  return {
    id: folder.id,
    role: resolveAccessRole(folder, 'owner'),
    name: folder.name || folderName,
  };
}

async function ensureProjectFolder(
  client: DriveClient,
  project: BookProject,
  rootFolderId: string,
): Promise<string> {
  const safeFolderName = sanitizeFileName(project.title, 'Untitled Book');
  if (project.driveFolderId) {
    const existing = await client.verifyFileExists(project.driveFolderId);
    if (existing) {
      const role = resolveAccessRole(existing, project.accessRole ?? 'owner');
      if (role !== 'reader' && existing.name !== safeFolderName) {
        await client.renameFile(existing.id, safeFolderName).catch(() => {});
      }
      return existing.id;
    }
  }
  const folder = await client.findOrCreateFolder(safeFolderName, rootFolderId);
  return folder.id;
}

export function mergeDeletedIds(a?: string[], b?: string[]): string[] {
  const set = new Set<string>([...(a ?? []), ...(b ?? [])]);
  return Array.from(set).sort();
}

function bookMetadataTieBreakKey(meta: {
  title: string;
  author?: string;
  narrator?: string;
  dedicatedTo?: string;
  description?: string;
  language?: string;
  tags?: string[];
  coverColor?: string;
}): string {
  return JSON.stringify([
    meta.title || '',
    meta.author || '',
    meta.narrator || '',
    meta.dedicatedTo || '',
    meta.description || '',
    meta.language || '',
    Array.isArray(meta.tags) ? meta.tags : [],
    meta.coverColor || '#9E4736',
  ]);
}

function recordingMetadataTieBreakKey(rec: {
  name: string;
  notes?: string;
  orderIndex: number;
  recordedBy?: string;
}): string {
  return JSON.stringify([
    rec.name || '',
    rec.notes || '',
    rec.orderIndex,
    rec.recordedBy || '',
  ]);
}

/**
 * Total-order Last-Write-Wins (LWW) comparator for book metadata.
 * Breaks equal-timestamp ties deterministically via lexicographical content order
 * so concurrent edits form a strict Join-Semilattice (Idempotent, Commutative, Associative).
 */
export function shouldPreferRemoteBookMeta(
  local: Pick<
    BookProject,
    'updatedAt' | 'title' | 'author' | 'narrator' | 'dedicatedTo' | 'description' | 'language' | 'tags' | 'coverColor'
  >,
  remote: Pick<
    DriveProjectMetadataFile,
    'updatedAt' | 'title' | 'author' | 'narrator' | 'dedicatedTo' | 'description' | 'language' | 'tags' | 'coverColor'
  >,
): boolean {
  if (remote.updatedAt !== local.updatedAt) {
    return remote.updatedAt > local.updatedAt;
  }
  return bookMetadataTieBreakKey(remote) > bookMetadataTieBreakKey(local);
}

/**
 * Total-order Last-Write-Wins (LWW) comparator for chapter recording metadata.
 * Breaks equal-timestamp ties deterministically so concurrent edits converge identically
 * regardless of sync interleaving order.
 */
export function shouldPreferRemoteRecordingMeta(
  local: Pick<Recording, 'updatedAt' | 'name' | 'notes' | 'orderIndex' | 'recordedBy'>,
  remote: Pick<Recording, 'updatedAt' | 'name' | 'notes' | 'orderIndex' | 'recordedBy'>,
): boolean {
  if (remote.updatedAt !== local.updatedAt) {
    return remote.updatedAt > local.updatedAt;
  }
  return recordingMetadataTieBreakKey(remote) > recordingMetadataTieBreakKey(local);
}

function buildMetadataPayload(
  project: BookProject,
  recordings: Recording[],
): DriveProjectMetadataFile {
  return {
    schemaVersion: 1,
    id: project.id,
    title: project.title,
    author: project.author,
    narrator: project.narrator,
    dedicatedTo: project.dedicatedTo,
    description: project.description,
    language: project.language,
    tags: project.tags,
    coverColor: project.coverColor,
    coverFileName: project.hasCover ? COVER_FILENAME : undefined,
    coverMimeType: project.coverMimeType,
    coverUpdatedAt: project.coverUpdatedAt,
    importedFrom: project.importedFrom,
    deletedRecordingIds: project.deletedRecordingIds?.length
      ? project.deletedRecordingIds
      : undefined,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    recordings: recordings.map((rec) => ({
      id: rec.id,
      sourceRecordingId: rec.sourceRecordingId,
      name: rec.name,
      notes: rec.notes,
      recordedBy: rec.recordedBy,
      orderIndex: rec.orderIndex,
      durationMs: rec.durationMs,
      mimeType: rec.mimeType,
      extension: rec.extension,
      sampleRate: rec.sampleRate,
      bitrateKbps: rec.bitrateKbps,
      bitDepth: rec.bitDepth,
      channels: rec.channels,
      deviceLabel: rec.deviceLabel,
      fileSizeBytes: rec.fileSizeBytes,
      peaks: rec.peaks,
      driveFileId: rec.driveFileId,
      driveFileName:
        rec.driveFileName ||
        buildChapterDriveFileName(rec.orderIndex, rec.name, rec.extension),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    })),
  };
}

/**
 * Pulls and merges a single book folder from Google Drive into local IndexedDB.
 * Uses chapter-level union merge by `recording.id` + deletion tombstones so two
 * co-narrators recording chapters concurrently never overwrite each other!
 */
export async function pullSingleBookFolderFromDrive(
  client: DriveClient,
  folder: DriveFileSummary,
  options?: {
    isShared?: boolean;
    defaultRole?: ShareAccessRole;
  },
): Promise<{ projectId: string | null; updated: boolean }> {
  const files = await client.listFolderChildren(folder.id);
  const metaFile = files.find((f) => f.name === PROJECT_METADATA_FILENAME);
  if (!metaFile) {
    recordSyncDebugEvent('sync', 'pull_book_skipped_no_manifest', {
      folderId: folder.id,
      folderName: folder.name,
      childCount: files.length,
    });
    return { projectId: null, updated: false };
  }

  let remoteMeta: DriveProjectMetadataFile;
  try {
    remoteMeta = await client.downloadJsonFile<DriveProjectMetadataFile>(
      metaFile.id,
    );
  } catch (err) {
    recordSyncDebugEvent('sync', 'pull_book_manifest_download_error', {
      folderId: folder.id,
      metaFileId: metaFile.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { projectId: null, updated: false };
  }

  if (!remoteMeta?.id || !remoteMeta?.title) {
    recordSyncDebugEvent('sync', 'pull_book_manifest_invalid', {
      folderId: folder.id,
      metaFileId: metaFile.id,
    });
    return { projectId: null, updated: false };
  }

  const existingLocal = await getProject(remoteMeta.id);
  const coverFile = files.find(
    (f) => f.name === (remoteMeta.coverFileName || COVER_FILENAME),
  );

  const detectedRole = resolveAccessRole(
    folder,
    options?.defaultRole ?? existingLocal?.accessRole ?? 'owner',
  );
  const isShared = Boolean(
    options?.isShared || folder.shared || folder.ownedByMe === false || existingLocal?.isShared,
  );
  const mergedDeletedIds = mergeDeletedIds(
    existingLocal?.deletedRecordingIds,
    remoteMeta.deletedRecordingIds,
  );
  const deletedSet = new Set(mergedDeletedIds);

  const shouldTakeRemoteBookMeta =
    !existingLocal || shouldPreferRemoteBookMeta(existingLocal, remoteMeta);

  let hasCover = existingLocal?.hasCover ?? Boolean(coverFile);
  let coverMimeType = existingLocal?.coverMimeType ?? remoteMeta.coverMimeType;
  let coverUpdatedAt = existingLocal?.coverUpdatedAt ?? remoteMeta.coverUpdatedAt;

  if (coverFile) {
    const remoteCoverTs = remoteMeta.coverUpdatedAt ?? 0;
    const localCoverTs = existingLocal?.coverUpdatedAt ?? 0;
    const needsCoverDownload =
      !existingLocal?.hasCover ||
      remoteCoverTs > localCoverTs ||
      (remoteCoverTs === localCoverTs &&
        coverFile.id > (existingLocal.driveCoverFileId ?? ''));
    if (needsCoverDownload) {
      try {
        const coverBlob = await client.downloadFileBlob(coverFile.id);
        await putProjectCover(remoteMeta.id, coverBlob);
        hasCover = true;
        coverMimeType = remoteMeta.coverMimeType || coverBlob.type || 'image/jpeg';
        coverUpdatedAt = remoteMeta.coverUpdatedAt ?? Date.now();
      } catch {
        hasCover = existingLocal?.hasCover ?? false;
      }
    }
  }

  let didUpdate = false;
  if (shouldTakeRemoteBookMeta) {
    const mergedProject: BookProject = {
      id: remoteMeta.id,
      title: remoteMeta.title,
      author: remoteMeta.author || '',
      narrator: remoteMeta.narrator || '',
      dedicatedTo: remoteMeta.dedicatedTo || '',
      description: remoteMeta.description || '',
      language: remoteMeta.language || '',
      tags: Array.isArray(remoteMeta.tags) ? remoteMeta.tags : [],
      coverColor: remoteMeta.coverColor || '#9E4736',
      hasCover,
      coverMimeType,
      coverUpdatedAt,
      driveFolderId: folder.id,
      driveMetadataFileId: metaFile.id,
      driveCoverFileId: coverFile?.id ?? existingLocal?.driveCoverFileId,
      isShared,
      accessRole: detectedRole,
      importedFrom: remoteMeta.importedFrom,
      deletedRecordingIds: mergedDeletedIds.length ? mergedDeletedIds : undefined,
      syncStatus:
        existingLocal?.syncStatus === 'pending_upload' && detectedRole !== 'reader'
          ? 'pending_upload'
          : 'synced',
      createdAt: remoteMeta.createdAt || existingLocal?.createdAt || Date.now(),
      updatedAt: remoteMeta.updatedAt || Date.now(),
    };
    await putProject(mergedProject);
    didUpdate = true;
  } else if (existingLocal) {
    // Keep local newer metadata, but always refresh Drive IDs, sharing role, and merged tombstones
    await putProject({
      ...existingLocal,
      driveFolderId: folder.id,
      driveMetadataFileId: metaFile.id,
      driveCoverFileId: coverFile?.id ?? existingLocal.driveCoverFileId,
      isShared,
      accessRole: detectedRole,
      deletedRecordingIds: mergedDeletedIds.length ? mergedDeletedIds : undefined,
    });
  }

  // Reconcile recordings: union merge by ID + apply tombstones
  const localRecs = await listProjectRecordings(remoteMeta.id);
  const localRecById = new Map(localRecs.map((r) => [r.id, r]));

  // Remove any local recordings deleted remotely
  for (const localRec of localRecs) {
    if (deletedSet.has(localRec.id)) {
      await deleteRecording(localRec.id);
      didUpdate = true;
    }
  }

  for (const remoteRec of remoteMeta.recordings ?? []) {
    if (deletedSet.has(remoteRec.id)) continue;

    const localRec = localRecById.get(remoteRec.id);
    if (!localRec) {
      const audioFile =
        files.find((f) => f.id === remoteRec.driveFileId) ||
        files.find((f) => f.name === remoteRec.driveFileName);

      const imported: Recording = {
        id: remoteRec.id,
        projectId: remoteMeta.id,
        sourceRecordingId: remoteRec.sourceRecordingId,
        name: remoteRec.name,
        notes: remoteRec.notes || '',
        recordedBy: remoteRec.recordedBy,
        orderIndex: remoteRec.orderIndex,
        durationMs: remoteRec.durationMs,
        mimeType: remoteRec.mimeType,
        extension: remoteRec.extension,
        sampleRate: remoteRec.sampleRate || 44100,
        bitrateKbps: remoteRec.bitrateKbps,
        bitDepth: remoteRec.bitDepth,
        channels: remoteRec.channels || 1,
        deviceLabel: remoteRec.deviceLabel,
        fileSizeBytes: remoteRec.fileSizeBytes || 0,
        peaks: Array.isArray(remoteRec.peaks) ? remoteRec.peaks : [],
        driveFileId: audioFile?.id || remoteRec.driveFileId,
        driveFileName: remoteRec.driveFileName,
        syncStatus: 'cloud_only',
        createdAt: remoteRec.createdAt || Date.now(),
        updatedAt: remoteRec.updatedAt || Date.now(),
      };
      await putRecording(imported);
      didUpdate = true;
    } else if (shouldPreferRemoteRecordingMeta(localRec, remoteRec)) {
      await putRecording({
        ...localRec,
        sourceRecordingId: remoteRec.sourceRecordingId ?? localRec.sourceRecordingId,
        name: remoteRec.name,
        notes: remoteRec.notes || '',
        recordedBy: remoteRec.recordedBy ?? localRec.recordedBy,
        orderIndex: remoteRec.orderIndex,
        driveFileId: remoteRec.driveFileId || localRec.driveFileId,
        driveFileName: remoteRec.driveFileName || localRec.driveFileName,
        updatedAt: remoteRec.updatedAt,
      });
      didUpdate = true;
    } else if (
      (!localRec.driveFileId && remoteRec.driveFileId) ||
      (!localRec.sourceRecordingId && remoteRec.sourceRecordingId)
    ) {
      await putRecording({
        ...localRec,
        driveFileId: localRec.driveFileId || remoteRec.driveFileId,
        sourceRecordingId: localRec.sourceRecordingId || remoteRec.sourceRecordingId,
      });
    }
  }

  return { projectId: remoteMeta.id, updated: didUpdate };
}

export async function pushProjectToDrive(
  client: DriveClient,
  projectId: string,
  rootFolderId: string,
  onProgress?: (update: SyncProgressUpdate) => void,
): Promise<{ pushedRecordings: number; skippedReadOnly?: boolean }> {
  const project = await getProject(projectId);
  if (!project) return { pushedRecordings: 0 };

  // Never attempt writes on a read-only Listener book
  if (project.accessRole === 'reader') {
    return { pushedRecordings: 0, skippedReadOnly: true };
  }

  onProgress?.({
    phase: 'pushing',
    message: `Syncing "${project.title}"…`,
  });

  const folderId = await ensureProjectFolder(client, project, rootFolderId);

  // Pull & merge remote metadata first if this folder already exists on Drive,
  // preventing concurrent multi-narrator overwrites!
  const existingFolderSummary = await client.verifyFileExists(folderId);
  if (existingFolderSummary) {
    const latestRole = resolveAccessRole(
      existingFolderSummary,
      project.accessRole ?? 'owner',
    );
    if (latestRole === 'reader') {
      await putProject({
        ...project,
        driveFolderId: folderId,
        accessRole: 'reader',
        isShared: true,
        syncStatus: 'synced',
      });
      return { pushedRecordings: 0, skippedReadOnly: true };
    }
    await pullSingleBookFolderFromDrive(client, existingFolderSummary, {
      isShared: project.isShared,
      defaultRole: latestRole,
    });
  }

  const freshProject = (await getProject(projectId)) ?? project;
  let updatedProject: BookProject = {
    ...freshProject,
    driveFolderId: folderId,
    syncStatus: 'uploading',
    syncError: undefined,
  };
  await putProject(updatedProject);

  // 1. Upload or update cover image if present locally
  if (updatedProject.hasCover) {
    const coverBlob = await getProjectCover(updatedProject.id);
    if (coverBlob) {
      const coverSummary = await client.uploadBinaryResumable(
        COVER_FILENAME,
        updatedProject.coverMimeType || 'image/jpeg',
        folderId,
        coverBlob,
        undefined,
        updatedProject.driveCoverFileId,
      );
      updatedProject = {
        ...updatedProject,
        driveCoverFileId: coverSummary.id,
      };
    }
  }

  // 2. Upload any local/pending recordings & keep Drive filenames in sync with order/title
  const recordings = await listProjectRecordings(updatedProject.id);
  const updatedRecordings: Recording[] = [];
  let pushedRecordings = 0;

  for (let i = 0; i < recordings.length; i += 1) {
    let rec = recordings[i];
    const desiredName = buildChapterDriveFileName(
      rec.orderIndex,
      rec.name,
      rec.extension,
    );

    if (
      rec.syncStatus === 'local_only' ||
      rec.syncStatus === 'pending_upload' ||
      rec.syncStatus === 'error' ||
      !rec.driveFileId
    ) {
      const blob = await getRecordingBlob(rec.id);
      if (blob) {
        onProgress?.({
          phase: 'pushing',
          message: `Uploading "${rec.name}"…`,
          current: i + 1,
          total: recordings.length,
        });

        await putRecording({ ...rec, syncStatus: 'uploading', syncError: undefined });

        try {
          const uploaded = await client.uploadBinaryResumable(
            desiredName,
            rec.mimeType,
            folderId,
            blob,
            undefined,
            rec.driveFileId,
          );
          rec = {
            ...rec,
            driveFileId: uploaded.id,
            driveFileName: desiredName,
            syncStatus: 'synced',
            syncError: undefined,
          };
          await putRecording(rec);
          pushedRecordings += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Upload failed';
          rec = { ...rec, syncStatus: 'error', syncError: msg };
          await putRecording(rec);
          throw err;
        }
      }
    } else if (rec.driveFileId && rec.driveFileName !== desiredName) {
      // Chapter was renamed or reordered — keep Drive filename neat
      await client.renameFile(rec.driveFileId, desiredName).catch(() => {});
      rec = { ...rec, driveFileName: desiredName };
      await putRecording(rec);
    }

    updatedRecordings.push(rec);
  }

  // 3. Upload/update merged project.json manifest inside the book folder
  const manifest = buildMetadataPayload(updatedProject, updatedRecordings);
  const metaSummary = await client.uploadJsonFile(
    PROJECT_METADATA_FILENAME,
    folderId,
    manifest,
    updatedProject.driveMetadataFileId,
  );

  updatedProject = {
    ...updatedProject,
    driveMetadataFileId: metaSummary.id,
    syncStatus: 'synced',
    syncError: undefined,
  };
  await putProject(updatedProject);

  return { pushedRecordings };
}

export async function pullRemoteProjectsFromDrive(
  client: DriveClient,
  rootFolderId: string,
  onProgress?: (update: SyncProgressUpdate) => void,
  options?: {
    isSharedLibrary?: boolean;
    rootRole?: ShareAccessRole;
    sharedBookFolders?: AppSettings['sharedBookFolders'];
  },
): Promise<{ pulledProjects: number }> {
  onProgress?.({
    phase: 'pulling',
    message: 'Checking Google Drive for updates & shared books…',
  });

  const children = await client.listFolderChildren(rootFolderId);
  const bookFolders = children.filter((c) => c.mimeType === FOLDER_MIME);
  recordSyncDebugEvent('sync', 'pull_root_children', {
    rootFolderId,
    isSharedLibrary: Boolean(options?.isSharedLibrary),
    rootRole: options?.rootRole,
    totalChildren: children.length,
    folderCount: bookFolders.length,
    linkedSharedBookCount: options?.sharedBookFolders?.length ?? 0,
  });
  const seenFolderIds = new Set<string>();
  let pulledProjects = 0;

  for (const folder of bookFolders) {
    seenFolderIds.add(folder.id);
    const res = await pullSingleBookFolderFromDrive(client, folder, {
      isShared: options?.isSharedLibrary || folder.shared || folder.ownedByMe === false,
      defaultRole: options?.rootRole,
    });
    if (res.updated) pulledProjects += 1;
  }

  // Also pull any individually linked Shared Books (added via book invite links)
  for (const link of options?.sharedBookFolders ?? []) {
    if (seenFolderIds.has(link.folderId)) continue;
    try {
      const folder = await client.verifyFileExists(link.folderId);
      if (!folder || folder.mimeType !== FOLDER_MIME) {
        recordSyncDebugEvent('sync', 'pull_linked_book_missing', {
          folderId: link.folderId,
          title: link.title,
        });
        continue;
      }
      seenFolderIds.add(folder.id);
      const res = await pullSingleBookFolderFromDrive(client, folder, {
        isShared: true,
        defaultRole: link.role,
      });
      if (res.updated) pulledProjects += 1;
    } catch (err) {
      recordSyncDebugEvent('sync', 'pull_linked_book_error', {
        folderId: link.folderId,
        title: link.title,
        error: err instanceof Error ? err.message : String(err),
      });
      // Skip inaccessible individual shared book without breaking overall sync
    }
  }

  return { pulledProjects };
}

function isSameUserEmail(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

/**
 * Copies a file inside Google Drive server-side (`files.copy`) to avoid wasting
 * mobile upload bandwidth, falling back to download + resumable upload if server-side
 * copy is rejected (e.g., copy restriction on an upstream file).
 */
async function copyDriveFileWithFallback(
  client: DriveClient,
  sourceFileId: string,
  name: string,
  mimeType: string,
  destParentId: string,
): Promise<DriveFileSummary> {
  try {
    return await client.copyFile(sourceFileId, name, destParentId);
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 401) {
      throw err;
    }
    const blob = await client.downloadFileBlob(sourceFileId);
    return client.uploadBinaryResumable(
      name,
      mimeType || blob.type || 'application/octet-stream',
      destParentId,
      blob,
    );
  }
}

export interface MirrorImportResult {
  updated: boolean;
  copiedChapters: number;
  removedChapters: number;
  sourceUnavailable?: boolean;
}

/**
 * Pull-mirrors upstream changes from `project.importedFrom.folderId` into this
 * library's own copied book folder (`project.driveFolderId`).
 *
 * Invariants (ADR-06):
 * - NEVER writes to `importedFrom.folderId`.
 * - Non-importer family members (`importedByEmail` mismatch) silently skip upstream checks.
 * - If upstream returns 403/404, marks `sourceUnavailable: true` locally and preserves
 *   the copied book and all chapters 100% intact.
 */
export async function mirrorImportedBookFromSource(
  client: DriveClient,
  project: BookProject,
  options?: {
    currentUserEmail?: string | null;
    onProgress?: (update: SyncProgressUpdate) => void;
  },
): Promise<MirrorImportResult> {
  const source = project.importedFrom;
  if (!source?.folderId || !project.driveFolderId || project.accessRole === 'reader') {
    return { updated: false, copiedChapters: 0, removedChapters: 0 };
  }

  // Non-importer family members simply consume the real copied files inside the shared library
  if (
    source.importedByEmail &&
    options?.currentUserEmail &&
    !isSameUserEmail(source.importedByEmail, options.currentUserEmail)
  ) {
    return { updated: false, copiedChapters: 0, removedChapters: 0 };
  }

  const markSourceUnavailable = async (): Promise<MirrorImportResult> => {
    if (!source.sourceUnavailable) {
      await putProject({
        ...project,
        importedFrom: {
          ...source,
          sourceUnavailable: true,
        },
      });
    }
    return {
      updated: false,
      copiedChapters: 0,
      removedChapters: 0,
      sourceUnavailable: true,
    };
  };

  let sourceFolder: DriveFileSummary | null;
  try {
    sourceFolder = await client.verifyFileExists(source.folderId);
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 401) throw err;
    if (err instanceof DriveApiError && (err.status === 403 || err.status === 404)) {
      return markSourceUnavailable();
    }
    throw err;
  }
  if (!sourceFolder) {
    return markSourceUnavailable();
  }

  let sourceFiles: DriveFileSummary[];
  let sourceMeta: DriveProjectMetadataFile;
  try {
    sourceFiles = await client.listFolderChildren(sourceFolder.id);
    const metaFile = sourceFiles.find((f) => f.name === PROJECT_METADATA_FILENAME);
    if (!metaFile) return markSourceUnavailable();
    sourceMeta = await client.downloadJsonFile<DriveProjectMetadataFile>(metaFile.id);
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 401) throw err;
    if (err instanceof DriveApiError && (err.status === 403 || err.status === 404)) {
      return markSourceUnavailable();
    }
    return markSourceUnavailable();
  }

  if (!sourceMeta?.id || !sourceMeta?.title) {
    return markSourceUnavailable();
  }

  // Pull our own destination folder first so we never clobber concurrent family state (e.g., detach)
  const destFolder = await client.verifyFileExists(project.driveFolderId);
  if (destFolder) {
    await pullSingleBookFolderFromDrive(client, destFolder, {
      isShared: project.isShared,
      defaultRole: project.accessRole,
    });
  }

  const freshProject = (await getProject(project.id)) ?? project;
  if (!freshProject.importedFrom?.folderId || !freshProject.driveFolderId) {
    return { updated: false, copiedChapters: 0, removedChapters: 0 };
  }

  const destFolderId = freshProject.driveFolderId;
  let didChange = false;
  let nextProject: BookProject = { ...freshProject };

  // 1. Mirror updated book metadata if upstream is newer
  if (sourceMeta.updatedAt > freshProject.updatedAt) {
    const safeNewTitle = sanitizeFileName(sourceMeta.title, 'Imported Book');
    if (sourceMeta.title !== freshProject.title) {
      await client.renameFile(destFolderId, safeNewTitle).catch(() => {});
    }
    nextProject = {
      ...nextProject,
      title: sourceMeta.title,
      author: sourceMeta.author || '',
      narrator: sourceMeta.narrator || '',
      dedicatedTo: sourceMeta.dedicatedTo || '',
      description: sourceMeta.description || '',
      language: sourceMeta.language || '',
      tags: Array.isArray(sourceMeta.tags) ? sourceMeta.tags : [],
      coverColor: sourceMeta.coverColor || '#9E4736',
    };
    didChange = true;
  }

  // 2. Mirror cover image if added or updated upstream
  const sourceCoverFile = sourceFiles.find(
    (f) => f.name === (sourceMeta.coverFileName || COVER_FILENAME),
  );
  if (sourceCoverFile) {
    const remoteCoverTs = sourceMeta.coverUpdatedAt ?? 0;
    const localCoverTs = freshProject.coverUpdatedAt ?? 0;
    if (!freshProject.hasCover || remoteCoverTs > localCoverTs) {
      try {
        const copiedCover = await copyDriveFileWithFallback(
          client,
          sourceCoverFile.id,
          COVER_FILENAME,
          sourceMeta.coverMimeType || 'image/jpeg',
          destFolderId,
        );
        try {
          const coverBlob = await client.downloadFileBlob(sourceCoverFile.id);
          await putProjectCover(freshProject.id, coverBlob);
        } catch {
          // Local cover cache is best-effort; Drive copy succeeded
        }
        nextProject = {
          ...nextProject,
          hasCover: true,
          coverMimeType: sourceMeta.coverMimeType || 'image/jpeg',
          coverUpdatedAt: sourceMeta.coverUpdatedAt ?? Date.now(),
          driveCoverFileId: copiedCover.id,
        };
        didChange = true;
      } catch (err) {
        if (err instanceof DriveApiError && err.status === 401) throw err;
      }
    }
  }

  // 3. Reconcile chapters by sourceRecordingId (delta copy + metadata updates + upstream tombstones)
  const localRecs = await listProjectRecordings(freshProject.id);
  const localBySourceId = new Map<string, Recording>();
  for (const r of localRecs) {
    if (r.sourceRecordingId) {
      localBySourceId.set(r.sourceRecordingId, r);
    }
  }

  const sourceDeletedSet = new Set(sourceMeta.deletedRecordingIds ?? []);
  let mergedDeletedIds = freshProject.deletedRecordingIds ?? [];
  let removedChapters = 0;

  for (const localRec of localRecs) {
    if (localRec.sourceRecordingId && sourceDeletedSet.has(localRec.sourceRecordingId)) {
      await deleteRecording(localRec.id);
      if (localRec.driveFileId) {
        await client.trashFile(localRec.driveFileId).catch(() => {});
      }
      mergedDeletedIds = mergeDeletedIds(mergedDeletedIds, [localRec.id]);
      localBySourceId.delete(localRec.sourceRecordingId);
      removedChapters += 1;
      didChange = true;
    }
  }

  const activeSourceRecs = (sourceMeta.recordings ?? [])
    .filter((r) => !sourceDeletedSet.has(r.id))
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex);

  let copiedChapters = 0;
  for (let i = 0; i < activeSourceRecs.length; i += 1) {
    const srcRec = activeSourceRecs[i];
    const existingLocalRec = localBySourceId.get(srcRec.id);
    const desiredName = buildChapterDriveFileName(
      srcRec.orderIndex,
      srcRec.name,
      srcRec.extension,
    );

    if (!existingLocalRec) {
      const srcAudioFile =
        sourceFiles.find((f) => f.id === srcRec.driveFileId) ||
        sourceFiles.find((f) => f.name === srcRec.driveFileName);
      if (!srcAudioFile) continue;

      options?.onProgress?.({
        phase: 'pulling',
        message: `Mirroring "${srcRec.name}"…`,
        current: i + 1,
        total: activeSourceRecs.length,
      });

      const copiedAudio = await copyDriveFileWithFallback(
        client,
        srcAudioFile.id,
        desiredName,
        srcRec.mimeType,
        destFolderId,
      );

      const copiedRec: Recording = {
        id: createId('rec'),
        projectId: freshProject.id,
        sourceRecordingId: srcRec.id,
        name: srcRec.name,
        notes: srcRec.notes || '',
        recordedBy: srcRec.recordedBy,
        orderIndex: srcRec.orderIndex,
        durationMs: srcRec.durationMs,
        mimeType: srcRec.mimeType,
        extension: srcRec.extension,
        sampleRate: srcRec.sampleRate || 44100,
        bitrateKbps: srcRec.bitrateKbps,
        bitDepth: srcRec.bitDepth,
        channels: srcRec.channels || 1,
        deviceLabel: srcRec.deviceLabel,
        fileSizeBytes: srcRec.fileSizeBytes || 0,
        peaks: Array.isArray(srcRec.peaks) ? srcRec.peaks : [],
        driveFileId: copiedAudio.id,
        driveFileName: desiredName,
        syncStatus: 'cloud_only',
        createdAt: srcRec.createdAt || Date.now(),
        updatedAt: srcRec.updatedAt || Date.now(),
      };
      await putRecording(copiedRec);
      copiedChapters += 1;
      didChange = true;
    } else if (shouldPreferRemoteRecordingMeta(existingLocalRec, srcRec)) {
      if (existingLocalRec.driveFileId && existingLocalRec.driveFileName !== desiredName) {
        await client.renameFile(existingLocalRec.driveFileId, desiredName).catch(() => {});
      }
      await putRecording({
        ...existingLocalRec,
        name: srcRec.name,
        notes: srcRec.notes || '',
        recordedBy: srcRec.recordedBy ?? existingLocalRec.recordedBy,
        orderIndex: srcRec.orderIndex,
        driveFileName: desiredName,
        updatedAt: srcRec.updatedAt,
      });
      didChange = true;
    }
  }

  const now = Date.now();
  const nextImportedFrom: ImportedBookSource = {
    ...freshProject.importedFrom,
    sourceTitle: sourceMeta.title,
    sourceProjectId: sourceMeta.id,
    lastMirrorSyncAt: now,
    sourceUnavailable: false,
  };

  if (didChange || freshProject.importedFrom.sourceUnavailable) {
    const finalRecs = await listProjectRecordings(freshProject.id);
    const updatedProject: BookProject = {
      ...nextProject,
      importedFrom: nextImportedFrom,
      deletedRecordingIds: mergedDeletedIds.length ? mergedDeletedIds : undefined,
      syncStatus: 'synced',
      syncError: undefined,
      updatedAt: didChange
        ? Math.max(freshProject.updatedAt + 1, sourceMeta.updatedAt, now)
        : freshProject.updatedAt,
    };

    const manifest = buildMetadataPayload(updatedProject, finalRecs);
    const metaSummary = await client.uploadJsonFile(
      PROJECT_METADATA_FILENAME,
      destFolderId,
      manifest,
      updatedProject.driveMetadataFileId,
    );

    await putProject({
      ...updatedProject,
      driveMetadataFileId: metaSummary.id,
    });
  } else {
    await putProject({
      ...freshProject,
      importedFrom: nextImportedFrom,
    });
  }

  return {
    updated: didChange,
    copiedChapters,
    removedChapters,
    sourceUnavailable: false,
  };
}

export interface ImportBookResult {
  rootFolderId: string;
  projectId: string;
  title: string;
  copiedChapters: number;
  alreadyExisted: boolean;
}

/**
 * Imports a shared book from another user's Drive folder as a real copied subfolder
 * inside the signed-in user's own Drive library root, recording `importedFrom` so
 * family library co-narrators automatically receive the book and future chapter updates
 * mirror cleanly whenever the importer syncs.
 */
export async function importSharedBookIntoLibrary(
  sourceFolderId: string,
  settings: AppSettings,
  options?: {
    currentUserEmail?: string | null;
    onProgress?: (update: SyncProgressUpdate) => void;
    clientOverride?: DriveClient;
  },
): Promise<ImportBookResult> {
  return withAuthorizedClient(options?.clientOverride, async (client) => {
    const onProgress = options?.onProgress;
    onProgress?.({
      phase: 'connecting',
      message: 'Checking shared book…',
    });

    const root = await ensureRootFolder(client, settings);
    if (root.role === 'reader') {
      throw new Error(
        'Your active library is read-only. Switch to a writable library to import a copy.',
      );
    }

    const sourceFolder = await client.verifyFileExists(sourceFolderId);
    if (!sourceFolder) {
      throw new DriveApiError(
        404,
        'StoryTape does not have permission to view this folder yet.',
      );
    }

    const sourceFiles = await client.listFolderChildren(sourceFolder.id);
    const metaFile = sourceFiles.find((f) => f.name === PROJECT_METADATA_FILENAME);
    if (!metaFile) {
      throw new Error('This Google Drive folder does not contain a StoryTape book.');
    }

    let sourceMeta: DriveProjectMetadataFile;
    try {
      sourceMeta = await client.downloadJsonFile<DriveProjectMetadataFile>(metaFile.id);
    } catch {
      throw new Error('Could not read book metadata from the shared folder.');
    }
    if (!sourceMeta?.id || !sourceMeta?.title) {
      throw new Error('The shared book metadata is incomplete.');
    }

    const currentUserEmail =
      options?.currentUserEmail !== undefined
        ? options.currentUserEmail
        : googleAuth.getState().userEmail;

    // Pull existing root library first so deduplication sees books already imported on another device
    await pullRemoteProjectsFromDrive(client, root.id, undefined, {
      isSharedLibrary: settings.driveLibraryMode === 'shared',
      rootRole: root.role,
    });

    const existingProjects = await listProjects();
    const sameDriveBook = existingProjects.find(
      (p) => p.driveFolderId === sourceFolder.id,
    );
    if (sameDriveBook) {
      return {
        rootFolderId: root.id,
        projectId: sameDriveBook.id,
        title: sameDriveBook.title,
        copiedChapters: 0,
        alreadyExisted: true,
      };
    }

    const existingImport = existingProjects.find(
      (p) => p.importedFrom?.folderId === sourceFolder.id,
    );
    if (existingImport) {
      const mirrorRes = await mirrorImportedBookFromSource(client, existingImport, {
        currentUserEmail,
        onProgress,
      });
      return {
        rootFolderId: root.id,
        projectId: existingImport.id,
        title: existingImport.title,
        copiedChapters: mirrorRes.copiedChapters,
        alreadyExisted: true,
      };
    }

    onProgress?.({
      phase: 'pushing',
      message: `Importing "${sourceMeta.title}" into your library…`,
    });

    const safeFolderName = sanitizeFileName(sourceMeta.title, 'Imported Book');
    const destFolder = await client.createFolder(safeFolderName, root.id);
    const newProjectId = createId('book');
    const now = Date.now();

    // 1. Copy cover image if present
    let hasCover = false;
    let coverMimeType: string | undefined;
    let coverUpdatedAt: number | undefined;
    let driveCoverFileId: string | undefined;

    const sourceCoverFile = sourceFiles.find(
      (f) => f.name === (sourceMeta.coverFileName || COVER_FILENAME),
    );
    if (sourceCoverFile) {
      try {
        const copiedCover = await copyDriveFileWithFallback(
          client,
          sourceCoverFile.id,
          COVER_FILENAME,
          sourceMeta.coverMimeType || 'image/jpeg',
          destFolder.id,
        );
        driveCoverFileId = copiedCover.id;
        hasCover = true;
        coverMimeType = sourceMeta.coverMimeType || 'image/jpeg';
        coverUpdatedAt = sourceMeta.coverUpdatedAt ?? now;
        try {
          const coverBlob = await client.downloadFileBlob(sourceCoverFile.id);
          await putProjectCover(newProjectId, coverBlob);
        } catch {
          // Best-effort local cover cache
        }
      } catch (err) {
        if (err instanceof DriveApiError && err.status === 401) throw err;
      }
    }

    // 2. Copy all non-deleted audio chapters server-side into destination book folder
    const sourceDeletedSet = new Set(sourceMeta.deletedRecordingIds ?? []);
    const activeSourceRecs = (sourceMeta.recordings ?? [])
      .filter((r) => !sourceDeletedSet.has(r.id))
      .slice()
      .sort((a, b) => a.orderIndex - b.orderIndex);

    const copiedRecordings: Recording[] = [];
    for (let i = 0; i < activeSourceRecs.length; i += 1) {
      const srcRec = activeSourceRecs[i];
      const srcAudioFile =
        sourceFiles.find((f) => f.id === srcRec.driveFileId) ||
        sourceFiles.find((f) => f.name === srcRec.driveFileName);
      if (!srcAudioFile) continue;

      const desiredName = buildChapterDriveFileName(
        srcRec.orderIndex,
        srcRec.name,
        srcRec.extension,
      );

      onProgress?.({
        phase: 'pushing',
        message: `Copying "${srcRec.name}"…`,
        current: i + 1,
        total: activeSourceRecs.length,
      });

      const copiedAudio = await copyDriveFileWithFallback(
        client,
        srcAudioFile.id,
        desiredName,
        srcRec.mimeType,
        destFolder.id,
      );

      const rec: Recording = {
        id: createId('rec'),
        projectId: newProjectId,
        sourceRecordingId: srcRec.id,
        name: srcRec.name,
        notes: srcRec.notes || '',
        recordedBy: srcRec.recordedBy,
        orderIndex: srcRec.orderIndex,
        durationMs: srcRec.durationMs,
        mimeType: srcRec.mimeType,
        extension: srcRec.extension,
        sampleRate: srcRec.sampleRate || 44100,
        bitrateKbps: srcRec.bitrateKbps,
        bitDepth: srcRec.bitDepth,
        channels: srcRec.channels || 1,
        deviceLabel: srcRec.deviceLabel,
        fileSizeBytes: srcRec.fileSizeBytes || 0,
        peaks: Array.isArray(srcRec.peaks) ? srcRec.peaks : [],
        driveFileId: copiedAudio.id,
        driveFileName: desiredName,
        syncStatus: 'cloud_only',
        createdAt: srcRec.createdAt || now,
        updatedAt: srcRec.updatedAt || now,
      };
      copiedRecordings.push(rec);
    }

    const importedFrom: ImportedBookSource = {
      folderId: sourceFolder.id,
      sourceTitle: sourceMeta.title,
      sourceProjectId: sourceMeta.id,
      importedByEmail: currentUserEmail ?? undefined,
      importedAt: now,
      lastMirrorSyncAt: now,
      sourceUnavailable: false,
    };

    let newProject: BookProject = {
      id: newProjectId,
      title: sourceMeta.title,
      author: sourceMeta.author || '',
      narrator: sourceMeta.narrator || '',
      dedicatedTo: sourceMeta.dedicatedTo || '',
      description: sourceMeta.description || '',
      language: sourceMeta.language || '',
      tags: Array.isArray(sourceMeta.tags) ? sourceMeta.tags : [],
      coverColor: sourceMeta.coverColor || '#9E4736',
      hasCover,
      coverMimeType,
      coverUpdatedAt,
      driveFolderId: destFolder.id,
      driveCoverFileId,
      isShared: settings.driveLibraryMode === 'shared',
      accessRole: root.role,
      importedFrom,
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: Math.max(now, sourceMeta.updatedAt || now),
    };

    const manifest = buildMetadataPayload(newProject, copiedRecordings);
    const metaSummary = await client.uploadJsonFile(
      PROJECT_METADATA_FILENAME,
      destFolder.id,
      manifest,
    );

    newProject = {
      ...newProject,
      driveMetadataFileId: metaSummary.id,
    };

    await putProject(newProject);
    for (const rec of copiedRecordings) {
      await putRecording(rec);
    }

    onProgress?.({
      phase: 'done',
      message: `Imported "${newProject.title}" into your library.`,
    });

    return {
      rootFolderId: root.id,
      projectId: newProject.id,
      title: newProject.title,
      copiedChapters: copiedRecordings.length,
      alreadyExisted: false,
    };
  });
}

export function isUnsharedPersonalBook(project: BookProject): boolean {
  return project.accessRole !== 'reader' && project.isShared !== true;
}

export interface ShareLocalBooksResult {
  sharedProjects: number;
  sharedRecordings: number;
  errors: string[];
}

/**
 * Explicitly copies/uploads selected unshared personal books into the active
 * writable shared library folder so all family collaborators see them immediately,
 * while leaving any prior personal Drive backup folders untouched.
 */
export async function shareLocalBooksIntoSharedLibrary(
  projectIds: string[],
  settings: AppSettings,
  options?: {
    onProgress?: (update: SyncProgressUpdate) => void;
    clientOverride?: DriveClient;
  },
): Promise<ShareLocalBooksResult> {
  return withAuthorizedClient(options?.clientOverride, async (client) => {
    const onProgress = options?.onProgress;
    const errors: string[] = [];
    let sharedProjects = 0;
    let sharedRecordings = 0;

    if (settings.driveLibraryMode !== 'shared' || !settings.driveRootFolderId) {
      throw new Error('Connect to a shared library before sharing personal books into it.');
    }

    onProgress?.({
      phase: 'connecting',
      message: 'Checking shared library folder…',
    });

    const root = await ensureRootFolder(client, settings);
    if (root.role === 'reader') {
      throw new Error('This shared library is read-only (Listener access).');
    }

    for (const projectId of projectIds) {
      const project = await getProject(projectId);
      if (!project || project.accessRole === 'reader') continue;

      try {
        // If the book's Drive folder is already directly inside the shared root,
        // just mark it shared and run normal push sync.
        if (project.driveFolderId) {
          const existingFolder = await client.verifyFileExists(project.driveFolderId);
          if (existingFolder?.parents?.includes(root.id)) {
            await putProject({
              ...project,
              isShared: true,
              accessRole: root.role,
            });
            const pushed = await pushProjectToDrive(
              client,
              project.id,
              root.id,
              onProgress,
            );
            sharedProjects += 1;
            sharedRecordings += pushed.pushedRecordings;
            continue;
          }
        }

        const safeFolderName = sanitizeFileName(project.title, 'Untitled Book');
        onProgress?.({
          phase: 'pushing',
          message: `Sharing "${project.title}"…`,
        });

        let destFolder: DriveFileSummary | null = null;
        const candidate = await client.findFolderByName(safeFolderName, root.id);
        if (candidate) {
          const candidateChildren = await client.listFolderChildren(candidate.id);
          const candidateMetaFile = candidateChildren.find(
            (f) => f.name === PROJECT_METADATA_FILENAME,
          );
          if (candidateMetaFile) {
            try {
              const candidateMeta =
                await client.downloadJsonFile<DriveProjectMetadataFile>(
                  candidateMetaFile.id,
                );
              if (candidateMeta?.id === project.id) {
                destFolder = candidate;
              }
            } catch {
              // Ignore unreadable manifest and create a fresh folder
            }
          } else if (candidateChildren.length === 0) {
            destFolder = candidate;
          }
        }
        if (!destFolder) {
          destFolder = await client.createFolder(safeFolderName, root.id);
        }

        // 1. Copy or upload cover image into the shared book subfolder
        let nextDriveCoverFileId: string | undefined;
        if (project.hasCover) {
          if (project.driveCoverFileId) {
            try {
              const copiedCover = await copyDriveFileWithFallback(
                client,
                project.driveCoverFileId,
                COVER_FILENAME,
                project.coverMimeType || 'image/jpeg',
                destFolder.id,
              );
              nextDriveCoverFileId = copiedCover.id;
            } catch (err) {
              if (err instanceof DriveApiError && err.status === 401) throw err;
            }
          }
          if (!nextDriveCoverFileId) {
            const coverBlob = await getProjectCover(project.id);
            if (coverBlob) {
              const uploadedCover = await client.uploadBinaryResumable(
                COVER_FILENAME,
                project.coverMimeType || 'image/jpeg',
                destFolder.id,
                coverBlob,
              );
              nextDriveCoverFileId = uploadedCover.id;
            }
          }
        }

        // 2. Copy server-side (or upload from IndexedDB) each chapter audio file
        const recordings = await listProjectRecordings(project.id);
        const updatedRecordings: Recording[] = [];
        let bookSharedRecs = 0;

        for (let i = 0; i < recordings.length; i += 1) {
          const rec = recordings[i];
          const desiredName = buildChapterDriveFileName(
            rec.orderIndex,
            rec.name,
            rec.extension,
          );

          onProgress?.({
            phase: 'pushing',
            message: `Sharing "${rec.name}"…`,
            current: i + 1,
            total: recordings.length,
          });

          let newFile: DriveFileSummary | null = null;
          if (
            rec.driveFileId &&
            (rec.syncStatus === 'synced' || rec.syncStatus === 'cloud_only')
          ) {
            try {
              newFile = await copyDriveFileWithFallback(
                client,
                rec.driveFileId,
                desiredName,
                rec.mimeType,
                destFolder.id,
              );
            } catch (err) {
              if (err instanceof DriveApiError && err.status === 401) throw err;
            }
          }

          const localBlob = await getRecordingBlob(rec.id);
          if (!newFile && localBlob) {
            newFile = await client.uploadBinaryResumable(
              desiredName,
              rec.mimeType,
              destFolder.id,
              localBlob,
            );
          }

          if (newFile) {
            const updatedRec: Recording = {
              ...rec,
              driveFileId: newFile.id,
              driveFileName: desiredName,
              syncStatus: localBlob ? 'synced' : 'cloud_only',
              syncError: undefined,
            };
            await putRecording(updatedRec);
            updatedRecordings.push(updatedRec);
            bookSharedRecs += 1;
          } else {
            updatedRecordings.push(rec);
          }
        }

        // 3. Write a fresh project.json manifest inside the shared subfolder
        const now = Date.now();
        let updatedProject: BookProject = {
          ...project,
          driveFolderId: destFolder.id,
          driveCoverFileId: nextDriveCoverFileId,
          isShared: true,
          accessRole: root.role,
          syncStatus: 'synced',
          syncError: undefined,
          updatedAt: Math.max(project.updatedAt, now),
        };

        const manifest = buildMetadataPayload(updatedProject, updatedRecordings);
        const metaSummary = await client.uploadJsonFile(
          PROJECT_METADATA_FILENAME,
          destFolder.id,
          manifest,
        );

        updatedProject = {
          ...updatedProject,
          driveMetadataFileId: metaSummary.id,
        };
        await putProject(updatedProject);

        sharedProjects += 1;
        sharedRecordings += bookSharedRecs;
        recordSyncDebugEvent('share', 'share_local_book_success', {
          projectId: updatedProject.id,
          title: updatedProject.title,
          destFolderId: destFolder.id,
          sharedChapters: bookSharedRecs,
        });
      } catch (err) {
        if (err instanceof DriveApiError && err.status === 401) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${project.title}: ${msg}`);
        recordSyncDebugEvent('share', 'share_local_book_error', {
          projectId: project.id,
          title: project.title,
          error: msg,
        });
      }
    }

    onProgress?.({
      phase: 'done',
      message:
        sharedProjects > 0
          ? `Shared ${sharedProjects} ${sharedProjects === 1 ? 'book' : 'books'} into your shared library.`
          : 'No personal books were shared.',
    });

    return {
      sharedProjects,
      sharedRecordings,
      errors,
    };
  });
}

export function trashDriveFolder(
  folderId: string,
  clientOverride?: DriveClient,
): Promise<void> {
  return withAuthorizedClient(clientOverride, (client) =>
    client.trashFile(folderId),
  );
}

export async function syncAllWithDrive(
  settings: AppSettings,
  onProgress?: (update: SyncProgressUpdate) => void,
  clientOverride?: DriveClient,
): Promise<SyncResult> {
  return withAuthorizedClient(clientOverride, async (client) => {
    const errors: string[] = [];

    onProgress?.({
      phase: 'connecting',
      message: 'Connecting to Google Drive…',
    });

    const root = await ensureRootFolder(client, settings);
    const isSharedLibrary = settings.driveLibraryMode === 'shared';

    // 1. PULL & MERGE FIRST so collaborator changes & new chapters are always preserved!
    let { pulledProjects } = await pullRemoteProjectsFromDrive(
      client,
      root.id,
      onProgress,
      {
        isSharedLibrary,
        rootRole: root.role,
        sharedBookFolders: settings.sharedBookFolders,
      },
    );

    // 1.5. MIRROR UPSTREAM UPDATES for imported books (non-importer family members skip silently)
    const currentUserEmail = googleAuth.getState().userEmail;
    const projectsAfterPull = await listProjects();
    for (const project of projectsAfterPull) {
      if (
        !project.importedFrom?.folderId ||
        !project.driveFolderId ||
        project.accessRole === 'reader'
      ) {
        continue;
      }
      try {
        const mirrorRes = await mirrorImportedBookFromSource(client, project, {
          currentUserEmail,
          onProgress,
        });
        if (mirrorRes.updated) {
          pulledProjects += 1;
        }
      } catch (err) {
        if (err instanceof DriveApiError && err.status === 401) {
          throw err;
        }
        // Never break overall library sync if an external source book is temporarily unreachable
      }
    }

    // 2. PUSH local writable projects (skipping read-only Listener books, unshared personal books
    // while connected to a shared library, and already-synced mirrored imports)
    const localProjects = await listProjects();
    let pushedProjects = 0;
    let pushedRecordings = 0;

    for (const project of localProjects) {
      if (project.accessRole === 'reader') continue;
      if (root.role === 'reader' && !project.driveFolderId) continue;
      if (isSharedLibrary && isUnsharedPersonalBook(project)) continue;
      if (project.importedFrom && project.syncStatus === 'synced') continue;

      try {
        const res = await pushProjectToDrive(
          client,
          project.id,
          root.id,
          onProgress,
        );
        if (!res.skippedReadOnly) {
          pushedProjects += 1;
          pushedRecordings += res.pushedRecordings;
        }
      } catch (err) {
        if (err instanceof DriveApiError && err.status === 401) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${project.title}: ${msg}`);
        await putProject({
          ...project,
          syncStatus: 'error',
          syncError: msg,
        });
      }
    }

    onProgress?.({ phase: 'done', message: 'Google Drive is up to date.' });

    return {
      rootFolderId: root.id,
      rootAccessRole: root.role,
      pushedProjects,
      pushedRecordings,
      pulledProjects,
      errors,
    };
  });
}

export async function syncSingleProjectWithDrive(
  projectId: string,
  settings: AppSettings,
  onProgress?: (update: SyncProgressUpdate) => void,
  clientOverride?: DriveClient,
): Promise<{
  rootFolderId: string;
  pushedRecordings: number;
  mirroredChapters?: number;
  sourceUnavailable?: boolean;
}> {
  return withAuthorizedClient(clientOverride, async (client) => {
    const project = await getProject(projectId);
    const root = await ensureRootFolder(client, settings);

    if (project?.accessRole === 'reader' && project.driveFolderId) {
      const folder = await client.verifyFileExists(project.driveFolderId);
      if (folder) {
        await pullSingleBookFolderFromDrive(client, folder, {
          isShared: true,
          defaultRole: 'reader',
        });
      }
      onProgress?.({ phase: 'done', message: 'Refreshed shared book from Drive.' });
      return { rootFolderId: root.id, pushedRecordings: 0 };
    }

    if (project?.importedFrom?.folderId && project.driveFolderId) {
      const mirrorRes = await mirrorImportedBookFromSource(client, project, {
        currentUserEmail: googleAuth.getState().userEmail,
        onProgress,
      });
      onProgress?.({
        phase: 'done',
        message: mirrorRes.sourceUnavailable
          ? 'Original source is unavailable; your local copy is safe.'
          : mirrorRes.copiedChapters > 0
            ? `Mirrored ${mirrorRes.copiedChapters} new chapter${mirrorRes.copiedChapters === 1 ? '' : 's'}.`
            : 'Imported book is up to date.',
      });
      return {
        rootFolderId: root.id,
        pushedRecordings: 0,
        mirroredChapters: mirrorRes.copiedChapters,
        sourceUnavailable: mirrorRes.sourceUnavailable,
      };
    }

    if (
      settings.driveLibraryMode === 'shared' &&
      project &&
      isUnsharedPersonalBook(project) &&
      !project.driveFolderId
    ) {
      onProgress?.({
        phase: 'done',
        message: 'Personal book kept private (not shared to family library).',
      });
      return { rootFolderId: root.id, pushedRecordings: 0 };
    }

    const { pushedRecordings } = await pushProjectToDrive(
      client,
      projectId,
      root.id,
      onProgress,
    );
    onProgress?.({ phase: 'done', message: 'Synced to Google Drive.' });
    return { rootFolderId: root.id, pushedRecordings };
  });
}

/**
 * Ensures the library root folder exists on Drive so it can be shared immediately.
 */
export async function ensureShareableLibraryFolder(
  settings: AppSettings,
  clientOverride?: DriveClient,
): Promise<{ folderId: string; folderName: string; accessRole: ShareAccessRole }> {
  return withAuthorizedClient(clientOverride, async (client) => {
    const root = await ensureRootFolder(client, settings);
    return {
      folderId: root.id,
      folderName: root.name,
      accessRole: root.role,
    };
  });
}

/**
 * Ensures a specific book has been synced to a Drive folder so it can be shared immediately.
 */
export async function ensureShareableBookFolder(
  projectId: string,
  settings: AppSettings,
  clientOverride?: DriveClient,
): Promise<{ rootFolderId: string; folderId: string; title: string }> {
  return withAuthorizedClient(clientOverride, async (client) => {
    const existing = await getProject(projectId);
    if (!existing) throw new Error('Book not found.');
    if (existing.driveFolderId) {
      const verified = await client.verifyFileExists(existing.driveFolderId);
      if (verified) {
        return {
          rootFolderId: settings.driveRootFolderId || '',
          folderId: verified.id,
          title: existing.title,
        };
      }
    }
    const root = await ensureRootFolder(client, settings);
    await pushProjectToDrive(client, projectId, root.id);
    const updated = await getProject(projectId);
    if (!updated?.driveFolderId) {
      throw new Error('Could not create Google Drive folder for this book.');
    }
    return {
      rootFolderId: root.id,
      folderId: updated.driveFolderId,
      title: updated.title,
    };
  });
}

/**
 * Verifies access to a shared Drive folder when a collaborator joins via link or Picker.
 * Auto-detects whether the folder is a single book (contains project.json) or a full library.
 */
export async function inspectSharedDriveFolder(
  folderId: string,
  clientOverride?: DriveClient,
): Promise<{
  folderId: string;
  name: string;
  scope: 'library' | 'book';
  accessRole: ShareAccessRole;
}> {
  return withAuthorizedClient(clientOverride, async (client) => {
    const summary = await client.verifyFileExists(folderId);
    if (!summary) {
      throw new DriveApiError(
        404,
        'StoryTape does not have permission to view this folder yet.',
      );
    }
    const children = await client.listFolderChildren(summary.id);
    const hasBookManifest = children.some(
      (c) => c.name === PROJECT_METADATA_FILENAME,
    );
    return {
      folderId: summary.id,
      name: summary.name || 'Shared Audiobooks',
      scope: hasBookManifest ? 'book' : 'library',
      accessRole: resolveAccessRole(summary, 'writer'),
    };
  });
}

export interface RescanBookDriveResult {
  rootFolderId: string;
  folderFound: boolean;
  addedChapters: number;
  removedOrphans: number;
  updatedCover: boolean;
  skippedReadOnly?: boolean;
}

const RESCAN_COVER_NAMES = new Set([
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
  'cover.webp',
]);

/**
 * Rescans a book's Google Drive directory for audio files dropped directly into Drive
 * (outside StoryTape), cleans up orphaned `cloud_only` chapters whose Drive files were
 * deleted, optionally picks up a cover image, and updates `project.json` so all devices
 * stay in sync without re-uploading any discovered audio files.
 */
export async function rescanBookDriveFolder(
  projectId: string,
  settings: AppSettings,
  onProgress?: (update: SyncProgressUpdate) => void,
  clientOverride?: DriveClient,
): Promise<RescanBookDriveResult> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Book not found.');

  if (project.accessRole === 'reader' || project.importedFrom) {
    return {
      rootFolderId: settings.driveRootFolderId || '',
      folderFound: Boolean(project.driveFolderId),
      addedChapters: 0,
      removedOrphans: 0,
      updatedCover: false,
      skippedReadOnly: true,
    };
  }

  return withAuthorizedClient(clientOverride, async (client) => {
    const root = await ensureRootFolder(client, settings);

    let folderSummary: DriveFileSummary | null = null;
    if (project.driveFolderId) {
      folderSummary = await client.verifyFileExists(project.driveFolderId);
    }
    if (!folderSummary) {
      const safeFolderName = sanitizeFileName(project.title, 'Untitled Book');
      folderSummary = await client.findFolderByName(safeFolderName, root.id);
    }

    if (!folderSummary) {
      onProgress?.({
        phase: 'done',
        message: 'No Google Drive folder found for this book yet.',
      });
      return {
        rootFolderId: root.id,
        folderFound: false,
        addedChapters: 0,
        removedOrphans: 0,
        updatedCover: false,
      };
    }

    const latestRole = resolveAccessRole(
      folderSummary,
      project.accessRole ?? 'owner',
    );
    if (latestRole === 'reader') {
      await putProject({
        ...project,
        driveFolderId: folderSummary.id,
        accessRole: 'reader',
        isShared: true,
        syncStatus: 'synced',
      });
      return {
        rootFolderId: root.id,
        folderFound: true,
        addedChapters: 0,
        removedOrphans: 0,
        updatedCover: false,
        skippedReadOnly: true,
      };
    }

    onProgress?.({
      phase: 'pulling',
      message: `Scanning "${project.title}" in Google Drive…`,
    });

    // Pull & merge existing project.json first (ADR-05 pull-before-push invariant)
    await pullSingleBookFolderFromDrive(client, folderSummary, {
      isShared: project.isShared,
      defaultRole: latestRole,
    });

    const files = await client.listFolderChildren(folderSummary.id);
    const freshProject = (await getProject(projectId)) ?? project;
    const localRecs = await listProjectRecordings(projectId);

    const now = Date.now();
    let updatedCover = false;
    let hasCover = freshProject.hasCover;
    let coverMimeType = freshProject.coverMimeType;
    let coverUpdatedAt = freshProject.coverUpdatedAt;
    let driveCoverFileId = freshProject.driveCoverFileId;

    if (!hasCover) {
      const coverCandidate = files.find(
        (f) =>
          f.mimeType !== FOLDER_MIME &&
          RESCAN_COVER_NAMES.has(f.name.trim().toLowerCase()),
      );
      if (coverCandidate) {
        try {
          const coverBlob = await client.downloadFileBlob(coverCandidate.id);
          await putProjectCover(freshProject.id, coverBlob);
          hasCover = true;
          driveCoverFileId = coverCandidate.id;
          coverMimeType =
            coverCandidate.mimeType || coverBlob.type || 'image/jpeg';
          coverUpdatedAt = now;
          updatedCover = true;
        } catch {
          // Non-fatal cover download error
        }
      }
    }

    const presentIds = new Set(files.map((f) => f.id));
    const presentNamesLower = new Set(files.map((f) => f.name.toLowerCase()));
    const deletedIdsSet = new Set(freshProject.deletedRecordingIds ?? []);

    const survivingRecs: Recording[] = [];
    let removedOrphans = 0;

    for (const rec of localRecs) {
      const hasDriveMatch =
        (rec.driveFileId && presentIds.has(rec.driveFileId)) ||
        (rec.driveFileName &&
          presentNamesLower.has(rec.driveFileName.toLowerCase()));

      if (rec.syncStatus === 'cloud_only' && !hasDriveMatch) {
        await deleteRecording(rec.id);
        deletedIdsSet.add(rec.id);
        removedOrphans += 1;
      } else {
        survivingRecs.push(rec);
      }
    }

    if (removedOrphans > 0) {
      for (let i = 0; i < survivingRecs.length; i += 1) {
        if (survivingRecs[i].orderIndex !== i) {
          survivingRecs[i] = {
            ...survivingRecs[i],
            orderIndex: i,
            updatedAt: now,
          };
          await putRecording(survivingRecs[i]);
        }
      }
    }

    const trackedIds = new Set(
      survivingRecs.map((r) => r.driveFileId).filter(Boolean),
    );
    const trackedNamesLower = new Set(
      survivingRecs
        .map((r) => (r.driveFileName || '').toLowerCase())
        .filter(Boolean),
    );

    const newAudioCandidates = files
      .filter((f) => {
        if (f.mimeType === FOLDER_MIME) return false;
        if (f.name === PROJECT_METADATA_FILENAME) return false;
        if (driveCoverFileId && f.id === driveCoverFileId) return false;
        if (trackedIds.has(f.id)) return false;
        if (trackedNamesLower.has(f.name.toLowerCase())) return false;
        return detectImportedAudioFormat(f.name, f.mimeType) !== null;
      })
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        }),
      );

    const narratorAttribution =
      settings.defaultNarrator.trim() ||
      googleAuth.getState().userName?.trim() ||
      undefined;

    const finalRecs = survivingRecs.slice();
    let addedChapters = 0;

    for (const file of newAudioCandidates) {
      const detected = detectImportedAudioFormat(file.name, file.mimeType);
      if (!detected) continue;

      const orderIndex = finalRecs.length;
      const name = deriveChapterNameFromFileName(file.name, orderIndex);
      const parsedMod = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN;
      const itemTs = now + addedChapters;
      const rec: Recording = {
        id: createId('rec'),
        projectId: freshProject.id,
        name,
        notes: '',
        recordedBy: narratorAttribution,
        orderIndex,
        durationMs: 0,
        mimeType: detected.mimeType,
        extension: detected.extension,
        sampleRate: 0,
        channels: 1,
        deviceLabel: 'Google Drive',
        fileSizeBytes: Number(file.size) || 0,
        peaks: [],
        driveFileId: file.id,
        driveFileName: file.name,
        syncStatus: 'cloud_only',
        createdAt: Number.isFinite(parsedMod) ? parsedMod : itemTs,
        updatedAt: itemTs,
      };
      await putRecording(rec);
      finalRecs.push(rec);
      addedChapters += 1;
    }

    const existingMetaFile = files.find(
      (f) => f.name === PROJECT_METADATA_FILENAME,
    );
    const metaFileId =
      existingMetaFile?.id ?? freshProject.driveMetadataFileId;
    const needsManifestWrite =
      addedChapters > 0 ||
      removedOrphans > 0 ||
      updatedCover ||
      !metaFileId;

    const nextDeletedIds = Array.from(deletedIdsSet);
    const hasPendingLocalUploads = finalRecs.some(
      (r) =>
        r.syncStatus === 'local_only' ||
        r.syncStatus === 'pending_upload' ||
        r.syncStatus === 'error',
    );

    let updatedProject: BookProject = {
      ...freshProject,
      driveFolderId: folderSummary.id,
      driveMetadataFileId: metaFileId,
      driveCoverFileId,
      hasCover,
      coverMimeType,
      coverUpdatedAt,
      accessRole: latestRole,
      deletedRecordingIds: nextDeletedIds.length ? nextDeletedIds : undefined,
      syncStatus: hasPendingLocalUploads ? 'pending_upload' : 'synced',
      syncError: undefined,
      updatedAt:
        addedChapters > 0 || removedOrphans > 0 || updatedCover
          ? Math.max(freshProject.updatedAt, now + addedChapters)
          : freshProject.updatedAt,
    };

    if (needsManifestWrite) {
      const manifest = buildMetadataPayload(updatedProject, finalRecs);
      const uploadedMeta = await client.uploadJsonFile(
        PROJECT_METADATA_FILENAME,
        folderSummary.id,
        manifest,
        metaFileId,
      );
      updatedProject = {
        ...updatedProject,
        driveMetadataFileId: uploadedMeta.id,
      };
    }

    await putProject(updatedProject);

    recordSyncDebugEvent('sync', 'rescan_book_folder_complete', {
      projectId: updatedProject.id,
      folderId: folderSummary.id,
      scannedFiles: files.length,
      addedChapters,
      removedOrphans,
      updatedCover,
    });

    onProgress?.({
      phase: 'done',
      message:
        addedChapters > 0
          ? `Found ${addedChapters} new chapter${addedChapters === 1 ? '' : 's'} in Drive.`
          : 'Google Drive folder is up to date.',
    });

    return {
      rootFolderId: root.id,
      folderFound: true,
      addedChapters,
      removedOrphans,
      updatedCover,
    };
  });
}

export async function downloadCloudRecording(
  recordingId: string,
  clientOverride?: DriveClient,
): Promise<Blob> {
  const rec = await getRecording(recordingId);
  if (!rec) throw new Error('Recording not found.');
  const localBlob = await getRecordingBlob(recordingId);
  if (localBlob) return localBlob;

  if (!rec.driveFileId) {
    throw new Error('This recording is not linked to a Google Drive file.');
  }

  return withAuthorizedClient(clientOverride, async (client) => {
    const rawBlob = await client.downloadFileBlob(rec.driveFileId!);
    const blob = normalizeAudioBlobType(rawBlob, rec);
    await putRecordingBlob(recordingId, blob);

    let hydrated: Partial<Recording> = {};
    if (rec.durationMs <= 0 || (rec.sampleRate <= 0 && rec.peaks.length === 0)) {
      try {
        const bytes = await blobToArrayBuffer(blob);
        const inspectFile = new File(
          [bytes],
          rec.driveFileName || `${rec.name}.${rec.extension}`,
          { type: blob.type || rec.mimeType },
        );
        const analysis = await inspectImportedAudioFile(inspectFile);
        hydrated = {
          durationMs: analysis.durationMs,
          sampleRate: analysis.sampleRate || rec.sampleRate,
          channels: analysis.channels,
          bitrateKbps: analysis.bitrateKbps ?? rec.bitrateKbps,
          bitDepth: analysis.bitDepth ?? rec.bitDepth,
          fileSizeBytes: blob.size || rec.fileSizeBytes,
          peaks: analysis.peaks.length > 0 ? analysis.peaks : rec.peaks,
        };
      } catch {
        // Metadata hydration is best-effort; never block cloud playback
      }
    }

    await putRecording({
      ...rec,
      ...hydrated,
      fileSizeBytes: hydrated.fileSizeBytes ?? (blob.size || rec.fileSizeBytes),
      syncStatus: 'synced',
      syncError: undefined,
    });
    return blob;
  });
}

export function listDriveFolderPermissions(
  folderId: string,
  clientOverride?: DriveClient,
): Promise<DriveCollaboratorPermission[]> {
  return withAuthorizedClient(clientOverride, (client) =>
    client.listPermissions(folderId),
  );
}

export function shareDriveFolderWithEmail(
  folderId: string,
  email: string,
  role: 'writer' | 'reader',
  emailMessage?: string,
  clientOverride?: DriveClient,
): Promise<DriveCollaboratorPermission> {
  return withAuthorizedClient(clientOverride, (client) =>
    client.shareWithEmail(folderId, email, role, emailMessage),
  );
}

export function setDriveFolderAnyoneLinkAccess(
  folderId: string,
  enabled: boolean,
  role: 'reader' | 'writer' = 'reader',
  clientOverride?: DriveClient,
): Promise<DriveCollaboratorPermission | null> {
  return withAuthorizedClient(clientOverride, (client) =>
    client.setAnyoneLinkAccess(folderId, enabled, role),
  );
}

export function removeDriveFolderPermission(
  folderId: string,
  permissionId: string,
  clientOverride?: DriveClient,
): Promise<void> {
  return withAuthorizedClient(clientOverride, (client) =>
    client.removePermission(folderId, permissionId),
  );
}

export function listDriveFolderAccessProposals(
  folderId: string,
  clientOverride?: DriveClient,
): Promise<DriveAccessProposal[]> {
  return withAuthorizedClient(clientOverride, (client) =>
    client.listAccessProposals(folderId),
  );
}

export function resolveDriveFolderAccessProposal(
  folderId: string,
  proposalId: string,
  options: {
    action: 'ACCEPT' | 'DENY';
    role?: 'reader' | 'writer';
    sendNotification?: boolean;
  },
  clientOverride?: DriveClient,
): Promise<void> {
  return withAuthorizedClient(clientOverride, (client) =>
    client.resolveAccessProposal(folderId, proposalId, options),
  );
}

async function withAuthorizedClient<T>(
  clientOverride: DriveClient | undefined,
  run: (client: DriveClient) => Promise<T>,
): Promise<T> {
  if (clientOverride) {
    try {
      return await run(clientOverride);
    } catch (err) {
      if (err instanceof DriveApiError && err.status === 401) {
        googleAuth.markExpired();
      }
      throw err;
    }
  }

  const token = await googleAuth.ensureValidAccessToken();
  if (!token) {
    throw new Error('Please connect Google Drive in Settings first.');
  }

  try {
    return await run(new DriveClient(token));
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 401) {
      if (googleAuth.canRefreshSilently()) {
        const refreshed = await googleAuth.refreshAccessTokenSilently({
          force: true,
        });
        if (refreshed) {
          try {
            return await run(new DriveClient(refreshed));
          } catch (retryErr) {
            if (retryErr instanceof DriveApiError && retryErr.status === 401) {
              googleAuth.markExpired();
            }
            throw retryErr;
          }
        }
      }
      googleAuth.markExpired();
    }
    throw err;
  }
}
