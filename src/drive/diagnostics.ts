import type {
  AppSettings,
  DriveProjectMetadataFile,
} from '../types/models';
import {
  listDrafts,
  listProjectRecordings,
  listProjects,
} from '../storage/db';
import { APP_VERSION } from '../utils/appVersion';
import { downloadBlob } from '../utils/blob';
import {
  clearSyncDebugLog,
  getSyncDebugLog,
  type SyncDebugEvent,
} from './debugLog';
import { DriveClient, type DriveFileSummary } from './driveClient';
import { googleAuth } from './googleAuth';
import { copyTextToClipboard } from './shareUtils';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const PROJECT_METADATA_FILENAME = 'project.json';

export interface DriveFolderProbeResult {
  folderId: string;
  folderMeta: DriveFileSummary | null;
  children?: Array<{
    id: string;
    name: string;
    mimeType: string;
    ownedByMe?: boolean;
    shared?: boolean;
    capabilities?: DriveFileSummary['capabilities'];
  }>;
  manifestSummary?: {
    fileId: string;
    id?: string;
    title?: string;
    recordingCount?: number;
    importedFromFolderId?: string;
    updatedAt?: number;
    error?: string;
  };
  error?: string;
}

export interface SyncDiagnosticsReport {
  schemaVersion: 1;
  generatedAt: string;
  appVersion: string;
  environment: {
    origin: string;
    pathname: string;
    hash: string;
    userAgent: string;
    standalone: boolean;
    onLine: boolean;
  };
  auth: {
    status: string;
    userEmail: string | null;
    userName: string | null;
    wasConnected: boolean;
    hasValidToken: boolean;
    expiresAt: number | null;
    expiresInSec: number | null;
    hasPersistentRefresh: boolean;
    lastError: string | null;
    hasGoogleClientId: boolean;
    hasGoogleApiKey: boolean;
  };
  settings: {
    driveRootFolderName: string;
    driveRootFolderId: string | null;
    driveLibraryMode: string;
    driveSharedFolderName: string | null;
    driveAccessRole: string | null;
    sharedBookFolders: AppSettings['sharedBookFolders'];
    defaultNarrator: string;
  };
  localDb: {
    projectCount: number;
    recordingCount: number;
    draftCount: number;
    projects: Array<{
      id: string;
      title: string;
      driveFolderId?: string;
      driveMetadataFileId?: string;
      isShared?: boolean;
      accessRole?: string;
      importedFrom?: unknown;
      deletedRecordingIds?: string[];
      syncStatus: string;
      syncError?: string;
      updatedAt: number;
      recordings: Array<{
        id: string;
        sourceRecordingId?: string;
        name: string;
        recordedBy?: string;
        orderIndex: number;
        driveFileId?: string;
        driveFileName?: string;
        syncStatus: string;
        syncError?: string;
        fileSizeBytes: number;
      }>;
    }>;
  };
  liveDriveProbe: {
    ran: boolean;
    skippedReason?: string;
    userInfo?: { email: string | null; displayName: string | null };
    rootFolderCheck?: DriveFolderProbeResult;
    rootChildSubtrees?: DriveFolderProbeResult[];
    sharedBookFoldersProbe?: DriveFolderProbeResult[];
    visibleDriveItems?: Array<{
      id: string;
      name: string;
      mimeType: string;
      parents?: string[];
      ownedByMe?: boolean;
      shared?: boolean;
      capabilities?: DriveFileSummary['capabilities'];
    }>;
    error?: string;
  };
  recentEvents: SyncDebugEvent[];
}

