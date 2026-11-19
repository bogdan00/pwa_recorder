const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SESSION_KEY = 'storytape.googleAuth.v1';

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GoogleTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (resp: GoogleTokenResponse) => void;
            error_callback?: (err: { type?: string; message?: string }) => void;
          }) => GoogleTokenClient;
          revoke?: (token: string, done?: () => void) => void;
        };
      };
    };
  }
}

export interface GoogleAuthState {
  status: 'unconfigured' | 'disconnected' | 'connected' | 'expired';
  accessToken: string | null;
  expiresAt: number | null;
  userEmail: string | null;
  userName: string | null;
  gisLoaded: boolean;
  lastError: string | null;
}

class GoogleAuthManager {
  private clientId = '';
  private tokenClient: GoogleTokenClient | null = null;
  private pendingResolve: ((token: string) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private state: GoogleAuthState = {
    status: 'unconfigured',
    accessToken: null,
    expiresAt: null,
    userEmail: null,
    userName: null,
    gisLoaded: false,
    lastError: null,
  };
  private listeners = new Set<(state: GoogleAuthState) => void>();
  private pollTimer: number | null = null;

  constructor() {
    this.restoreSession();
  }

  subscribe(listener: (state: GoogleAuthState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): GoogleAuthState {
    // Re-evaluate expiry dynamically
    if (
      this.state.status === 'connected' &&
      this.state.expiresAt &&
      Date.now() >= this.state.expiresAt - 15_000
    ) {
      this.state = {
        ...this.state,
        status: 'expired',
        accessToken: null,
      };
    }
    return { ...this.state };
  }

  configure(clientId: string): void {
    const trimmed = clientId.trim();
    const changed = trimmed !== this.clientId;
    this.clientId = trimmed;

    if (!trimmed) {
      this.tokenClient = null;
      this.state = {
        ...this.state,
        status: 'unconfigured',
        accessToken: null,
        expiresAt: null,
        lastError: null,
      };
      this.emit();
      return;
    }

    if (changed && this.state.status === 'unconfigured') {
      this.state = {
        ...this.state,
        status: this.hasValidToken() ? 'connected' : 'disconnected',
      };
    }

    this.tryInitTokenClient();
    if (!this.tokenClient && typeof window !== 'undefined' && this.pollTimer === null) {
      let attempts = 0;
      this.pollTimer = window.setInterval(() => {
        attempts += 1;
        this.tryInitTokenClient();
        if (this.tokenClient || attempts > 40) {
          if (this.pollTimer !== null) {
            window.clearInterval(this.pollTimer);
            this.pollTimer = null;
          }
        }
      }, 250);
    }

    this.emit();
  }

  hasValidToken(): boolean {
    const st = this.getState();
    return Boolean(st.accessToken && st.status === 'connected');
  }

  getAccessToken(): string | null {
    const st = this.getState();
    return st.status === 'connected' ? st.accessToken : null;
  }

  markExpired(message?: string): void {
    this.state = {
      ...this.state,
      status: this.clientId ? 'expired' : 'unconfigured',
      accessToken: null,
      expiresAt: null,
      lastError: message || 'Google Drive session expired. Tap Reconnect to sync.',
    };
    this.persistSession();
    this.emit();
  }

  setUserProfile(email: string | null, name: string | null): void {
    this.state = {
      ...this.state,
      userEmail: email,
      userName: name,
    };
    this.persistSession();
    this.emit();
  }

  /**
   * Must be invoked directly from a user tap/click handler so iOS Safari standalone PWAs
   * allow the Google Identity Services OAuth window without popup blocking.
   */
  requestSignIn(prompt: '' | 'consent' | 'select_account' = ''): Promise<string> {
    if (!this.clientId) {
      return Promise.reject(
        new Error('Enter your Google Cloud OAuth Client ID first.'),
      );
    }
    this.tryInitTokenClient();
    if (!this.tokenClient) {
      return Promise.reject(
        new Error(
          'Google Sign-In script is still loading or blocked offline. Check your internet connection and try again.',
        ),
      );
    }

    return new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      try {
        this.tokenClient!.requestAccessToken(prompt ? { prompt } : undefined);
      } catch (err) {
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  signOut(): void {
    const token = this.state.accessToken;
    if (token && window.google?.accounts?.oauth2?.revoke) {
      try {
        window.google.accounts.oauth2.revoke(token);
      } catch {
        // Ignore revoke errors
      }
    }
    this.state = {
      ...this.state,
      status: this.clientId ? 'disconnected' : 'unconfigured',
      accessToken: null,
      expiresAt: null,
      userEmail: null,
      userName: null,
      lastError: null,
    };
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Ignore
    }
    this.emit();
  }

  private tryInitTokenClient(): void {
    if (!this.clientId) return;
    const oauth2 =
      typeof window !== 'undefined' ? window.google?.accounts?.oauth2 : undefined;
    if (!oauth2 || typeof oauth2.initTokenClient !== 'function') return;

    this.state.gisLoaded = true;
    this.tokenClient = oauth2.initTokenClient({
      client_id: this.clientId,
      scope: DRIVE_FILE_SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          const msg =
            resp.error_description || resp.error || 'Google Drive sign-in failed.';
          this.state = {
            ...this.state,
            lastError: msg,
          };
          this.emit();
          const rej = this.pendingReject;
          this.pendingResolve = null;
          this.pendingReject = null;
          rej?.(new Error(msg));
          return;
        }

        const expiresInSec = resp.expires_in ?? 3600;
        const expiresAt = Date.now() + expiresInSec * 1000;
        this.state = {
          ...this.state,
          status: 'connected',
          accessToken: resp.access_token,
          expiresAt,
          lastError: null,
        };
        this.persistSession();
        this.emit();

        const res = this.pendingResolve;
        this.pendingResolve = null;
        this.pendingReject = null;
        res?.(resp.access_token);
      },
      error_callback: (err) => {
        const msg =
          err?.type === 'popup_closed'
            ? 'Sign-in popup was closed before completing.'
            : err?.type === 'popup_failed_to_open'
              ? 'Popup was blocked. Please allow popups or open StoryTape in Safari/Chrome to sign in.'
              : err?.message || 'Google authentication failed.';
        this.state = { ...this.state, lastError: msg };
        this.emit();
        const rej = this.pendingReject;
        this.pendingResolve = null;
        this.pendingReject = null;
        rej?.(new Error(msg));
      },
    });
  }

  private persistSession(): void {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      window.sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          accessToken: this.state.accessToken,
          expiresAt: this.state.expiresAt,
          userEmail: this.state.userEmail,
          userName: this.state.userName,
        }),
      );
    } catch {
      // Ignore private mode errors
    }
  }

  private restoreSession(): void {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      const raw = window.sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        accessToken?: string | null;
        expiresAt?: number | null;
        userEmail?: string | null;
        userName?: string | null;
      };
      if (saved.accessToken && saved.expiresAt && Date.now() < saved.expiresAt - 15_000) {
        this.state = {
          ...this.state,
          status: 'connected',
          accessToken: saved.accessToken,
          expiresAt: saved.expiresAt,
          userEmail: saved.userEmail ?? null,
          userName: saved.userName ?? null,
        };
      }
    } catch {
      // Ignore corrupt session
    }
  }

  private emit(): void {
    const snap = this.getState();
    this.listeners.forEach((fn) => fn(snap));
  }
}

export const googleAuth = new GoogleAuthManager();
