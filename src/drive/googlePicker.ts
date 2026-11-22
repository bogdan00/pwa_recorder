import { recordSyncDebugEvent } from './debugLog';

export interface PickedDriveFolder {
  folderId: string;
  name: string;
}

interface GooglePickerDocument {
  id?: string;
  name?: string;
}

interface GooglePickerResponse {
  action?: string;
  docs?: GooglePickerDocument[];
}

interface GooglePickerBuilder {
  addView: (view: unknown) => GooglePickerBuilder;
  setOAuthToken: (token: string) => GooglePickerBuilder;
  setDeveloperKey: (key: string) => GooglePickerBuilder;
  setAppId?: (appId: string) => GooglePickerBuilder;
  setOrigin?: (origin: string) => GooglePickerBuilder;
  setTitle?: (title: string) => GooglePickerBuilder;
  setCallback: (cb: (data: GooglePickerResponse) => void) => GooglePickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
}

interface GooglePickerNamespace {
  DocsView: new (viewId?: unknown) => {
    setIncludeFolders?: (v: boolean) => unknown;
    setSelectFolderEnabled?: (v: boolean) => unknown;
    setMimeTypes?: (mime: string) => unknown;
    setMode?: (mode: unknown) => unknown;
  };
  ViewId: {
    FOLDERS?: unknown;
    DOCS?: unknown;
  };
  Action: {
    PICKED: string;
    CANCEL: string;
  };
  PickerBuilder: new () => GooglePickerBuilder;
}

declare global {
  interface Window {
    gapi?: {
      load: (lib: string, cb: () => void | { callback: () => void; onerror?: () => void }) => void;
    };
  }
}

function getGooglePickerApi(): GooglePickerNamespace | null {
  const g = (window as unknown as { google?: { picker?: GooglePickerNamespace } }).google;
  return g?.picker ?? null;
}

let gapiScriptPromise: Promise<void> | null = null;

function ensureGapiLoaded(): Promise<void> {
  if (getGooglePickerApi()) return Promise.resolve();
  if (window.gapi) {
    return new Promise((resolve) => {
      window.gapi!.load('picker', () => resolve());
    });
  }
  if (!gapiScriptPromise) {
    gapiScriptPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        'script[src="https://apis.google.com/js/api.js"]',
      );
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener(
          'error',
          () => reject(new Error('Could not load Google Picker script.')),
          { once: true },
        );
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error('Could not load Google Picker. Check your internet connection.'));
      document.head.appendChild(script);
    });
  }
  return gapiScriptPromise.then(
    () =>
      new Promise<void>((resolve, reject) => {
        if (getGooglePickerApi()) {
          resolve();
          return;
        }
        if (!window.gapi) {
          reject(new Error('Google Picker API is unavailable.'));
          return;
        }
        window.gapi.load('picker', () => resolve());
      }),
  );
}

/**
 * Launches Google Picker in Folder Selection mode so a collaborator can select a shared
 * Drive folder and officially grant StoryTape `drive.file` access to it without broader scopes.
 */
export async function pickSharedDriveFolder(options: {
  accessToken: string;
  apiKey?: string;
  clientId?: string;
  title?: string;
}): Promise<PickedDriveFolder | null> {
  recordSyncDebugEvent('picker', 'open_requested', {
    title: options.title,
    hasApiKey: Boolean(options.apiKey?.trim()),
    hasClientId: Boolean(options.clientId?.trim()),
  });
  await ensureGapiLoaded();
  const pickerApi = getGooglePickerApi();
  if (!pickerApi) {
    recordSyncDebugEvent('picker', 'init_failed', {});
    throw new Error('Google Picker could not be initialized.');
  }

  return new Promise<PickedDriveFolder | null>((resolve) => {
    const view = new pickerApi.DocsView(pickerApi.ViewId.FOLDERS);
    view.setIncludeFolders?.(true);
    view.setSelectFolderEnabled?.(true);
    view.setMimeTypes?.('application/vnd.google-apps.folder');

    const builder = new pickerApi.PickerBuilder()
      .addView(view)
      .setOAuthToken(options.accessToken)
      .setCallback((data) => {
        if (data.action === pickerApi.Action.PICKED && data.docs?.[0]?.id) {
          const picked = {
            folderId: data.docs[0].id,
            name: data.docs[0].name || 'Shared Audiobooks',
          };
          recordSyncDebugEvent('picker', 'folder_picked', picked);
          resolve(picked);
        } else if (data.action === pickerApi.Action.CANCEL) {
          recordSyncDebugEvent('picker', 'cancelled', {});
          resolve(null);
        }
      });

    if (options.apiKey?.trim()) {
      builder.setDeveloperKey(options.apiKey.trim());
    }
    const appId = options.clientId?.split('-')[0];
    if (appId && /^\d+$/.test(appId)) {
      builder.setAppId?.(appId);
    }
    builder.setOrigin?.(window.location.origin);
    builder.setTitle?.(options.title || 'Select Shared StoryTape Folder');

    const picker = builder.build();
    picker.setVisible(true);
  });
}
