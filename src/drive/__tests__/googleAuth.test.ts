import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRIVE_SCOPE,
  GOOGLE_AUTH_STORAGE_KEY,
  GoogleAuthManager,
  getConfiguredAuthBrokerUrl,
  type GoogleTokenOverrideConfig,
} from '../googleAuth';

interface MockGisHarness {
  initConfigs: Array<{ client_id: string; scope: string; prompt?: string }>;
  requestCalls: Array<GoogleTokenOverrideConfig | undefined>;
  revokeMock: ReturnType<typeof vi.fn>;
  nextToken: string;
  nextExpiresIn: number;
}

function installMockGis(overrides?: Partial<MockGisHarness>): MockGisHarness {
  const harness: MockGisHarness = {
    initConfigs: [],
    requestCalls: [],
    revokeMock: vi.fn(),
    nextToken: 'tok-fresh-1',
    nextExpiresIn: 3600,
    ...overrides,
  };

  window.google = {
    accounts: {
      oauth2: {
        initTokenClient: (cfg) => {
          harness.initConfigs.push({
            client_id: cfg.client_id,
            scope: cfg.scope,
            prompt: cfg.prompt,
          });
          return {
            requestAccessToken: (overrideConfig) => {
              harness.requestCalls.push(overrideConfig);
              cfg.callback({
                access_token: harness.nextToken,
                expires_in: harness.nextExpiresIn,
              });
            },
          };
        },
        revoke: harness.revokeMock,
      },
    },
  };

  return harness;
}

