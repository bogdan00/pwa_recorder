export type ShareScope = 'library' | 'book';

export interface JoinShareInvite {
  folderId: string;
  name: string;
  scope: ShareScope;
  role: 'writer' | 'reader';
  clientId?: string;
}

export function getDriveFolderWebUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}

export function buildJoinShareUrl(invite: JoinShareInvite): string {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://bogdan00.github.io';
  const pathname =
    typeof window !== 'undefined' ? window.location.pathname : '/pwa_recorder/';
  const params = new URLSearchParams();
  params.set('folderId', invite.folderId);
  if (invite.name.trim()) params.set('name', invite.name.trim());
  params.set('scope', invite.scope);
  params.set('role', invite.role);
  if (invite.clientId?.trim()) {
    params.set('clientId', invite.clientId.trim());
  }
  return `${origin}${pathname}#/join?${params.toString()}`;
}

/**
 * Parses a StoryTape `#/join?...` link, a Google Drive folder URL, or a raw Drive Folder ID.
 */
export function parseJoinInviteInput(rawInput: string): JoinShareInvite | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  // 1. StoryTape invite URL or hash fragment (#/join?folderId=...)
  const hashIdx = trimmed.indexOf('#/join');
  if (hashIdx >= 0 || trimmed.startsWith('join?')) {
    const queryIdx = trimmed.indexOf('?', Math.max(0, hashIdx));
    if (queryIdx >= 0) {
      const params = new URLSearchParams(trimmed.slice(queryIdx + 1));
      const folderId = params.get('folderId')?.trim();
      if (folderId) {
        const scopeParam = params.get('scope');
        const roleParam = params.get('role');
        return {
          folderId,
          name: params.get('name')?.trim() || 'Shared Audiobooks',
          scope: scopeParam === 'book' ? 'book' : 'library',
          role: roleParam === 'reader' ? 'reader' : 'writer',
          clientId: params.get('clientId')?.trim() || undefined,
        };
      }
    }
  }

  // 2. Google Drive folder URL:
  //    https://drive.google.com/drive/folders/<ID>?usp=sharing
  //    https://drive.google.com/drive/u/0/folders/<ID>
  //    https://drive.google.com/open?id=<ID>
  const folderMatch = trimmed.match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/)([A-Za-z0-9_-]{6,})/);
  if (folderMatch?.[1]) {
    return {
      folderId: folderMatch[1],
      name: 'Shared Audiobooks',
      scope: 'library',
      role: 'writer',
    };
  }

  const openIdMatch = trimmed.match(/drive\.google\.com\/open\?[^#]*id=([A-Za-z0-9_-]{6,})/);
  if (openIdMatch?.[1]) {
    return {
      folderId: openIdMatch[1],
      name: 'Shared Audiobooks',
      scope: 'library',
      role: 'writer',
    };
  }

  // 3. Raw Google Drive folder ID
  if (/^[A-Za-z0-9_-]{8,128}$/.test(trimmed)) {
    return {
      folderId: trimmed,
      name: 'Shared Audiobooks',
      scope: 'library',
      role: 'writer',
    };
  }

  return null;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy textarea fallback
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Shares an invite link via Web Share API on mobile, falling back cleanly to clipboard copy.
 */
export async function shareInviteLink(params: {
  title: string;
  text: string;
  url: string;
}): Promise<'shared' | 'copied' | 'cancelled'> {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: params.title,
        text: params.text,
        url: params.url,
      });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return 'cancelled';
      }
      // Fall through to clipboard copy if share failed
    }
  }
  await copyTextToClipboard(params.url);
  return 'copied';
}

/**
 * Shares a recorded chapter audio file via native Web Share API (AirDrop, WhatsApp, Messages)
 * with automatic download fallback on unsupported browsers.
 */
export async function shareAudioChapter(params: {
  blob: Blob;
  fileName: string;
  title: string;
  text: string;
}): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof File !== 'undefined'
  ) {
    try {
      const file = new File([params.blob], params.fileName, {
        type: params.blob.type || 'audio/mp4',
      });
      const shareData: ShareData = {
        title: params.title,
        text: params.text,
        files: [file],
      };
      const canShare =
        typeof navigator.canShare === 'function'
          ? navigator.canShare(shareData)
          : true;
      if (canShare) {
        await navigator.share(shareData);
        return 'shared';
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return 'cancelled';
      }
      // Fall back to browser download
    }
  }

  const url = URL.createObjectURL(params.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = params.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'downloaded';
}
