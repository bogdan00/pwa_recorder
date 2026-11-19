import type {
  AppSettings,
  BookProject,
  DriveProjectMetadataFile,
  Recording,
} from '../types/models';
import {
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
import { DriveApiError, DriveClient } from './driveClient';
import { googleAuth } from './googleAuth';

export interface SyncProgressUpdate {
  phase: 'connecting' | 'pushing' | 'pulling' | 'done';
  message: string;
  current?: number;
  total?: number;
}

export interface SyncResult {
  rootFolderId: string;
  pushedProjects: number;
  pushedRecordings: number;
  pulledProjects: number;
  errors: string[];
}

const PROJECT_METADATA_FILENAME = 'project.json';
const COVER_FILENAME = 'cover.jpg';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function ensureRootFolder(
  client: DriveClient,
  settings: AppSettings,
): Promise<string> {
  if (settings.driveRootFolderId) {
    const existing = await client.verifyFileExists(settings.driveRootFolderId);
    if (existing) return existing.id;
  }
  const folderName = sanitizeFileName(
    settings.driveRootFolderName,
    'StoryTape Audiobooks',
  );
  const folder = await client.findOrCreateFolder(folderName);
  return folder.id;
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
      if (existing.name !== safeFolderName) {
        await client.renameFile(existing.id, safeFolderName).catch(() => {});
      }
      return existing.id;
    }
  }
  const folder = await client.findOrCreateFolder(safeFolderName, rootFolderId);
  return folder.id;
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
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    recordings: recordings.map((rec) => ({
      id: rec.id,
      name: rec.name,
      notes: rec.notes,
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

export async function pushProjectToDrive(
  client: DriveClient,
  projectId: string,
  rootFolderId: string,
  onProgress?: (update: SyncProgressUpdate) => void,
): Promise<{ pushedRecordings: number }> {
  const project = await getProject(projectId);
  if (!project) return { pushedRecordings: 0 };

  onProgress?.({
    phase: 'pushing',
    message: `Syncing "${project.title}"…`,
  });

  const folderId = await ensureProjectFolder(client, project, rootFolderId);
  let updatedProject: BookProject = {
    ...project,
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

  // 2. Upload any recordings not yet synced to Drive
  const recordings = await listProjectRecordings(updatedProject.id);
  const finalRecordings: Recording[] = [];
  let pushedRecordings = 0;

  for (let i = 0; i < recordings.length; i += 1) {
    let rec = recordings[i];
    const desiredName = buildChapterDriveFileName(
      rec.orderIndex,
      rec.name,
      rec.extension,
    );

    const needsUpload =
      !rec.driveFileId ||
      rec.syncStatus === 'pending_upload' ||
      rec.syncStatus === 'local_only' ||
      rec.syncStatus === 'error';

    if (needsUpload && rec.syncStatus !== 'cloud_only') {
      const blob = await getRecordingBlob(rec.id);
      if (blob) {
        onProgress?.({
          phase: 'pushing',
          message: `Uploading "${rec.name}"…`,
          current: i + 1,
          total: recordings.length,
        });

        rec = { ...rec, syncStatus: 'uploading', syncError: undefined };
        await putRecording(rec);

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
          const message =
            err instanceof Error ? err.message : 'Audio upload failed';
          rec = { ...rec, syncStatus: 'error', syncError: message };
          await putRecording(rec);
          throw err;
        }
      }
    } else if (rec.driveFileId && rec.driveFileName !== desiredName) {
      // Keep Drive filename aligned after renaming or reordering chapters
      await client.renameFile(rec.driveFileId, desiredName).catch(() => {});
      rec = { ...rec, driveFileName: desiredName };
      await putRecording(rec);
    }

    finalRecordings.push(rec);
  }

  // 3. Upload/update project.json metadata file alongside cover & recordings
  const metadataPayload = buildMetadataPayload(updatedProject, finalRecordings);
  const metaFile = await client.uploadJsonFile(
    PROJECT_METADATA_FILENAME,
    folderId,
    metadataPayload,
    updatedProject.driveMetadataFileId,
  );

  updatedProject = {
    ...updatedProject,
    driveMetadataFileId: metaFile.id,
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
): Promise<{ pulledProjects: number }> {
  onProgress?.({
    phase: 'pulling',
    message: 'Checking Google Drive for other books…',
  });

  const children = await client.listFolderChildren(rootFolderId);
  const bookFolders = children.filter((c) => c.mimeType === FOLDER_MIME);
  const localProjects = await listProjects();
  const localById = new Map(localProjects.map((p) => [p.id, p]));
  let pulledProjects = 0;

  for (const folder of bookFolders) {
    const files = await client.listFolderChildren(folder.id);
    const metaFile = files.find((f) => f.name === PROJECT_METADATA_FILENAME);
    if (!metaFile) continue;

    let remoteMeta: DriveProjectMetadataFile;
    try {
      remoteMeta = await client.downloadJsonFile<DriveProjectMetadataFile>(
        metaFile.id,
      );
    } catch {
      continue;
    }

    if (!remoteMeta?.id || !remoteMeta?.title) continue;

    const existingLocal = localById.get(remoteMeta.id);
    const coverFile = files.find(
      (f) => f.name === (remoteMeta.coverFileName || COVER_FILENAME),
    );

    const shouldUpdateProject =
      !existingLocal || remoteMeta.updatedAt > existingLocal.updatedAt;

    if (shouldUpdateProject) {
      let hasCover = Boolean(coverFile);
      if (coverFile) {
        const needsCoverDownload =
          !existingLocal?.hasCover ||
          (remoteMeta.coverUpdatedAt ?? 0) > (existingLocal.coverUpdatedAt ?? 0);
        if (needsCoverDownload) {
          try {
            const coverBlob = await client.downloadFileBlob(coverFile.id);
            await putProjectCover(remoteMeta.id, coverBlob);
            hasCover = true;
          } catch {
            hasCover = existingLocal?.hasCover ?? false;
          }
        }
      }

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
        coverMimeType: remoteMeta.coverMimeType,
        coverUpdatedAt: remoteMeta.coverUpdatedAt,
        driveFolderId: folder.id,
        driveMetadataFileId: metaFile.id,
        driveCoverFileId: coverFile?.id,
        syncStatus: 'synced',
        createdAt: remoteMeta.createdAt || Date.now(),
        updatedAt: remoteMeta.updatedAt || Date.now(),
      };
      await putProject(mergedProject);
      pulledProjects += 1;
    }

    // Reconcile recordings from remote metadata
    const localRecs = await listProjectRecordings(remoteMeta.id);
    const localRecById = new Map(localRecs.map((r) => [r.id, r]));

    for (const remoteRec of remoteMeta.recordings ?? []) {
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
      } else if (remoteRec.updatedAt > localRec.updatedAt) {
        await putRecording({
          ...localRec,
          name: remoteRec.name,
          notes: remoteRec.notes || '',
          orderIndex: remoteRec.orderIndex,
          driveFileId: remoteRec.driveFileId || localRec.driveFileId,
          driveFileName: remoteRec.driveFileName || localRec.driveFileName,
          updatedAt: remoteRec.updatedAt,
        });
      }
    }
  }

  return { pulledProjects };
}

export async function syncAllWithDrive(
  settings: AppSettings,
  onProgress?: (update: SyncProgressUpdate) => void,
  clientOverride?: DriveClient,
): Promise<SyncResult> {
  const client = clientOverride ?? createAuthorizedClient();
  const errors: string[] = [];

  onProgress?.({
    phase: 'connecting',
    message: 'Connecting to Google Drive…',
  });

  try {
    const rootFolderId = await ensureRootFolder(client, settings);
    const localProjects = await listProjects();
    let pushedProjects = 0;
    let pushedRecordings = 0;

    for (const project of localProjects) {
      try {
        const res = await pushProjectToDrive(
          client,
          project.id,
          rootFolderId,
          onProgress,
        );
        pushedProjects += 1;
        pushedRecordings += res.pushedRecordings;
      } catch (err) {
        if (err instanceof DriveApiError && err.status === 401) {
          googleAuth.markExpired();
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

    const { pulledProjects } = await pullRemoteProjectsFromDrive(
      client,
      rootFolderId,
      onProgress,
    );

    onProgress?.({ phase: 'done', message: 'Google Drive is up to date.' });

    return {
      rootFolderId,
      pushedProjects,
      pushedRecordings,
      pulledProjects,
      errors,
    };
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 401) {
      googleAuth.markExpired();
    }
    throw err;
  }
}

export async function syncSingleProjectWithDrive(
  projectId: string,
  settings: AppSettings,
  onProgress?: (update: SyncProgressUpdate) => void,
  clientOverride?: DriveClient,
): Promise<{ rootFolderId: string; pushedRecordings: number }> {
  const client = clientOverride ?? createAuthorizedClient();
  try {
    const rootFolderId = await ensureRootFolder(client, settings);
    const { pushedRecordings } = await pushProjectToDrive(
      client,
      projectId,
      rootFolderId,
      onProgress,
    );
    onProgress?.({ phase: 'done', message: 'Synced to Google Drive.' });
    return { rootFolderId, pushedRecordings };
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 401) {
      googleAuth.markExpired();
    }
    throw err;
  }
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

  const client = clientOverride ?? createAuthorizedClient();
  try {
    const blob = await client.downloadFileBlob(rec.driveFileId);
    await putRecordingBlob(recordingId, blob);
    await putRecording({
      ...rec,
      syncStatus: 'synced',
      syncError: undefined,
    });
    return blob;
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 401) {
      googleAuth.markExpired();
    }
    throw err;
  }
}

function createAuthorizedClient(): DriveClient {
  const token = googleAuth.getAccessToken();
  if (!token) {
    throw new Error('Please connect Google Drive in Settings first.');
  }
  return new DriveClient(token);
}