async function probeSingleFolder(
  client: DriveClient,
  folderId: string,
): Promise<DriveFolderProbeResult> {
  try {
    const folderMeta = await client.verifyFileExists(folderId);
    if (!folderMeta) {
      return {
        folderId,
        folderMeta: null,
        error: 'verifyFileExists returned null (404 or trashed)',
      };
    }

    const children = await client.listFolderChildren(folderMeta.id);
    const metaFile = children.find((f) => f.name === PROJECT_METADATA_FILENAME);
    let manifestSummary: DriveFolderProbeResult['manifestSummary'];

    if (metaFile) {
      try {
        const meta = await client.downloadJsonFile<DriveProjectMetadataFile>(
          metaFile.id,
        );
        manifestSummary = {
          fileId: metaFile.id,
          id: meta?.id,
          title: meta?.title,
          recordingCount: Array.isArray(meta?.recordings)
            ? meta.recordings.length
            : undefined,
          importedFromFolderId: meta?.importedFrom?.folderId,
          updatedAt: meta?.updatedAt,
        };
      } catch (err) {
        manifestSummary = {
          fileId: metaFile.id,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      folderId,
      folderMeta,
      children: children.slice(0, 40).map((c) => ({
        id: c.id,
        name: c.name,
        mimeType: c.mimeType,
        ownedByMe: c.ownedByMe,
        shared: c.shared,
        capabilities: c.capabilities,
      })),
      manifestSummary,
    };
  } catch (err) {
    return {
      folderId,
      folderMeta: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function buildSyncDiagnosticsReport(
  settings: AppSettings,
  clientOverride?: DriveClient,
): Promise<SyncDiagnosticsReport> {
  const authState = googleAuth.getState();
  const projects = await listProjects();
  const drafts = await listDrafts();
  let totalRecordings = 0;

  const projectSnapshots = await Promise.all(
    projects.map(async (p) => {
      const recs = await listProjectRecordings(p.id);
      totalRecordings += recs.length;
      return {
        id: p.id,
        title: p.title,
        driveFolderId: p.driveFolderId,
        driveMetadataFileId: p.driveMetadataFileId,
        isShared: p.isShared,
        accessRole: p.accessRole,
        importedFrom: p.importedFrom,
        deletedRecordingIds: p.deletedRecordingIds,
        syncStatus: p.syncStatus,
        syncError: p.syncError,
        updatedAt: p.updatedAt,
        recordings: recs.map((r) => ({
          id: r.id,
          sourceRecordingId: r.sourceRecordingId,
          name: r.name,
          recordedBy: r.recordedBy,
          orderIndex: r.orderIndex,
          driveFileId: r.driveFileId,
          driveFileName: r.driveFileName,
          syncStatus: r.syncStatus,
          syncError: r.syncError,
          fileSizeBytes: r.fileSizeBytes,
        })),
      };
    }),
  );

  const isStandalone =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
      (navigator as unknown as { standalone?: boolean }).standalone === true);

  const liveDriveProbe: SyncDiagnosticsReport['liveDriveProbe'] = {
    ran: false,
  };

  let client: DriveClient | null = clientOverride ?? null;
  if (!client) {
    const token = await googleAuth.ensureValidAccessToken().catch(() => null);
    if (token) {
      client = new DriveClient(token);
    } else {
      liveDriveProbe.skippedReason =
        'No valid Google Drive access token (not signed in or token expired).';
    }
  }

  if (client) {
    liveDriveProbe.ran = true;
    try {
      try {
        liveDriveProbe.userInfo = await client.getUserInfo();
      } catch (err) {
        liveDriveProbe.error = `getUserInfo: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Probe configured root folder (or look up by name if ID missing)
      let rootIdToProbe = settings.driveRootFolderId;
      if (!rootIdToProbe) {
        const found = await client
          .findFolderByName(settings.driveRootFolderName || 'StoryTape Audiobooks')
          .catch(() => null);
        rootIdToProbe = found?.id;
      }

      if (rootIdToProbe) {
        const rootProbe = await probeSingleFolder(client, rootIdToProbe);
        liveDriveProbe.rootFolderCheck = rootProbe;

        const childFolders = (rootProbe.children ?? [])
          .filter((c) => c.mimeType === FOLDER_MIME)
          .slice(0, 15);
        liveDriveProbe.rootChildSubtrees = [];
        for (const child of childFolders) {
          liveDriveProbe.rootChildSubtrees.push(
            await probeSingleFolder(client, child.id),
          );
        }
      }

      // Probe individually linked shared books
      if ((settings.sharedBookFolders?.length ?? 0) > 0) {
        liveDriveProbe.sharedBookFoldersProbe = [];
        for (const link of settings.sharedBookFolders ?? []) {
          liveDriveProbe.sharedBookFoldersProbe.push(
            await probeSingleFolder(client, link.folderId),
          );
        }
      }

      // Broad drive.file visibility snapshot: every non-trashed item StoryTape can currently see
      try {
        const visible = await client.listVisibleFiles(40);
        liveDriveProbe.visibleDriveItems = visible.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          parents: f.parents,
          ownedByMe: f.ownedByMe,
          shared: f.shared,
          capabilities: f.capabilities,
        }));
      } catch (err) {
        liveDriveProbe.error = [
          liveDriveProbe.error,
          `listVisibleFiles: ${err instanceof Error ? err.message : String(err)}`,
        ]
          .filter(Boolean)
          .join(' | ');
      }
    } catch (err) {
      liveDriveProbe.error = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    environment: {
      origin: typeof window !== 'undefined' ? window.location.origin : '',
      pathname: typeof window !== 'undefined' ? window.location.pathname : '',
      hash: typeof window !== 'undefined' ? window.location.hash : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      standalone: isStandalone,
      onLine: typeof navigator !== 'undefined' ? navigator.onLine : true,
    },
    auth: {
      status: authState.status,
      userEmail: authState.userEmail,
      userName: authState.userName,
      wasConnected: authState.wasConnected,
      hasValidToken: googleAuth.hasValidToken(),
      expiresAt: authState.expiresAt,
      expiresInSec: authState.expiresAt
        ? Math.round((authState.expiresAt - Date.now()) / 1000)
        : null,
      hasPersistentRefresh: authState.hasPersistentRefresh,
      lastError: authState.lastError,
      hasGoogleClientId: Boolean(settings.googleClientId?.trim()),
      hasGoogleApiKey: Boolean(settings.googleApiKey?.trim()),
    },
    settings: {
      driveRootFolderName: settings.driveRootFolderName,
      driveRootFolderId: settings.driveRootFolderId ?? null,
      driveLibraryMode: settings.driveLibraryMode ?? 'personal',
      driveSharedFolderName: settings.driveSharedFolderName ?? null,
      driveAccessRole: settings.driveAccessRole ?? null,
      sharedBookFolders: settings.sharedBookFolders ?? [],
      defaultNarrator: settings.defaultNarrator,
    },
    localDb: {
      projectCount: projects.length,
      recordingCount: totalRecordings,
      draftCount: drafts.length,
      projects: projectSnapshots,
    },
    liveDriveProbe,
    recentEvents: getSyncDebugLog(),
  };
}

export async function copyDiagnosticsReportToClipboard(
  report: SyncDiagnosticsReport,
): Promise<boolean> {
  const json = JSON.stringify(report, null, 2);
  return copyTextToClipboard(json);
}

export async function shareOrDownloadDiagnosticsReport(
  report: SyncDiagnosticsReport,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const json = JSON.stringify(report, null, 2);
  const emailSlug = (report.auth.userEmail || 'device')
    .split('@')[0]
    .replace(/[^a-z0-9_-]/gi, '')
    .slice(0, 24);
  const stamp = report.generatedAt.replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `storytape-debug-${emailSlug || 'device'}-${stamp}.json`;
  const blob = new Blob([json], { type: 'application/json' });

  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof File !== 'undefined'
  ) {
    try {
      const file = new File([blob], fileName, { type: 'application/json' });
      const data: ShareData = {
        title: 'StoryTape Sync Debug Report',
        text: `StoryTape debug report (${report.auth.userEmail || 'local'})`,
        files: [file],
      };
      const canShare =
        typeof navigator.canShare === 'function'
          ? navigator.canShare(data)
          : true;
      if (canShare) {
        await navigator.share(data);
        return 'shared';
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return 'cancelled';
      }
    }
  }

  downloadBlob(blob, fileName);
  return 'downloaded';
}

export { clearSyncDebugLog, getSyncDebugLog };
