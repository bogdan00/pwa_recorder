export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const GOOGLE_AUTH_STORAGE_KEY = 'storytape.googleAuth.v1';
const TOKEN_EXPIRY_BUFFER_MS = 15_000;
const PROACTIVE_REFRESH_BUFFER_MS = 5 * 60_000;
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

export type GoogleOAuthPrompt = '' | 'none' | 'consent' | 'select_account';

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GoogleCodeResponse {
  code?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface GoogleTokenOverrideConfig {
  prompt?: GoogleOAuthPrompt;
  login_hint?: string;
}

interface GoogleTokenClient {
  requestAccessToken: (overrideConfig?: GoogleTokenOverrideConfig) => void;
}

interface GoogleCodeClient {
  requestCode: () => void;
}

interface PersistedGoogleAuth {
  accessToken?: string | null;
  expiresAt?: number | null;
  encryptedRefreshToken?: string | null;
  grantedScope?: string | null;
  userEmail?: string | null;
  userName?: string | null;
  wasConnected?: boolean;
}

interface BrokerTokenResponse {
  accessToken?: string;
  expiresIn?: number;
  encryptedRefreshToken?: string;
  error?: string;
  message?: string;
}

declare global {
  interface Window {
    __STORYTAPE_AUTH_BROKER_URL__?: string;
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            prompt?: GoogleOAuthPrompt;
            login_hint?: string;
            callback: (resp: GoogleTokenResponse) => void;
            error_callback?: (err: { type?: string; message?: string }) => void;
          }) => GoogleTokenClient;
          initCodeClient?: (config: {
            client_id: string;
            scope: string;
            ux_mode?: 'popup' | 'redirect';
            select_account?: boolean;
            login_hint?: string;
            callback: (resp: GoogleCodeResponse) => void;
            error_callback?: (err: { type?: string; message?: string }) => void;
          }) => GoogleCodeClient;
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
  grantedScope: string | null;
  needsScopeUpgrade: boolean;
  userEmail: string | null;
  userName: string | null;
  wasConnected: boolean;
  hasPersistentRefresh: boolean;
  isRefreshing: boolean;
  gisLoaded: boolean;
  lastError: string | null;
}

function normalizeBrokerUrl(raw?: string | null): string {
  if (!raw) return '';
  return raw.trim().replace(/\/+$/, '');
}

export function getConfiguredAuthBrokerUrl(): string {
  // Explicit runtime test override takes precedence (including '' to disable a baked-in
  // CI build-time broker URL inside non-broker E2E tests — preserving ADR-09 parity).
  if (
    typeof window !== 'undefined' &&
    '__STORYTAPE_AUTH_BROKER_URL__' in window &&
    typeof window.__STORYTAPE_AUTH_BROKER_URL__ === 'string'
  ) {
    return normalizeBrokerUrl(window.__STORYTAPE_AUTH_BROKER_URL__);
  }
  const envUrl =
    typeof import.meta !== 'undefined' &&
    import.meta.env &&
    typeof import.meta.env.VITE_GOOGLE_AUTH_BROKER_URL === 'string'
      ? normalizeBrokerUrl(import.meta.env.VITE_GOOGLE_AUTH_BROKER_URL)
      : '';
  return envUrl;
}

