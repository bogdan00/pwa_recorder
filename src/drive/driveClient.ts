import type {
  DriveAccessProposal,
  DriveCollaboratorPermission,
} from '../types/models';
import { recordSyncDebugEvent } from './debugLog';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const FILE_SUMMARY_FIELDS =
  'id,name,mimeType,modifiedTime,ownedByMe,shared,capabilities(canEdit,canAddChildren,canShare)';
const FILE_LIST_FIELDS =
  'nextPageToken,files(id,name,mimeType,size,modifiedTime,ownedByMe,shared,capabilities(canEdit,canAddChildren,canShare))';
const VISIBLE_LIST_FIELDS =
  'files(id,name,mimeType,parents,modifiedTime,ownedByMe,shared,capabilities(canEdit,canAddChildren,canShare))';
const UPLOAD_SUMMARY_FIELDS = 'id,name,mimeType,size,modifiedTime';
const PERMISSION_FIELDS = 'id,type,role,emailAddress,displayName';

export class DriveApiError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DriveApiError';
    this.status = status;
  }
}

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  size?: string;
  modifiedTime?: string;
  ownedByMe?: boolean;
  shared?: boolean;
  webViewLink?: string;
  capabilities?: {
    canEdit?: boolean;
    canAddChildren?: boolean;
    canShare?: boolean;
  };
}

function escapeQueryValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function parseErrorResponse(res: Response): Promise<DriveApiError> {
  let msg = `Google Drive request failed (${res.status})`;
  try {
    const json = (await res.json()) as {
      error?: { message?: string };
    };
    if (json?.error?.message) msg = json.error.message;
  } catch {
    // Keep default message
  }
  return new DriveApiError(res.status, msg);
}

