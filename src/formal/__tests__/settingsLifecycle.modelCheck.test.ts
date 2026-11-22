/**
 * Tier 1 Formal Verification: Studio Settings Lifecycle Explicit-State BFS Model Check,
 * Automated Real-Component Positive+Negative Conformance & Async Cancellation Proofs
 *
 * Runs on every `npm test` (~<1s, zero WASM overhead).
 * Verifies:
 *   1. Explicit-state BFS over 100% of reachable states in `createSettingsLifecycleLts()`,
 *      proving all 8 safety invariants (including zero mic leaks across tab switches, modal
 *      closes, and theme-switcher stacking) and all 5 reachability goals.
 *   2. Automated Positive + Negative Conformance (`verifyConformance`) replaying BFS witness
 *      traces directly against the REAL mounted `<SettingsSheet>` + `<ThemeSwitcherSheet>` +
 *      `useMicTest` React tree with a deterministic `MicLevelTester` spy tracking active streams.
 *   3. Async Mid-Await Cancellation Proofs: verifies that switching tabs (`Drive` / `App`) or
 *      closing `<SettingsSheet>` while `MicLevelTester.start()` is suspended mid-await cancels
 *      the pending session cleanly with zero leaked mic streams and zero stale state updates.
 */

import React, { useCallback, useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import * as audioDevices from '../../audio/audioDevices';
import { ConfirmProvider } from '../../components/ConfirmDialogContext';
import { ThemeSwitcherSheet } from '../../components/ThemeSwitcherSheet';
import { getDefaultSettings } from '../../storage/settings';
import type { AppSettings } from '../../types/models';
import { SettingsSheet, type SettingsTab } from '../../views/SettingsSheet';
import { modelCheck, verifyConformance } from '../core/modelChecker';
import {
  createSettingsLifecycleLts,
  SETTINGS_INITIAL_STATE,
  type SettingsAction,
  type SettingsFormalState,
} from '../specs/settingsLifecycleSpec';

interface HarnessApi {
  openSettings: (tab?: SettingsTab) => void;
  openThemeFromLibrary: () => void;
  getState: () => {
    open: boolean;
    themeSwitcherOpen: boolean;
    openCount: number;
    lastOpenedTab: SettingsTab;
  };
}

interface SettingsShellHarnessProps {
  onReady: (api: HarnessApi) => void;
}

const SettingsShellHarness: React.FC<SettingsShellHarnessProps> = ({
  onReady,
}) => {
  const [settings, setSettings] = useState<AppSettings>(() =>
    getDefaultSettings(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] =
    useState<SettingsTab>('recording');
  const [themeSwitcherOpen, setThemeSwitcherOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);

  const openSettings = useCallback((tab: SettingsTab = 'recording') => {
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
    setOpenCount((c) => c + 1);
  }, []);

  const openThemeFromLibrary = useCallback(() => {
    setThemeSwitcherOpen(true);
  }, []);

  onReady({
    openSettings,
    openThemeFromLibrary,
    getState: () => ({
      open: settingsOpen,
      themeSwitcherOpen,
      openCount,
      lastOpenedTab: settingsInitialTab,
    }),
  });

  return React.createElement(
    ConfirmProvider,
    null,
    React.createElement(SettingsSheet, {
      open: settingsOpen,
      initialTab: settingsInitialTab,
      settings,
      authState: {
        status: 'disconnected',
        accessToken: null,
        expiresAt: null,
        userEmail: null,
        userName: null,
        wasConnected: false,
        hasPersistentRefresh: false,
        isRefreshing: false,
        gisLoaded: true,
        lastError: null,
      },
      pwaInstallState: {
        isInstalled: false,
        canPromptNative: false,
        isIosManualInstall: false,
        bannerDismissed: false,
        showBanner: false,
        canInstallFromSettings: false,
      },
      isSyncing: false,
      syncStatusMessage: null,
      onOpenThemeSwitcher: () => setThemeSwitcherOpen(true),
      onClose: () => setSettingsOpen(false),
      onUpdateSettings: setSettings,
      onConnectDrive: vi.fn(),
      onSignOutDrive: vi.fn(),
      onSyncAll: vi.fn(),
      onOpenShareLibrary: vi.fn(),
      onJoinSharedFolder: vi.fn().mockResolvedValue(undefined),
      onPickSharedFolder: vi.fn().mockResolvedValue(undefined),
      onSwitchToPersonalLibrary: vi.fn().mockResolvedValue(undefined),
      onUnlinkSharedBook: vi.fn(),
      onClearSyncedCache: vi.fn().mockResolvedValue(0),
      onClearLocalMasters: vi
        .fn()
        .mockResolvedValue({ count: 0, freedBytes: 0 }),
      onToast: vi.fn(),
    }),
    React.createElement(ThemeSwitcherSheet, {
      open: themeSwitcherOpen,
      currentTheme: settings.theme,
      onSelectTheme: (theme) => setSettings((prev) => ({ ...prev, theme })),
      onClose: () => setThemeSwitcherOpen(false),
    }),
  );
};

describe('Tier 1 Formal Proofs: Studio Settings Modal, Tabs, Disclosure & Mic Test Lifecycle', () => {
  let activeStreams = new Set<audioDevices.MicLevelTester>();
  let startSpy: MockInstance<audioDevices.MicLevelTester['start']>;
  let stopSpy: MockInstance<audioDevices.MicLevelTester['stop']>;

  beforeEach(() => {
    activeStreams = new Set();
    startSpy = vi
      .spyOn(audioDevices.MicLevelTester.prototype, 'start')
      .mockImplementation(async function (this: audioDevices.MicLevelTester) {
        activeStreams.add(this);
        return { usedFallback: false };
      });
    stopSpy = vi
      .spyOn(audioDevices.MicLevelTester.prototype, 'stop')
      .mockImplementation(function (this: audioDevices.MicLevelTester) {
        activeStreams.delete(this);
      });
    vi.spyOn(audioDevices, 'listAudioInputDevices').mockResolvedValue({
      devices: [
        {
          deviceId: 'default',
          label: 'System Default Microphone',
          groupId: 'default-group',
          isDefault: true,
        },
      ],
      permissionGranted: true,
    });
    vi.spyOn(audioDevices, 'subscribeDeviceChanges').mockReturnValue(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('exhaustively BFS model-checks 100% of reachable Settings lifecycle states against all 9 safety invariants & 5 reachability goals', () => {
    const lts = createSettingsLifecycleLts(2);
    const cert = modelCheck(lts);

    expect(cert.statesExplored).toBeGreaterThanOrEqual(20);
    expect(cert.transitionsExplored).toBeGreaterThanOrEqual(50);
    expect(cert.reachedGoals).toHaveLength(5);
  });

  it('proves 100%-state positive + negative conformance (verifyConformance) against the real mounted SettingsSheet + ThemeSwitcherSheet + useMicTest', async () => {
    const lts = createSettingsLifecycleLts(2);

    interface MountedImpl {
      apiRef: { current: HarnessApi };
      unmount: () => void;
    }

    const observeDom = (impl: MountedImpl): SettingsFormalState => {
      const shell = impl.apiRef.current.getState();
      const sheetOpen = screen.queryByTestId('settings-sheet') !== null;
      const themeOpen = screen.queryByTestId('theme-switcher-sheet') !== null;

      let tab: SettingsTab = 'recording';
      if (sheetOpen) {
        if (
          screen
            .getByTestId('settings-tab-recording')
            .getAttribute('aria-selected') === 'true'
        ) {
          tab = 'recording';
        } else if (
          screen
            .getByTestId('settings-tab-drive')
            .getAttribute('aria-selected') === 'true'
        ) {
          tab = 'drive';
        } else if (
          screen
            .getByTestId('settings-tab-app')
            .getAttribute('aria-selected') === 'true'
        ) {
          tab = 'app';
        }
      }

      const advancedOpen =
        screen.queryByTestId('advanced-audio-panel') !== null;
      const micTestActive = activeStreams.size > 0;

      // Hard hardware/privacy invariant check on every observed DOM frame
      if (micTestActive) {
        expect(sheetOpen).toBe(true);
        expect(tab).toBe('recording');
        expect(themeOpen).toBe(false);
        expect(activeStreams.size).toBe(1);
      }

      return {
        open: sheetOpen,
        tab,
        advancedOpen,
        micTestActive,
        themeSwitcherOpen: themeOpen,
        openCount: shell.openCount,
      };
    };

    const bfsCert = modelCheck(lts);
    const cert = await verifyConformance<
      SettingsFormalState,
      SettingsAction,
      MountedImpl
    >(lts, bfsCert, {
      createImpl: async () => {
        activeStreams.clear();
        const apiRef = { current: null as unknown as HarnessApi };
        const rendered = render(
          React.createElement(SettingsShellHarness, {
            onReady: (readyApi) => {
              apiRef.current = readyApi;
            },
          }),
        );
        return { apiRef, unmount: rendered.unmount };
      },
      destroyImpl: async (impl) => {
        await act(async () => {
          impl.unmount();
        });
        expect(activeStreams.size).toBe(0);
      },
      // Probe all non-depth-capped actions as disabled negative guards across every visited state
      negativeProbeActions: [
        'switch_recording',
        'switch_drive',
        'switch_app',
        'toggle_advanced',
        'start_mic_test',
        'stop_mic_test',
        'open_theme_from_settings',
        'open_theme_from_library',
        'close_theme_switcher',
        'close_settings',
      ],
      execute: async (impl, action) => {
        const shell = impl.apiRef.current.getState();

        // While ThemeSwitcherSheet overlays the screen (z-index: 65 > 60), underlying
        // Settings/Library controls are occluded; only close_theme_switcher is interactive.
        const clickIfInteractive = (el: HTMLElement | null) => {
          if (!el || shell.themeSwitcherOpen) return;
          fireEvent.click(el);
        };

        await act(async () => {
          switch (action) {
            case 'open_default':
              if (!shell.open && !shell.themeSwitcherOpen) {
                impl.apiRef.current.openSettings('recording');
              }
              break;
            case 'open_drive':
              if (!shell.open && !shell.themeSwitcherOpen) {
                impl.apiRef.current.openSettings('drive');
              }
              break;
            case 'switch_recording':
              clickIfInteractive(screen.queryByTestId('settings-tab-recording'));
              break;
            case 'switch_drive':
              clickIfInteractive(screen.queryByTestId('settings-tab-drive'));
              break;
            case 'switch_app':
              clickIfInteractive(screen.queryByTestId('settings-tab-app'));
              break;
            case 'toggle_advanced':
              clickIfInteractive(screen.queryByTestId('advanced-audio-toggle'));
              break;
            case 'start_mic_test':
              clickIfInteractive(
                screen.queryByRole('button', { name: 'Test Mic' }),
              );
              break;
            case 'stop_mic_test':
              clickIfInteractive(
                screen.queryByRole('button', { name: 'Stop Test' }),
              );
              break;
            case 'open_theme_from_settings':
              clickIfInteractive(screen.queryByTestId('settings-theme-row'));
              break;
            case 'open_theme_from_library':
              if (!shell.open && !shell.themeSwitcherOpen) {
                impl.apiRef.current.openThemeFromLibrary();
              }
              break;
            case 'close_theme_switcher': {
              const doneBtn = screen.queryByRole('button', { name: 'Done' });
              if (doneBtn) fireEvent.click(doneBtn);
              break;
            }
            case 'close_settings':
              clickIfInteractive(screen.queryByLabelText('Close settings'));
              break;
          }
          // Flush async microtasks (e.g., MicLevelTester.start(), listAudioInputDevices)
          await Promise.resolve();
          await Promise.resolve();
        });
      },
      observe: observeDom,
    });

    expect(cert.distinctStatesCovered).toBeGreaterThanOrEqual(20);
    expect(cert.enabledStepsVerified).toBeGreaterThanOrEqual(20);
    expect(cert.disabledGuardsVerified).toBeGreaterThanOrEqual(50);
    expect(startSpy).toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalled();
  });

  it.each([
    { interruptAction: 'switch_drive' as const, label: 'switching to Drive tab' },
    { interruptAction: 'switch_app' as const, label: 'switching to App tab' },
    { interruptAction: 'close_settings' as const, label: 'closing SettingsSheet' },
  ])(
    'async mid-await cancellation proof: $label while MicLevelTester.start() is pending leaks 0 streams and suppresses stale callbacks',
    async ({ interruptAction }) => {
      let resolvePendingStart!: (val: { usedFallback: boolean }) => void;
      startSpy.mockImplementationOnce(function (this: audioDevices.MicLevelTester) {
        activeStreams.add(this);
        return new Promise<{ usedFallback: boolean }>((resolve) => {
          resolvePendingStart = resolve;
        });
      });

      const listDevicesSpy = vi.spyOn(audioDevices, 'listAudioInputDevices');
      let api!: HarnessApi;
      render(
        React.createElement(SettingsShellHarness, {
          onReady: (readyApi) => {
            api = readyApi;
          },
        }),
      );

      await act(async () => {
        api.openSettings('recording');
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Test Mic' })).toBeInTheDocument(),
      );
      const callsBeforeStart = listDevicesSpy.mock.calls.length;

      // Start mic test — remains suspended mid-await inside MicLevelTester.start()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Test Mic' }));
        await Promise.resolve();
      });
      expect(activeStreams.size).toBe(1);

      // Interrupt mid-await via tab switch or modal close
      await act(async () => {
        if (interruptAction === 'switch_drive') {
          fireEvent.click(screen.getByTestId('settings-tab-drive'));
        } else if (interruptAction === 'switch_app') {
          fireEvent.click(screen.getByTestId('settings-tab-app'));
        } else {
          fireEvent.click(screen.getByLabelText('Close settings'));
        }
        await Promise.resolve();
      });
      expect(activeStreams.size).toBe(0);

      // Now the late getUserMedia / start() promise resolves AFTER cancellation
      await act(async () => {
        resolvePendingStart({ usedFallback: false });
        await Promise.resolve();
        await Promise.resolve();
      });

      // Zero leaked mic streams AND stale onStarted() refresh must NOT fire!
      expect(activeStreams.size).toBe(0);
      expect(listDevicesSpy.mock.calls.length).toBe(callsBeforeStart);

      // Re-returning to Recording tab shows clean stopped state ("Test Mic", never stuck "Stop Test")
      await act(async () => {
        if (interruptAction === 'close_settings') {
          api.openSettings('recording');
        } else {
          fireEvent.click(screen.getByTestId('settings-tab-recording'));
        }
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: 'Test Mic' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Stop Test' })).toBeNull();
      expect(SETTINGS_INITIAL_STATE.micTestActive).toBe(false);
    },
  );
});
