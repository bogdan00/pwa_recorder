import type {
  AppSettings,
  BookProject,
  DriveProjectMetadataFile,
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
import {
  buildChapterDriveFileName,
  sanitizeFileName,
} from '../utils/format';
import {
  DriveApiError,
  DriveClient,
  type DriveFileSummary,
} from './driveClient';
import { googleAuth } from './googleAuth';

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

function mergeDeletedIds(a?: string[], b?: string[]): string[] {
  const set = new Set<string>([...(a ?? []), ...(b ?? [])]);
  return Array.from(set);
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
    deletedRecordingIds: project.deletedRecordingIds?.length
      ? project.deletedRecordingIds
      : undefined,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    recordings: recordings.map((rec) => ({
      id: rec.id,
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
  if (!metaFile) return { projectId: null, updated: false };

  let remoteMeta: DriveProjectMetadataFile;
  try {
    remoteMeta = await client.downloadJsonFile<DriveProjectMetadataFile>(
      metaFile.id,
    );
  } catch {
    return { projectId: null, updated: false };
  }

  if (!remoteMeta?.id || !remoteMeta?.title) {
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
    !existingLocal || remoteMeta.updatedAt > existingLocal.updatedAt;

  let hasCover = existingLocal?.hasCover ?? Boolean(coverFile);
  let coverMimeType = existingLocal?.coverMimeType ?? remoteMeta.coverMimeType;
  let coverUpdatedAt = existingLocal?.coverUpdatedAt ?? remoteMeta.coverUpdatedAt;

  if (coverFile) {
    const needsCoverDownload =
      !existingLocal?.hasCover ||
      (remoteMeta.coverUpdatedAt ?? 0) > (existingLocal.coverUpdatedAt ?? 0);
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
    } else if (remoteRec.updatedAt > localRec.updatedAt) {
      await putRecording({
        ...localRec,
        name: remoteRec.name,
        notes: remoteRec.notes || '',
        recordedBy: remoteRec.recordedBy ?? localRec.recordedBy,
        orderIndex: remoteRec.orderIndex,
        driveFileId: remoteRec.driveFileId || localRec.driveFileId,
        driveFileName: remoteRec.driveFileName || localRec.driveFileName,
        updatedAt: remoteRec.updatedAt,
      });
      didUpdate = true;
    } else if (!localRec.driveFileId && remoteRec.driveFileId) {
      await putRecording({
        ...localRec,
        driveFileId: remoteRec.driveFileId,
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
      if (!folder || folder.mimeType !== FOLDER_MIME) continue;
      seenFolderIds.add(folder.id);
      const res = await pullSingleBookFolderFromDrive(client, folder, {
        isShared: true,
        defaultRole: link.role,
      });
      if (res.updated) pulledProjects += 1;
    } catch {
      // Skip inaccessible individual shared book without breaking overall sync
    }
  }

  return { pulledProjects };
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
    const { pulledProjects } = await pullRemoteProjectsFromDrive(
      client,
      root.id,
      onProgress,
      {
        isSharedLibrary,
        rootRole: root.role,
        sharedBookFolders: settings.sharedBookFolders,
      },
    );

    // 2. PUSH local writable projects (skipping read-only Listener books)
    const localProjects = await listProjects();
    let pushedProjects = 0;
    let pushedRecordings = 0;

    for (const project of localProjects) {
      if (project.accessRole === 'reader') continue;
      if (root.role === 'reader' && !project.driveFolderId) continue;

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
): Promise<{ rootFolderId: string; pushedRecordings: number }> {
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
    const blob = await client.downloadFileBlob(rec.driveFileId!);
    await putRecordingBlob(recordingId, blob);
    await putRecording({
      ...rec,
      syncStatus: 'synced',
      syncError: undefined,
    });
    return blob;
  });
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