export class DriveClient {
  private readonly accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      ...extra,
    };
  }

  private async request(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: BodyInit;
      ignore404?: boolean;
    } = {},
  ): Promise<Response> {
    const method = (init.method || 'GET').toUpperCase();
    const startedAt = Date.now();
    const shortUrl = url
      .replace(/^https:\/\/www\.googleapis\.com/, '')
      .slice(0, 260);
    try {
      const res = await fetch(url, {
        method: init.method,
        headers: this.authHeaders(init.headers),
        body: init.body,
      });
      const durationMs = Date.now() - startedAt;
      if (!res.ok && !(init.ignore404 && res.status === 404)) {
        const parsedErr = await parseErrorResponse(res);
        recordSyncDebugEvent('drive_api', 'http_error', {
          method,
          url: shortUrl,
          status: res.status,
          durationMs,
          error: parsedErr.message,
        });
        throw parsedErr;
      }
      recordSyncDebugEvent('drive_api', 'http_ok', {
        method,
        url: shortUrl,
        status: res.status,
        durationMs,
      });
      return res;
    } catch (err) {
      if (!(err instanceof DriveApiError)) {
        recordSyncDebugEvent('drive_api', 'network_error', {
          method,
          url: shortUrl,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  private async requestJson<T>(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: BodyInit;
    } = {},
  ): Promise<T> {
    const res = await this.request(url, init);
    return (await res.json()) as T;
  }

  async getUserInfo(): Promise<{ email: string | null; displayName: string | null }> {
    const data = await this.requestJson<{
      user?: { displayName?: string; emailAddress?: string };
    }>(`${DRIVE_API_BASE}/about?fields=user(displayName,emailAddress)`);
    return {
      email: data.user?.emailAddress ?? null,
      displayName: data.user?.displayName ?? null,
    };
  }

  async findFolderByName(
    name: string,
    parentId?: string,
  ): Promise<DriveFileSummary | null> {
    const parentClause = parentId
      ? ` and '${escapeQueryValue(parentId)}' in parents`
      : ` and 'root' in parents`;
    const q = `name = '${escapeQueryValue(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false${parentClause}`;
    const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(${FILE_SUMMARY_FIELDS})&pageSize=5`;

    const data = await this.requestJson<{ files?: DriveFileSummary[] }>(url);
    return data.files?.[0] ?? null;
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFileSummary> {
    const metadata: Record<string, unknown> = {
      name,
      mimeType: FOLDER_MIME,
    };
    if (parentId) metadata.parents = [parentId];

    return this.requestJson<DriveFileSummary>(
      `${DRIVE_API_BASE}/files?fields=${FILE_SUMMARY_FIELDS}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      },
    );
  }

  async findOrCreateFolder(
    name: string,
    parentId?: string,
  ): Promise<DriveFileSummary> {
    const existing = await this.findFolderByName(name, parentId);
    if (existing) return existing;
    return this.createFolder(name, parentId);
  }

  async verifyFileExists(fileId: string): Promise<DriveFileSummary | null> {
    const res = await this.request(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,parents,trashed,ownedByMe,shared,webViewLink,capabilities(canEdit,canAddChildren,canShare)`,
      { ignore404: true },
    );
    if (res.status === 404) return null;
    const data = (await res.json()) as DriveFileSummary & { trashed?: boolean };
    if (!data?.id || data.trashed) return null;
    return data;
  }

  async listFolderChildren(folderId: string): Promise<DriveFileSummary[]> {
    const files: DriveFileSummary[] = [];
    let pageToken: string | undefined;

    do {
      const q = `'${escapeQueryValue(folderId)}' in parents and trashed = false`;
      const params = new URLSearchParams({
        q,
        fields: FILE_LIST_FIELDS,
        pageSize: '100',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const data = await this.requestJson<{
        files?: DriveFileSummary[];
        nextPageToken?: string;
      }>(`${DRIVE_API_BASE}/files?${params.toString()}`);
      if (data.files) files.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);

    recordSyncDebugEvent('drive_api', 'list_folder_children', {
      folderId,
      count: files.length,
      items: files.slice(0, 20).map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        ownedByMe: f.ownedByMe,
        shared: f.shared,
      })),
    });

    return files;
  }

  /**
   * Lists non-trashed Drive files/folders currently visible to StoryTape under `drive.file`.
   * Used by the Settings diagnostics exporter to verify Drive visibility across devices.
   */
  async listVisibleFiles(pageSize = 40): Promise<DriveFileSummary[]> {
    const params = new URLSearchParams({
      q: 'trashed = false',
      fields: VISIBLE_LIST_FIELDS,
      pageSize: String(Math.min(100, Math.max(1, pageSize))),
      orderBy: 'modifiedTime desc',
    });
    const data = await this.requestJson<{ files?: DriveFileSummary[] }>(
      `${DRIVE_API_BASE}/files?${params.toString()}`,
    );
    return data.files ?? [];
  }

  async uploadJsonFile(
    name: string,
    parentId: string,
    payload: unknown,
    existingFileId?: string,
  ): Promise<DriveFileSummary> {
    const boundary = `storytape_boundary_${Date.now()}`;
    const metadata: Record<string, unknown> = existingFileId
      ? { name, mimeType: 'application/json' }
      : { name, mimeType: 'application/json', parents: [parentId] };

    const jsonBody = JSON.stringify(payload, null, 2);
    const multipartBody = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      jsonBody,
      `--${boundary}--`,
    ].join('\r\n');

    const url = existingFileId
      ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=${UPLOAD_SUMMARY_FIELDS}`
      : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=${UPLOAD_SUMMARY_FIELDS}`;

    return this.requestJson<DriveFileSummary>(url, {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    });
  }

  /**
   * Google Drive Resumable Upload API for reliable large audio & cover uploads on mobile.
   */
  async uploadBinaryResumable(
    name: string,
    mimeType: string,
    parentId: string,
    blob: Blob,
    onProgress?: (ratio: number) => void,
    existingFileId?: string,
  ): Promise<DriveFileSummary> {
    const metadata: Record<string, unknown> = existingFileId
      ? { name, mimeType }
      : { name, mimeType, parents: [parentId] };

    const initUrl = existingFileId
      ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(existingFileId)}?uploadType=resumable&fields=${UPLOAD_SUMMARY_FIELDS}`
      : `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=${UPLOAD_SUMMARY_FIELDS}`;

    const initRes = await this.request(initUrl, {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify(metadata),
    });

    const uploadUri = initRes.headers.get('Location') || initRes.headers.get('location');
    if (!uploadUri) {
      throw new DriveApiError(500, 'Google Drive did not return a resumable upload URI.');
    }

    onProgress?.(0.05);

    const putRes = await fetch(uploadUri, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: blob,
    });

    if (!putRes.ok) throw await parseErrorResponse(putRes);
    onProgress?.(1);
    return (await putRes.json()) as DriveFileSummary;
  }

  async downloadFileBlob(fileId: string): Promise<Blob> {
    const res = await this.request(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
    );
    return res.blob();
  }

  async downloadJsonFile<T>(fileId: string): Promise<T> {
    return this.requestJson<T>(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
    );
  }

  async renameFile(fileId: string, newName: string): Promise<void> {
    await this.request(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
  }

  /**
   * Server-side Google Drive file copy (avoids downloading & re-uploading large audio files).
   */
  async copyFile(
    sourceFileId: string,
    name: string,
    parentId: string,
  ): Promise<DriveFileSummary> {
    return this.requestJson<DriveFileSummary>(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(sourceFileId)}/copy?fields=${UPLOAD_SUMMARY_FIELDS}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          parents: [parentId],
        }),
      },
    );
  }

  /**
   * Moves a Google Drive file or folder to the trash (safe, non-permanent removal).
   */
  async trashFile(fileId: string): Promise<void> {
    await this.request(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
      ignore404: true,
    });
  }

  // ============================================================================
  // Multi-User Collaboration & Sharing (Google Drive Permissions API v3)
  // ============================================================================

  async listPermissions(fileId: string): Promise<DriveCollaboratorPermission[]> {
    const data = await this.requestJson<{
      permissions?: DriveCollaboratorPermission[];
    }>(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions?fields=permissions(${PERMISSION_FIELDS})`,
    );
    return data.permissions ?? [];
  }

  async shareWithEmail(
    fileId: string,
    email: string,
    role: 'writer' | 'reader',
    emailMessage?: string,
  ): Promise<DriveCollaboratorPermission> {
    const params = new URLSearchParams({
      sendNotificationEmail: 'true',
      fields: PERMISSION_FIELDS,
    });
    if (emailMessage?.trim()) {
      params.set('emailMessage', emailMessage.trim());
    }
    return this.requestJson<DriveCollaboratorPermission>(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions?${params.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'user',
          role,
          emailAddress: email.trim(),
        }),
      },
    );
  }

  async setAnyoneLinkAccess(
    fileId: string,
    enabled: boolean,
    role: 'reader' | 'writer' = 'reader',
  ): Promise<DriveCollaboratorPermission | null> {
    const existing = await this.listPermissions(fileId);
    const anyonePerm = existing.find((p) => p.type === 'anyone');

    if (!enabled) {
      if (anyonePerm) {
        await this.removePermission(fileId, anyonePerm.id);
      }
      return null;
    }

    if (anyonePerm) {
      if (anyonePerm.role === role) return anyonePerm;
      return this.requestJson<DriveCollaboratorPermission>(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(anyonePerm.id)}?fields=${PERMISSION_FIELDS}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role }),
        },
      );
    }

    return this.requestJson<DriveCollaboratorPermission>(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions?fields=${PERMISSION_FIELDS}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'anyone', role }),
      },
    );
  }

  async removePermission(fileId: string, permissionId: string): Promise<void> {
    await this.request(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
      { method: 'DELETE', ignore404: true },
    );
  }

  /**
   * Lists pending Drive access requests (accessproposals) on a folder.
   * Only approvers (owners/editors with approval capability) can list proposals;
   * 403/404 responses degrade gracefully to an empty list.
   */
  async listAccessProposals(fileId: string): Promise<DriveAccessProposal[]> {
    try {
      const data = await this.requestJson<{
        accessProposals?: DriveAccessProposal[];
      }>(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/accessproposals`,
      );
      return data.accessProposals ?? [];
    } catch (err) {
      if (
        err instanceof DriveApiError &&
        (err.status === 403 || err.status === 404)
      ) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Approves or denies a pending Drive access request (accessproposals.resolve).
   */
  async resolveAccessProposal(
    fileId: string,
    proposalId: string,
    options: {
      action: 'ACCEPT' | 'DENY';
      role?: 'reader' | 'writer';
      sendNotification?: boolean;
    },
  ): Promise<void> {
    const body: {
      action: 'ACCEPT' | 'DENY';
      role?: string[];
      sendNotification: boolean;
    } = {
      action: options.action,
      sendNotification: options.sendNotification ?? true,
    };
    if (options.action === 'ACCEPT') {
      body.role = [options.role ?? 'reader'];
    }
    await this.request(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/accessproposals/${encodeURIComponent(proposalId)}:resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  }
}
