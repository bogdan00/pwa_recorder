import type { DriveCollaboratorPermission } from '../types/models';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

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

  async getUserInfo(): Promise<{ email: string | null; displayName: string | null }> {
    const res = await fetch(
      `${DRIVE_API_BASE}/about?fields=user(displayName,emailAddress)`,
      { headers: this.authHeaders() },
    );
    if (!res.ok) throw await parseErrorResponse(res);
    const data = (await res.json()) as {
      user?: { displayName?: string; emailAddress?: string };
    };
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
    const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,ownedByMe,shared,capabilities(canEdit,canAddChildren,canShare))&pageSize=5`;

    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw await parseErrorResponse(res);
    const data = (await res.json()) as { files?: DriveFileSummary[] };
    return data.files?.[0] ?? null;
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFileSummary> {
    const metadata: Record<string, unknown> = {
      name,
      mimeType: FOLDER_MIME,
    };
    if (parentId) metadata.parents = [parentId];

    const res = await fetch(
      `${DRIVE_API_BASE}/files?fields=id,name,mimeType,modifiedTime,ownedByMe,shared,capabilities(canEdit,canAddChildren,canShare)`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(metadata),
      },
    );
    if (!res.ok) throw await parseErrorResponse(res);
    return (await res.json()) as DriveFileSummary;
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
    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,trashed,ownedByMe,shared,webViewLink,capabilities(canEdit,canAddChildren,canShare)`,
      { headers: this.authHeaders() },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await parseErrorResponse(res);
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
        fields:
          'nextPageToken,files(id,name,mimeType,size,modifiedTime,ownedByMe,shared,capabilities(canEdit,canAddChildren,canShare))',
        pageSize: '100',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await fetch(`${DRIVE_API_BASE}/files?${params.toString()}`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) throw await parseErrorResponse(res);
      const data = (await res.json()) as {
        files?: DriveFileSummary[];
        nextPageToken?: string;
      };
      if (data.files) files.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);

    return files;
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
      ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime`
      : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime`;

    const res = await fetch(url, {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: this.authHeaders({
        'Content-Type': `multipart/related; boundary=${boundary}`,
      }),
      body: multipartBody,
    });
    if (!res.ok) throw await parseErrorResponse(res);
    return (await res.json()) as DriveFileSummary;
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
      ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(existingFileId)}?uploadType=resumable&fields=id,name,mimeType,size,modifiedTime`
      : `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id,name,mimeType,size,modifiedTime`;

    const initRes = await fetch(initUrl, {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: this.authHeaders({
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(blob.size),
      }),
      body: JSON.stringify(metadata),
    });

    if (!initRes.ok) throw await parseErrorResponse(initRes);
    const uploadUri = initRes.headers.get('Location') || initRes.headers.get('location');
    if (!uploadUri) {
      throw new DriveApiError(500, 'Google Drive did not return a resumable upload URI.');
    }

    onProgress?.(0.05);

    const putRes = await fetch(uploadUri, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
      },
      body: blob,
    });

    if (!putRes.ok) throw await parseErrorResponse(putRes);
    onProgress?.(1);
    return (await putRes.json()) as DriveFileSummary;
  }

  async downloadFileBlob(fileId: string): Promise<Blob> {
    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: this.authHeaders() },
    );
    if (!res.ok) throw await parseErrorResponse(res);
    return res.blob();
  }

  async downloadJsonFile<T>(fileId: string): Promise<T> {
    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: this.authHeaders() },
    );
    if (!res.ok) throw await parseErrorResponse(res);
    return (await res.json()) as T;
  }

  async renameFile(fileId: string, newName: string): Promise<void> {
    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
      {
        method: 'PATCH',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: newName }),
      },
    );
    if (!res.ok) throw await parseErrorResponse(res);
  }

  async trashFile(fileId: string): Promise<void> {
    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
      {
        method: 'PATCH',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ trashed: true }),
      },
    );
    if (!res.ok && res.status !== 404) {
      throw await parseErrorResponse(res);
    }
  }

  // ============================================================================
  // Multi-User Collaboration & Sharing (Google Drive Permissions API v3)
  // ============================================================================

  async listPermissions(fileId: string): Promise<DriveCollaboratorPermission[]> {
    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions?fields=permissions(id,type,role,emailAddress,displayName)`,
      { headers: this.authHeaders() },
    );
    if (!res.ok) throw await parseErrorResponse(res);
    const data = (await res.json()) as {
      permissions?: DriveCollaboratorPermission[];
    };
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
      fields: 'id,type,role,emailAddress,displayName',
    });
    if (emailMessage?.trim()) {
      params.set('emailMessage', emailMessage.trim());
    }
    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions?${params.toString()}`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          type: 'user',
          role,
          emailAddress: email.trim(),
        }),
      },
    );
    if (!res.ok) throw await parseErrorResponse(res);
    return (await res.json()) as DriveCollaboratorPermission;
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
      const patchRes = await fetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(anyonePerm.id)}?fields=id,type,role,emailAddress,displayName`,
        {
          method: 'PATCH',
          headers: this.authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ role }),
        },
      );
      if (!patchRes.ok) throw await parseErrorResponse(patchRes);
      return (await patchRes.json()) as DriveCollaboratorPermission;
    }

    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions?fields=id,type,role,emailAddress,displayName`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          type: 'anyone',
          role,
        }),
      },
    );
    if (!res.ok) throw await parseErrorResponse(res);
    return (await res.json()) as DriveCollaboratorPermission;
  }

  async removePermission(fileId: string, permissionId: string): Promise<void> {
    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
      {
        method: 'DELETE',
        headers: this.authHeaders(),
      },
    );
    if (!res.ok && res.status !== 404) {
      throw await parseErrorResponse(res);
    }
  }
}