describe('GoogleAuthManager persistent PWA session & fast reconnect', () => {
  const activeManagers: GoogleAuthManager[] = [];

  const createManager = () => {
    const mgr = new GoogleAuthManager();
    activeManagers.push(mgr);
    return mgr;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T12:00:00.000Z'));
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete window.google;
  });

  afterEach(() => {
    while (activeManagers.length > 0) {
      activeManagers.pop()?.dispose();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete window.google;
  });

  it('persists active access token and profile in localStorage so PWA updates / cleared sessionStorage stay connected', async () => {
    const gis = installMockGis({ nextToken: 'tok-initial', nextExpiresIn: 3600 });
    const mgr1 = createManager();
    mgr1.configure('test-client-id');

    const token = await mgr1.requestSignIn();
    expect(token).toBe('tok-initial');
    expect(gis.initConfigs[0]?.scope).toBe(DRIVE_SCOPE);
    expect(gis.initConfigs[0]?.prompt).toBe('');
    expect(gis.requestCalls[0]).toEqual({ prompt: '' });

    mgr1.setUserProfile('parent@example.com', 'Story Parent');
    expect(window.localStorage.getItem(GOOGLE_AUTH_STORAGE_KEY)).toBeTruthy();

    // Simulate a PWA update / standalone WebView restart where sessionStorage is wiped
    window.sessionStorage.clear();

    const mgr2 = createManager();
    mgr2.configure('test-client-id');

    expect(mgr2.hasValidToken()).toBe(true);
    expect(mgr2.getAccessToken()).toBe('tok-initial');
    expect(mgr2.getState()).toMatchObject({
      status: 'connected',
      accessToken: 'tok-initial',
      grantedScope: DRIVE_SCOPE,
      needsScopeUpgrade: false,
      userEmail: 'parent@example.com',
      userName: 'Story Parent',
      wasConnected: true,
      lastError: null,
    });
  });

  it('migrates legacy sessionStorage sessions into localStorage on first load after update', () => {
    const expiresAt = Date.now() + 1800_000;
    window.sessionStorage.setItem(
      GOOGLE_AUTH_STORAGE_KEY,
      JSON.stringify({
        accessToken: 'legacy-session-token',
        expiresAt,
        grantedScope: DRIVE_SCOPE,
        userEmail: 'legacy@example.com',
        userName: 'Legacy User',
      }),
    );

    const mgr = createManager();
    mgr.configure('test-client-id');

    expect(mgr.hasValidToken()).toBe(true);
    expect(mgr.getAccessToken()).toBe('legacy-session-token');
    expect(mgr.getState().userEmail).toBe('legacy@example.com');
    expect(window.sessionStorage.getItem(GOOGLE_AUTH_STORAGE_KEY)).toBeNull();

    const migrated = JSON.parse(
      window.localStorage.getItem(GOOGLE_AUTH_STORAGE_KEY) || '{}',
    ) as { accessToken?: string; wasConnected?: boolean; userEmail?: string; grantedScope?: string };
    expect(migrated).toMatchObject({
      accessToken: 'legacy-session-token',
      grantedScope: DRIVE_SCOPE,
      wasConnected: true,
      userEmail: 'legacy@example.com',
    });
  });

  it('invalidates legacy drive.file tokens and refresh envelopes on restore and forces one-time consent on reconnect', async () => {
    const gis = installMockGis({ nextToken: 'tok-upgraded-drive', nextExpiresIn: 3600 });
    window.localStorage.setItem(
      GOOGLE_AUTH_STORAGE_KEY,
      JSON.stringify({
        accessToken: 'tok-old-drive-file',
        expiresAt: Date.now() + 3600_000,
        encryptedRefreshToken: 'v1.legacy-drive-file-envelope',
        userEmail: 'mom@example.com',
        userName: 'Mom',
        wasConnected: true,
      }),
    );

    const mgr = createManager();
    mgr.configure('test-client-id', 'https://auth.example.com');

    expect(mgr.hasValidToken()).toBe(false);
    expect(mgr.canRefreshSilently()).toBe(false);
    expect(mgr.getState()).toMatchObject({
      status: 'expired',
      accessToken: null,
      grantedScope: null,
      needsScopeUpgrade: true,
      userEmail: 'mom@example.com',
      userName: 'Mom',
      wasConnected: true,
      hasPersistentRefresh: false,
    });

    // Persisted storage should already have the stale drive.file credentials scrubbed
    const scrubbed = JSON.parse(
      window.localStorage.getItem(GOOGLE_AUTH_STORAGE_KEY) || '{}',
    ) as { accessToken?: string | null; encryptedRefreshToken?: string | null; userEmail?: string };
    expect(scrubbed.accessToken).toBeNull();
    expect(scrubbed.encryptedRefreshToken).toBeNull();
    expect(scrubbed.userEmail).toBe('mom@example.com');

    // Reconnecting in Token Model passes prompt:'consent' once with login_hint
    const upgradedToken = await mgr.requestSignIn();
    expect(upgradedToken).toBe('tok-upgraded-drive');
    expect(gis.initConfigs.at(-1)?.scope).toBe(DRIVE_SCOPE);
    expect(gis.requestCalls.at(-1)).toEqual({
      prompt: 'consent',
      login_hint: 'mom@example.com',
    });
    expect(mgr.getState()).toMatchObject({
      status: 'connected',
      grantedScope: DRIVE_SCOPE,
      needsScopeUpgrade: false,
    });
  });

  it('retains remembered account in expired state after 1 hour and passes explicit prompt:"" + login_hint on reconnect', async () => {
    const gis = installMockGis({ nextToken: 'tok-day-1', nextExpiresIn: 3600 });
    const mgr1 = createManager();
    mgr1.configure('test-client-id');
    await mgr1.requestSignIn();
    mgr1.setUserProfile('mom@example.com', 'Mom');

    // Advance 2 hours so the 1h OAuth access token is expired when the user reopens/updates the PWA
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    window.sessionStorage.clear();

    const mgr2 = createManager();
    mgr2.configure('test-client-id');

    expect(mgr2.hasValidToken()).toBe(false);
    expect(mgr2.getState()).toMatchObject({
      status: 'expired',
      accessToken: null,
      userEmail: 'mom@example.com',
      userName: 'Mom',
      wasConnected: true,
      lastError: null,
    });

    // 1-tap reconnect passes explicit empty prompt + login_hint so Google skips account chooser & consent
    gis.nextToken = 'tok-day-2';
    const refreshed = await mgr2.requestSignIn();
    expect(refreshed).toBe('tok-day-2');
    expect(gis.requestCalls.at(-1)).toEqual({
      prompt: '',
      login_hint: 'mom@example.com',
    });
    expect(mgr2.getState().status).toBe('connected');

    // Explicit select_account omits login_hint so user can switch Google accounts
    await mgr2.requestSignIn('select_account');
    expect(gis.requestCalls.at(-1)).toEqual({
      prompt: 'select_account',
    });
  });

  it('transitions connected -> expired deterministically on token expiry timer while keeping userEmail', async () => {
    installMockGis({ nextToken: 'tok-short', nextExpiresIn: 120 });
    const mgr = createManager();
    mgr.configure('test-client-id');

    const statuses: string[] = [];
    const unsub = mgr.subscribe((st) => statuses.push(st.status));

    await mgr.requestSignIn();
    mgr.setUserProfile('dad@example.com', 'Dad');
    expect(mgr.getState().status).toBe('connected');

    // Advance past expiresAt - 15s buffer (105s)
    vi.advanceTimersByTime(106_000);

    expect(mgr.getState()).toMatchObject({
      status: 'expired',
      accessToken: null,
      userEmail: 'dad@example.com',
      wasConnected: true,
    });
    expect(statuses.at(-1)).toBe('expired');
    unsub();
  });

  it('syncs updated tokens across tabs via window storage events', () => {
    const mgr = createManager();
    mgr.configure('test-client-id');
    expect(mgr.getState().status).toBe('disconnected');

    const expiresAt = Date.now() + 3600_000;
    const raw = JSON.stringify({
      accessToken: 'tok-from-other-tab',
      expiresAt,
      grantedScope: DRIVE_SCOPE,
      userEmail: 'family@example.com',
      userName: 'Family',
      wasConnected: true,
    });
    window.localStorage.setItem(GOOGLE_AUTH_STORAGE_KEY, raw);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: GOOGLE_AUTH_STORAGE_KEY,
        newValue: raw,
      }),
    );

    expect(mgr.getState()).toMatchObject({
      status: 'connected',
      accessToken: 'tok-from-other-tab',
      userEmail: 'family@example.com',
      wasConnected: true,
    });
  });

  it('clears persisted session and remembered account completely on explicit signOut', async () => {
    const gis = installMockGis({ nextToken: 'tok-to-revoke', nextExpiresIn: 3600 });
    const mgr = createManager();
    mgr.configure('test-client-id');
    await mgr.requestSignIn();
    mgr.setUserProfile('parent@example.com', 'Parent');

    mgr.signOut();

    expect(gis.revokeMock).toHaveBeenCalledWith('tok-to-revoke');
    expect(window.localStorage.getItem(GOOGLE_AUTH_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(GOOGLE_AUTH_STORAGE_KEY)).toBeNull();
    expect(mgr.getState()).toMatchObject({
      status: 'disconnected',
      accessToken: null,
      userEmail: null,
      userName: null,
      wasConnected: false,
      lastError: null,
    });

    // Reloading after explicit Sign Out stays disconnected
    const mgrAfterReload = createManager();
    mgrAfterReload.configure('test-client-id');
    expect(mgrAfterReload.getState()).toMatchObject({
      status: 'disconnected',
      wasConnected: false,
      userEmail: null,
    });
  });

  it('uses GIS initCodeClient + Cloud Run broker exchange, refreshes silently across multi-day PWA updates, deduplicates concurrent refreshes, and revokes on signOut', async () => {
    const brokerUrl = 'https://auth-broker.example.test';
    const codeClientConfigs: Array<{
      client_id: string;
      scope: string;
      ux_mode?: string;
      login_hint?: string;
    }> = [];

    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn() as unknown as NonNullable<
            NonNullable<Window['google']>['accounts']
          >['oauth2'] extends infer T
            ? T extends { initTokenClient: infer F }
              ? F
              : never
            : never,
          initCodeClient: (cfg) => {
            codeClientConfigs.push({
              client_id: cfg.client_id,
              scope: cfg.scope,
              ux_mode: cfg.ux_mode,
              login_hint: cfg.login_hint,
            });
            return {
              requestCode: () => {
                cfg.callback({ code: '4/0gis-auth-code' });
              },
            };
          },
        },
      },
    };

    const brokerCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let refreshCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      brokerCalls.push({ url, body });

      if (url === `${brokerUrl}/auth/exchange`) {
        return new Response(
          JSON.stringify({
            accessToken: 'tok-broker-initial',
            expiresIn: 3600,
            encryptedRefreshToken: 'v1.enc.refresh.1',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === `${brokerUrl}/auth/refresh`) {
        refreshCount += 1;
        return new Response(
          JSON.stringify({
            accessToken: `tok-broker-refreshed-${refreshCount}`,
            expiresIn: 3600,
            encryptedRefreshToken: `v1.enc.refresh.${refreshCount + 1}`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === `${brokerUrl}/auth/revoke`) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const mgr1 = createManager();
    mgr1.configure('test-client-id', brokerUrl);

    const token = await mgr1.requestSignIn();
    expect(token).toBe('tok-broker-initial');
    expect(codeClientConfigs[0]).toMatchObject({
      client_id: 'test-client-id',
      ux_mode: 'popup',
    });
    expect(mgr1.canRefreshSilently()).toBe(true);
    mgr1.setUserProfile('parent@example.com', 'Parent');

    // Simulate closing the PWA for 3 days + PWA update wiping sessionStorage
    mgr1.dispose();
    vi.advanceTimersByTime(3 * 24 * 60 * 60 * 1000);
    window.sessionStorage.clear();

    const mgr2 = createManager();
    mgr2.configure('test-client-id', brokerUrl);

    // Concurrent ensureValidAccessToken calls share the single in-flight boot refresh
    const [t1, t2] = await Promise.all([
      mgr2.ensureValidAccessToken(),
      mgr2.ensureValidAccessToken(),
    ]);
    expect(t1).toBe('tok-broker-refreshed-1');
    expect(t2).toBe('tok-broker-refreshed-1');
    expect(refreshCount).toBe(1);
    expect(mgr2.getState()).toMatchObject({
      status: 'connected',
      accessToken: 'tok-broker-refreshed-1',
      userEmail: 'parent@example.com',
      hasPersistentRefresh: true,
      isRefreshing: false,
    });

    // Proactive background timer refreshes ~5 minutes before 1-hour expiry while app stays open
    await vi.advanceTimersByTimeAsync(56 * 60 * 1000);
    expect(refreshCount).toBe(2);
    expect(mgr2.getAccessToken()).toBe('tok-broker-refreshed-2');

    // Sign out revokes via broker and clears localStorage
    mgr2.signOut();
    await Promise.resolve();
    expect(brokerCalls.at(-1)).toEqual({
      url: `${brokerUrl}/auth/revoke`,
      body: {
        encryptedRefreshToken: 'v1.enc.refresh.3',
        accessToken: 'tok-broker-refreshed-2',
      },
    });
    expect(mgr2.canRefreshSilently()).toBe(false);
    expect(window.localStorage.getItem(GOOGLE_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('preserves encryptedRefreshToken across transient offline errors and clears it only on 401 invalid_grant', async () => {
    const brokerUrl = 'https://auth-broker.example.test';
    window.localStorage.setItem(
      GOOGLE_AUTH_STORAGE_KEY,
      JSON.stringify({
        accessToken: 'tok-old',
        expiresAt: Date.now() - 60_000,
        encryptedRefreshToken: 'v1.enc.refresh.persisted',
        grantedScope: DRIVE_SCOPE,
        userEmail: 'dad@example.com',
        userName: 'Dad',
        wasConnected: true,
      }),
    );

    let mode: 'offline' | 'revoked' = 'offline';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (mode === 'offline') {
        throw new TypeError('Failed to fetch');
      }
      return new Response(
        JSON.stringify({ error: 'invalid_grant', message: 'Revoked' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const mgr = createManager();
    mgr.configure('test-client-id', brokerUrl);
    await mgr.ensureValidAccessToken();

    // Still holds encryptedRefreshToken after offline failure so it can recover when back online
    expect(mgr.canRefreshSilently()).toBe(true);
    expect(mgr.getState()).toMatchObject({
      status: 'expired',
      userEmail: 'dad@example.com',
      hasPersistentRefresh: true,
      isRefreshing: false,
    });

    // Permanent 401 invalid_grant clears encryptedRefreshToken and falls back cleanly to 1-tap Reconnect
    mode = 'revoked';
    const res = await mgr.refreshAccessTokenSilently({ force: true });
    expect(res).toBeNull();
    expect(mgr.canRefreshSilently()).toBe(false);
    expect(mgr.getState()).toMatchObject({
      status: 'expired',
      userEmail: 'dad@example.com',
      wasConnected: true,
      hasPersistentRefresh: false,
    });
  });

  it('lets runtime window.__STORYTAPE_AUTH_BROKER_URL__ (including empty string) override build-time VITE_GOOGLE_AUTH_BROKER_URL', () => {
    const win = window as unknown as Record<string, unknown>;
    vi.stubEnv('VITE_GOOGLE_AUTH_BROKER_URL', 'https://prod-broker.run.app/');

    try {
      delete win.__STORYTAPE_AUTH_BROKER_URL__;
      expect(getConfiguredAuthBrokerUrl()).toBe('https://prod-broker.run.app');

      // Explicit empty string disables broker (critical for non-broker E2E tests on CI builds!)
      win.__STORYTAPE_AUTH_BROKER_URL__ = '';
      expect(getConfiguredAuthBrokerUrl()).toBe('');

      // Explicit mock URL overrides baked-in prod broker URL
      win.__STORYTAPE_AUTH_BROKER_URL__ = 'https://mock-broker.example.test///';
      expect(getConfiguredAuthBrokerUrl()).toBe('https://mock-broker.example.test');
    } finally {
      delete win.__STORYTAPE_AUTH_BROKER_URL__;
      vi.unstubAllEnvs();
    }
  });
});
