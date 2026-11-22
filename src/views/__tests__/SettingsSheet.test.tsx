import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as qualityPresets from '../../audio/qualityPresets';
import { ConfirmProvider } from '../../components/ConfirmDialogContext';
import { getDefaultSettings } from '../../storage/settings';
import { SettingsSheet, type SettingsTab } from '../SettingsSheet';

beforeEach(() => {
  vi.spyOn(qualityPresets, 'probeAudioCapabilities').mockResolvedValue({
    webCodecsAvailable: true,
    aacSupported: true,
    opusSupported: true,
    aacMaxMonoKbps: 320,
    aacMaxStereoKbps: 510,
    opusMaxMonoKbps: 510,
    opusMaxStereoKbps: 510,
    wavSupported: true,
    autoBestFormat: 'm4a',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderSettingsSheet(options?: {
  initialTab?: SettingsTab;
  format?: 'auto' | 'm4a' | 'wav';
  onOpenThemeSwitcher?: () => void;
  onUpdateSettings?: ReturnType<typeof vi.fn>;
}) {
  const base = getDefaultSettings();
  const settings = options?.format
    ? {
        ...base,
        audioQuality: { ...base.audioQuality, format: options.format },
      }
    : base;
  const onUpdateSettings = options?.onUpdateSettings ?? vi.fn();
  const onOpenThemeSwitcher = options?.onOpenThemeSwitcher ?? vi.fn();

  return {
    onUpdateSettings,
    onOpenThemeSwitcher,
    ...render(
      <ConfirmProvider>
        <SettingsSheet
          open
          initialTab={options?.initialTab}
          settings={settings}
          authState={{
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
          }}
          pwaInstallState={{
            isInstalled: false,
            canPromptNative: true,
            isIosManualInstall: false,
            bannerDismissed: false,
            showBanner: false,
            canInstallFromSettings: true,
          }}
          isSyncing={false}
          syncStatusMessage={null}
          onOpenThemeSwitcher={onOpenThemeSwitcher}
          onClose={vi.fn()}
          onUpdateSettings={onUpdateSettings}
          onInstallApp={vi.fn()}
          onConnectDrive={vi.fn()}
          onSignOutDrive={vi.fn()}
          onSyncAll={vi.fn()}
          onOpenShareLibrary={vi.fn()}
          onJoinSharedFolder={vi.fn().mockResolvedValue(undefined)}
          onPickSharedFolder={vi.fn().mockResolvedValue(undefined)}
          onSwitchToPersonalLibrary={vi.fn().mockResolvedValue(undefined)}
          onUnlinkSharedBook={vi.fn()}
          onClearSyncedCache={vi.fn().mockResolvedValue(0)}
          onClearLocalMasters={vi
            .fn()
            .mockResolvedValue({ count: 0, freedBytes: 0 })}
          onToast={vi.fn()}
        />
      </ConfirmProvider>,
    ),
  };
}

describe('SettingsSheet reorganization', () => {
  it('defaults to the Recording tab with Advanced Audio collapsed behind a live summary disclosure', async () => {
    const user = userEvent.setup();
    renderSettingsSheet();

    expect(screen.getByTestId('settings-tab-recording')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Recording Device')).toBeInTheDocument();
    expect(screen.getByText('Recording Quality')).toBeInTheDocument();

    // Advanced Audio starts collapsed with live summary visible
    const toggle = screen.getByTestId('advanced-audio-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('advanced-audio-summary')).toHaveTextContent(
      /0\.0 dB/,
    );
    expect(screen.queryByTestId('advanced-audio-panel')).not.toBeInTheDocument();

    // Expanding reveals format, input gain, and DSP controls
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('advanced-audio-panel')).toBeInTheDocument();
    expect(screen.getByTestId('gain-guide-card')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: '80 Hz Rumble Filter' }),
    ).toBeInTheDocument();
  });

  it('opens directly to Drive tab when initialTab is drive and separates Drive sync and sharing sections', async () => {
    renderSettingsSheet({ initialTab: 'drive' });

    expect(await screen.findByTestId('settings-tab-drive')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      await screen.findByRole('region', { name: 'Google Drive Sync' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Family and Collaborator Sharing' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Recording Device')).not.toBeInTheDocument();
  });

  it('renders a compact Color Theme launcher row and a dedicated Storage & App section on the App tab', async () => {
    const user = userEvent.setup();
    const onOpenThemeSwitcher = vi.fn();
    renderSettingsSheet({ onOpenThemeSwitcher });

    await user.click(screen.getByTestId('settings-tab-app'));
    expect(screen.getByTestId('settings-tab-app')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Compact theme row replaces the full 10-theme grid in Settings
    const themeRow = screen.getByTestId('settings-theme-row');
    expect(themeRow).toHaveTextContent('Pitch OLED');
    expect(document.querySelectorAll('[data-theme-option]').length).toBe(0);

    await user.click(themeRow);
    expect(onOpenThemeSwitcher).toHaveBeenCalledTimes(1);

    // Storage & App is its own dedicated section separate from Appearance & Defaults
    expect(
      screen.getByRole('region', { name: 'Appearance and Defaults' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Storage and App Info' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('settings-storage-card')).toBeInTheDocument();
    expect(screen.getByTestId('settings-install-card')).toBeInTheDocument();
    expect(screen.getByTestId('app-version-value')).toBeInTheDocument();
  });

  it('toggles tap-friendly ? helper tooltips for recording options (including Mono vs Stereo, Bitrate, Format, and DSP toggles)', async () => {
    const user = userEvent.setup();
    renderSettingsSheet({ format: 'm4a' });

    // Recording Device & Quality Presets ? buttons
    const deviceHelpBtn = screen.getByTestId('help-btn-recording-device');
    expect(deviceHelpBtn).toHaveAttribute('aria-expanded', 'false');
    await user.click(deviceHelpBtn);
    expect(deviceHelpBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('help-panel-recording-device')).toHaveTextContent(
      /System Default/i,
    );
    await user.click(deviceHelpBtn);
    expect(
      screen.queryByTestId('help-panel-recording-device'),
    ).not.toBeInTheDocument();

    // Expand Advanced Audio and inspect Channels (Mono vs Stereo) & Bitrate help cards
    await user.click(screen.getByTestId('advanced-audio-toggle'));

    const channelsHelpBtn = screen.getByTestId('help-btn-channels');
    await user.click(channelsHelpBtn);
    const channelsPanel = screen.getByTestId('help-panel-channels');
    expect(channelsPanel).toHaveTextContent(/Mono vs\. Stereo/i);
    expect(channelsPanel).toHaveTextContent(/half the file size/i);

    const bitrateHelpBtn = screen.getByTestId('help-btn-bitrate');
    await user.click(bitrateHelpBtn);
    expect(screen.getByTestId('help-panel-bitrate')).toHaveTextContent(
      /96k–128k/i,
    );

    // Close panel via its internal close button
    await user.click(screen.getByLabelText('Close Channels help'));
    expect(screen.queryByTestId('help-panel-channels')).not.toBeInTheDocument();
    expect(channelsHelpBtn).toHaveAttribute('aria-expanded', 'false');

    // DSP toggle help card does not flip the underlying switch
    const echoSwitch = screen.getByRole('switch', {
      name: 'Browser Echo Cancellation',
    });
    expect(echoSwitch).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByTestId('help-btn-dsp-echo-cancellation'));
    expect(
      screen.getByTestId('help-panel-dsp-echo-cancellation'),
    ).toHaveTextContent(/speakerphone calls/i);
    expect(echoSwitch).toHaveAttribute('aria-checked', 'false');
  });
});