export class GoogleAuthManager {
  private clientId = '';
  private brokerUrl = '';
  private encryptedRefreshToken: string | null = null;
  private tokenClient: GoogleTokenClient | null = null;
  private pendingResolve: ((token: string) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private refreshInFlight: Promise<string | null> | null = null;
  private state: GoogleAuthState = {
    status: 'unconfigured',
    accessToken: null,
    expiresAt: null,
    grantedScope: null,
    needsScopeUpgrade: false,
    userEmail: null,
    userName: null,
    wasConnected: false,
    hasPersistentRefresh: false,
    isRefreshing: false,
    gisLoaded: false,
    lastError: null,
  };
  private listeners = new Set<(state: GoogleAuthState) => void>();
  private pollTimer: number | null = null;
  private expiryTimer: number | null = null;
  private gisScriptRetryInjected = false;

  private readonly handleStorageEvent = (event: StorageEvent) => {
    if (event.key !== GOOGLE_AUTH_STORAGE_KEY) return;
    this.restoreSession();
    this.emit();
  };

  private readonly handleVisibilityChange = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') {
      return;
    }
    const prevStatus = this.state.status;
    const next = this.getState();
    if (next.status !== prevStatus) {
      this.emit();
    }
    if (this.canRefreshSilently() && (!this.hasValidToken() || this.shouldProactivelyRefresh())) {
      void this.refreshAccessTokenSilently();
    }
  };

  private readonly handleOnline = () => {
    if (this.canRefreshSilently() && (!this.hasValidToken() || this.shouldProactivelyRefresh())) {
      void this.refreshAccessTokenSilently();
    }
    if (!this.clientId || this.tokenClient) return;
    this.tryInitTokenClient();
    if (this.tokenClient) {
      this.emit();
      return;
    }
    if (this.gisScriptRetryInjected || typeof document === 'undefined') return;
    this.gisScriptRetryInjected = true;
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      this.tryInitTokenClient();
      this.emit();
    };
    document.head?.appendChild(script);
  };

  constructor() {
    this.brokerUrl = getConfiguredAuthBrokerUrl();
    this.restoreSession();
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleStorageEvent);
      window.addEventListener('online', this.handleOnline);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  dispose(): void {
    this.clearPollTimer();
    this.clearExpiryTimer();
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.handleStorageEvent);
      window.removeEventListener('online', this.handleOnline);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  subscribe(listener: (state: GoogleAuthState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): GoogleAuthState {
    // Re-evaluate expiry dynamically while preserving remembered account & encrypted refresh token
    if (
      this.state.status === 'connected' &&
      this.state.expiresAt &&
      Date.now() >= this.state.expiresAt - TOKEN_EXPIRY_BUFFER_MS
    ) {
      this.clearExpiryTimer();
      this.state = {
        ...this.state,
        status: this.clientId ? 'expired' : 'unconfigured',
        accessToken: null,
        expiresAt: null,
        wasConnected: true,
        hasPersistentRefresh: this.canRefreshSilently(),
      };
      this.persistSession();
    }
    return {
      ...this.state,
      hasPersistentRefresh: this.canRefreshSilently(),
    };
  }

  configure(clientId: string, brokerUrlOverride?: string): void {
    const trimmed = clientId.trim();
    const changed = trimmed !== this.clientId;
    this.clientId = trimmed;
    this.brokerUrl =
      brokerUrlOverride !== undefined
        ? normalizeBrokerUrl(brokerUrlOverride)
        : getConfiguredAuthBrokerUrl();

    if (!trimmed) {
      this.tokenClient = null;
      this.clearPollTimer();
      this.clearExpiryTimer();
      this.state = {
        ...this.state,
        status: 'unconfigured',
        accessToken: null,
        expiresAt: null,
        hasPersistentRefresh: false,
        lastError: null,
      };
      this.emit();
      return;
    }

    if (changed && this.state.status === 'unconfigured') {
      this.state = {
        ...this.state,
        status: this.hasValidToken()
          ? 'connected'
          : this.state.wasConnected
            ? 'expired'
            : 'disconnected',
      };
    }

    this.state = {
      ...this.state,
      hasPersistentRefresh: this.canRefreshSilently(),
    };

    this.tryInitTokenClient();
    if (!this.tokenClient && typeof window !== 'undefined' && this.pollTimer === null) {
      let attempts = 0;
      this.pollTimer = window.setInterval(() => {
        attempts += 1;
        this.tryInitTokenClient();
        if (this.tokenClient || attempts > 40) {
          this.clearPollTimer();
          if (this.tokenClient) {
            this.emit();
          }
        }
      }, 250);
    }

    if (this.state.status === 'connected') {
      this.scheduleRefreshOrExpiryCheck();
    }

    this.emit();

    // When backed by the Cloud Run OAuth broker, silently refresh expired/expiring tokens
    // immediately on boot / PWA update reload with zero popups or user taps.
    if (this.canRefreshSilently() && (!this.hasValidToken() || this.shouldProactivelyRefresh())) {
      void this.refreshAccessTokenSilently();
    }
  }

  hasValidToken(): boolean {
    const st = this.getState();
    return Boolean(st.accessToken && st.status === 'connected');
  }

  canRefreshSilently(): boolean {
    return Boolean(this.brokerUrl && this.encryptedRefreshToken);
  }

  getAccessToken(): string | null {
    const st = this.getState();
    return st.status === 'connected' ? st.accessToken : null;
  }

  /**
   * Returns a valid access token immediately if fresh, or silently refreshes via
   * the Cloud Run OAuth token broker when a persistent encrypted refresh token exists.
   */
  async ensureValidAccessToken(): Promise<string | null> {
    const current = this.getAccessToken();
    if (current) {
      if (this.shouldProactivelyRefresh()) {
        void this.refreshAccessTokenSilently();
      }
      return current;
    }
    if (this.canRefreshSilently()) {
      return this.refreshAccessTokenSilently();
    }
    return null;
  }

  /**
   * Silently refreshes the Google OAuth access token via the stateless Cloud Run broker.
   * Deduplicates concurrent refresh calls and preserves the encrypted refresh token across
   * transient offline / network failures.
   */
  async refreshAccessTokenSilently(options?: {
    force?: boolean;
  }): Promise<string | null> {
    if (!this.brokerUrl || !this.encryptedRefreshToken) {
      return null;
    }

    if (
      !options?.force &&
      this.hasValidToken() &&
      !this.shouldProactivelyRefresh()
    ) {
      return this.state.accessToken;
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const envelope = this.encryptedRefreshToken;
    const brokerEndpoint = `${this.brokerUrl}/auth/refresh`;

    this.state = {
      ...this.state,
      isRefreshing: true,
    };
    this.emit();

    const run = (async (): Promise<string | null> => {
      try {
        const res = await fetch(brokerEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ encryptedRefreshToken: envelope }),
        });

        const data = (await res.json().catch(() => ({}))) as BrokerTokenResponse;

        if (res.ok && data.accessToken) {
          const expiresInSec = data.expiresIn ?? 3600;
          const expiresAt = Date.now() + expiresInSec * 1000;
          if (data.encryptedRefreshToken) {
            this.encryptedRefreshToken = data.encryptedRefreshToken;
          }
          this.state = {
            ...this.state,
            status: 'connected',
            accessToken: data.accessToken,
            expiresAt,
            grantedScope: this.state.grantedScope ?? DRIVE_SCOPE,
            needsScopeUpgrade: false,
            wasConnected: true,
            hasPersistentRefresh: this.canRefreshSilently(),
            isRefreshing: false,
            lastError: null,
          };
          this.persistSession();
          this.scheduleRefreshOrExpiryCheck();
          this.emit();
          return data.accessToken;
        }

        // Permanent grant revocation or invalid envelope -> clear refresh token so user can 1-tap reconnect
        if (res.status === 401 || data.error === 'invalid_grant') {
          this.clearExpiryTimer();
          this.encryptedRefreshToken = null;
          this.state = {
            ...this.state,
            status: this.clientId ? 'expired' : 'unconfigured',
            accessToken: null,
            expiresAt: null,
            wasConnected: true,
            hasPersistentRefresh: false,
            isRefreshing: false,
            lastError: null,
          };
          this.persistSession();
          this.emit();
          return null;
        }

        // Transient upstream/5xx error: keep encryptedRefreshToken intact for retry when healthy
        this.state = {
          ...this.state,
          isRefreshing: false,
        };
        this.emit();
        return this.getAccessToken();
      } catch {
        // Offline / network failure: keep encryptedRefreshToken intact so next online event recovers silently
        this.state = {
          ...this.state,
          isRefreshing: false,
        };
        this.emit();
        return this.getAccessToken();
      } finally {
        this.refreshInFlight = null;
      }
    })();

    this.refreshInFlight = run;
    return run;
  }

  markExpired(message?: string): void {
    this.clearExpiryTimer();
    this.state = {
      ...this.state,
      status: this.clientId ? 'expired' : 'unconfigured',
      accessToken: null,
      expiresAt: null,
      wasConnected: true,
      hasPersistentRefresh: this.canRefreshSilently(),
      isRefreshing: false,
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
   *
   * - When `VITE_GOOGLE_AUTH_BROKER_URL` is configured and GIS `initCodeClient` is available:
   *   runs the Authorization Code flow and exchanges the code via the Cloud Run broker for
   *   an AES-256-GCM encrypted long-lived refresh token.
   * - Otherwise (zero-infra fallback):
   *   runs GIS `initTokenClient` with explicit `prompt: ''` + `login_hint` so returning users
   *   skip account selection and consent screens.
   */
  requestSignIn(prompt?: GoogleOAuthPrompt): Promise<string> {
    if (!this.clientId) {
      return Promise.reject(
        new Error('Google Drive sign-in is not available in this build.'),
      );
    }

    const oauth2 =
      typeof window !== 'undefined' ? window.google?.accounts?.oauth2 : undefined;
    const initCodeClient = oauth2?.initCodeClient;

    // Mode 1: Stateless Cloud Run OAuth broker (Authorization Code flow -> persistent refresh token)
    if (this.brokerUrl && typeof initCodeClient === 'function') {
      this.state.gisLoaded = true;
      return new Promise<string>((resolve, reject) => {
        this.pendingResolve = resolve;
        this.pendingReject = reject;
        try {
          const codeClient = initCodeClient({
            client_id: this.clientId,
            scope: DRIVE_SCOPE,
            ux_mode: 'popup',
            select_account: prompt === 'select_account',
            ...(this.state.userEmail && prompt !== 'select_account'
              ? { login_hint: this.state.userEmail }
              : {}),
            callback: (resp) => {
              if (resp.error || !resp.code) {
                const msg =
                  resp.error_description || resp.error || 'Google Drive sign-in failed.';
                this.state = { ...this.state, lastError: msg };
                this.emit();
                const rej = this.pendingReject;
                this.pendingResolve = null;
                this.pendingReject = null;
                rej?.(new Error(msg));
                return;
              }
              void this.exchangeAuthorizationCode(resp.code);
            },
            error_callback: (err) => {
              this.handleGisPopupError(err);
            },
          });
          codeClient.requestCode();
        } catch (err) {
          this.pendingResolve = null;
          this.pendingReject = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }

    // Mode 2: Zero-infra browser GIS Token Model with explicit prompt:'' + login_hint
    // (forces prompt:'consent' once when upgrading from legacy drive.file sessions)
    this.tryInitTokenClient();
    if (!this.tokenClient) {
      return Promise.reject(
        new Error(
          'Google Sign-In script is still loading or blocked offline. Check your internet connection and try again.',
        ),
      );
    }

    const effectivePrompt: GoogleOAuthPrompt =
      prompt ?? (this.state.needsScopeUpgrade ? 'consent' : '');
    const overrideConfig: GoogleTokenOverrideConfig = {
      prompt: effectivePrompt,
    };
    if (this.state.userEmail && effectivePrompt !== 'select_account') {
      overrideConfig.login_hint = this.state.userEmail;
    }

    return new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      try {
        this.tokenClient!.requestAccessToken(overrideConfig);
      } catch (err) {
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  signOut(): void {
    this.clearExpiryTimer();
    const token = this.state.accessToken;
    const envelope = this.encryptedRefreshToken;
    this.encryptedRefreshToken = null;
    this.refreshInFlight = null;

    if (this.brokerUrl && (envelope || token)) {
      void fetch(`${this.brokerUrl}/auth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(envelope ? { encryptedRefreshToken: envelope } : {}),
          ...(token ? { accessToken: token } : {}),
        }),
      }).catch(() => {
        // Ignore network errors on sign-out revocation
      });
    } else if (token && window.google?.accounts?.oauth2?.revoke) {
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
      grantedScope: null,
      needsScopeUpgrade: false,
      userEmail: null,
      userName: null,
      wasConnected: false,
      hasPersistentRefresh: false,
      isRefreshing: false,
      lastError: null,
    };
    this.clearPersistedSession();
    this.emit();
  }

  private async exchangeAuthorizationCode(code: string): Promise<void> {
    try {
      const res = await fetch(`${this.brokerUrl}/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = (await res.json().catch(() => ({}))) as BrokerTokenResponse;
      if (!res.ok || !data.accessToken) {
        const msg =
          data.message || data.error || 'Could not complete Google Drive sign-in.';
        this.state = { ...this.state, lastError: msg };
        this.emit();
        const rej = this.pendingReject;
        this.pendingResolve = null;
        this.pendingReject = null;
        rej?.(new Error(msg));
        return;
      }

      if (data.encryptedRefreshToken) {
        this.encryptedRefreshToken = data.encryptedRefreshToken;
      }
      const expiresInSec = data.expiresIn ?? 3600;
      const expiresAt = Date.now() + expiresInSec * 1000;

      this.state = {
        ...this.state,
        status: 'connected',
        accessToken: data.accessToken,
        expiresAt,
        grantedScope: DRIVE_SCOPE,
        needsScopeUpgrade: false,
        wasConnected: true,
        hasPersistentRefresh: this.canRefreshSilently(),
        isRefreshing: false,
        lastError: null,
      };
      this.persistSession();
      this.scheduleRefreshOrExpiryCheck();
      this.emit();

      const resFn = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      resFn?.(data.accessToken);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Could not reach Google Drive authentication service.';
      this.state = { ...this.state, lastError: msg };
      this.emit();
      const rej = this.pendingReject;
      this.pendingResolve = null;
      this.pendingReject = null;
      rej?.(new Error(msg));
    }
  }

  private handleGisPopupError(err: { type?: string; message?: string }): void {
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
  }

  private tryInitTokenClient(): void {
    if (!this.clientId) return;
    const oauth2 =
      typeof window !== 'undefined' ? window.google?.accounts?.oauth2 : undefined;
    if (!oauth2 || typeof oauth2.initTokenClient !== 'function') return;

    this.state.gisLoaded = true;
    this.tokenClient = oauth2.initTokenClient({
      client_id: this.clientId,
      scope: DRIVE_SCOPE,
      prompt: '',
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
          grantedScope: DRIVE_SCOPE,
          needsScopeUpgrade: false,
          wasConnected: true,
          hasPersistentRefresh: this.canRefreshSilently(),
          isRefreshing: false,
          lastError: null,
        };
        this.persistSession();
        this.scheduleRefreshOrExpiryCheck();
        this.emit();

        const res = this.pendingResolve;
        this.pendingResolve = null;
        this.pendingReject = null;
        res?.(resp.access_token);
      },
      error_callback: (err) => {
        this.handleGisPopupError(err);
      },
    });
  }

  private shouldProactivelyRefresh(): boolean {
    if (!this.canRefreshSilently()) return false;
    if (this.state.status !== 'connected' || !this.state.expiresAt) {
      return true;
    }
    return Date.now() >= this.state.expiresAt - PROACTIVE_REFRESH_BUFFER_MS;
  }

  private scheduleRefreshOrExpiryCheck(): void {
    this.clearExpiryTimer();
    if (
      typeof window === 'undefined' ||
      this.state.status !== 'connected' ||
      !this.state.expiresAt
    ) {
      return;
    }

    const remainingMs = this.state.expiresAt - Date.now();
    if (this.canRefreshSilently()) {
      const leadMs = Math.min(
        PROACTIVE_REFRESH_BUFFER_MS,
        Math.max(TOKEN_EXPIRY_BUFFER_MS, Math.floor(remainingMs * 0.25)),
      );
      const delayMs = remainingMs - leadMs;
      if (delayMs <= 0) {
        void this.refreshAccessTokenSilently();
        return;
      }
      this.expiryTimer = window.setTimeout(() => {
        this.expiryTimer = null;
        void this.refreshAccessTokenSilently();
      }, delayMs);
      return;
    }

    const delayMs = remainingMs - TOKEN_EXPIRY_BUFFER_MS;
    if (delayMs <= 0) {
      this.getState();
      return;
    }
    this.expiryTimer = window.setTimeout(() => {
      this.expiryTimer = null;
      const prevStatus = this.state.status;
      const next = this.getState();
      if (next.status !== prevStatus) {
        this.emit();
      }
    }, delayMs);
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private persistSession(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      const payload: PersistedGoogleAuth = {
        accessToken: this.state.accessToken,
        expiresAt: this.state.expiresAt,
        encryptedRefreshToken: this.encryptedRefreshToken,
        grantedScope: this.state.grantedScope,
        userEmail: this.state.userEmail,
        userName: this.state.userName,
        wasConnected: this.state.wasConnected,
      };
      window.localStorage.setItem(GOOGLE_AUTH_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore private mode / quota errors
    }
  }

  private clearPersistedSession(): void {
    try {
      window.localStorage?.removeItem(GOOGLE_AUTH_STORAGE_KEY);
    } catch {
      // Ignore
    }
    try {
      window.sessionStorage?.removeItem(GOOGLE_AUTH_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }

  private restoreSession(): void {
    this.clearExpiryTimer();
    try {
      if (typeof window === 'undefined') return;
      let raw: string | null = null;
      let migratedFromSession = false;

      try {
        raw = window.localStorage?.getItem(GOOGLE_AUTH_STORAGE_KEY) ?? null;
      } catch {
        raw = null;
      }

      // Migrate legacy sessionStorage entries from older PWA versions seamlessly
      if (!raw) {
        try {
          raw = window.sessionStorage?.getItem(GOOGLE_AUTH_STORAGE_KEY) ?? null;
          if (raw) migratedFromSession = true;
        } catch {
          raw = null;
        }
      }

      if (!raw) {
        this.encryptedRefreshToken = null;
        this.state = {
          ...this.state,
          status: this.clientId ? 'disconnected' : 'unconfigured',
          accessToken: null,
          expiresAt: null,
          grantedScope: null,
          needsScopeUpgrade: false,
          userEmail: null,
          userName: null,
          wasConnected: false,
          hasPersistentRefresh: false,
          isRefreshing: false,
          lastError: null,
        };
        return;
      }

      const saved = JSON.parse(raw) as PersistedGoogleAuth;
      this.encryptedRefreshToken =
        typeof saved.encryptedRefreshToken === 'string' &&
        saved.encryptedRefreshToken.trim()
          ? saved.encryptedRefreshToken.trim()
          : null;

      const remembered = Boolean(
        saved.wasConnected ||
          saved.userEmail ||
          saved.accessToken ||
          this.encryptedRefreshToken,
      );

      const savedScope =
        typeof saved.grantedScope === 'string' && saved.grantedScope.trim()
          ? saved.grantedScope.trim()
          : null;
      const needsScopeUpgrade = remembered && savedScope !== DRIVE_SCOPE;
      let purgedLegacyScopeCreds = false;

      if (needsScopeUpgrade) {
        // Legacy drive.file sessions (including persisted Cloud Run refresh tokens)
        // cannot recursively read collaborator subfolders/files inside shared folders.
        // Drop the legacy token/refresh envelope while remembering the account so
        // the user gets a clean 1-tap Reconnect prompt for the upgraded drive scope.
        purgedLegacyScopeCreds = Boolean(
          saved.accessToken || this.encryptedRefreshToken,
        );
        this.encryptedRefreshToken = null;
        this.state = {
          ...this.state,
          status: this.clientId ? 'expired' : 'unconfigured',
          accessToken: null,
          expiresAt: null,
          grantedScope: savedScope,
          needsScopeUpgrade: true,
          userEmail: saved.userEmail ?? null,
          userName: saved.userName ?? null,
          wasConnected: true,
          hasPersistentRefresh: false,
          isRefreshing: false,
          lastError: null,
        };
      } else if (
        saved.accessToken &&
        saved.expiresAt &&
        Date.now() < saved.expiresAt - TOKEN_EXPIRY_BUFFER_MS
      ) {
        this.state = {
          ...this.state,
          status: 'connected',
          accessToken: saved.accessToken,
          expiresAt: saved.expiresAt,
          grantedScope: DRIVE_SCOPE,
          needsScopeUpgrade: false,
          userEmail: saved.userEmail ?? null,
          userName: saved.userName ?? null,
          wasConnected: true,
          hasPersistentRefresh: this.canRefreshSilently(),
          isRefreshing: false,
          lastError: null,
        };
        this.scheduleRefreshOrExpiryCheck();
      } else if (remembered) {
        this.state = {
          ...this.state,
          status: this.clientId ? 'expired' : 'unconfigured',
          accessToken: null,
          expiresAt: null,
          grantedScope: savedScope,
          needsScopeUpgrade: false,
          userEmail: saved.userEmail ?? null,
          userName: saved.userName ?? null,
          wasConnected: true,
          hasPersistentRefresh: this.canRefreshSilently(),
          isRefreshing: false,
          lastError: null,
        };
      } else {
        this.encryptedRefreshToken = null;
        this.state = {
          ...this.state,
          status: this.clientId ? 'disconnected' : 'unconfigured',
          accessToken: null,
          expiresAt: null,
          grantedScope: null,
          needsScopeUpgrade: false,
          userEmail: null,
          userName: null,
          wasConnected: false,
          hasPersistentRefresh: false,
          isRefreshing: false,
          lastError: null,
        };
      }

      if (migratedFromSession || purgedLegacyScopeCreds) {
        this.persistSession();
        if (migratedFromSession) {
          try {
            window.sessionStorage?.removeItem(GOOGLE_AUTH_STORAGE_KEY);
          } catch {
            // Ignore
          }
        }
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
