import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, Mic, SlidersHorizontal, X } from 'lucide-react';
import type { AppSettings } from '../types/models';
import {
  type AudioInputDeviceInfo,
  type CapturedMicTestAudio,
  listAudioInputDevices,
  requestMicPermissionAndList,
  subscribeDeviceChanges,
} from '../audio/audioDevices';
import {
  type CodecCapabilities,
  probeAudioCapabilities,
} from '../audio/qualityPresets';
import type { GoogleAuthState } from '../drive/googleAuth';
import { useMicTest } from '../hooks/useMicTest';
import type { PwaInstallState } from '../pwa/installPrompt';
import { getLocalMastersSummary } from '../storage/db';
import { AppearanceDefaultsSection } from './settings/AppearanceDefaultsSection';
import { DeviceSettingsSection } from './settings/DeviceSettingsSection';
import { DriveSyncSettingsSection } from './settings/DriveSyncSettingsSection';
import { QualitySettingsSection } from './settings/QualitySettingsSection';
import { StorageAppSection } from './settings/StorageAppSection';
import './SettingsSheet.css';

export type SettingsTab = 'recording' | 'drive' | 'app';

interface SettingsSheetProps {
  open: boolean;
  initialTab?: SettingsTab;
  settings: AppSettings;
  authState: GoogleAuthState;
  pwaInstallState?: PwaInstallState;
  isSyncing: boolean;
  syncStatusMessage: string | null;
  lastMicCapture?: CapturedMicTestAudio | null;
  onMicTestCaptured?: (capture: CapturedMicTestAudio) => void;
  onOpenMicQualityLab?: (capture?: CapturedMicTestAudio | null) => void;
  onOpenThemeSwitcher: () => void;
  onClose: () => void;
  onUpdateSettings: (next: AppSettings) => void;
  onInstallApp?: () => void;
  onConnectDrive: () => void;
  onSignOutDrive: () => void;
  onSyncAll: () => void;
  onOpenShareLibrary: () => void;
  onJoinSharedFolder: (input: string) => Promise<void>;
  onPickSharedFolder: () => Promise<void>;
  onSwitchToPersonalLibrary: () => Promise<void>;
  onUnlinkSharedBook: (folderId: string) => void;
  onClearSyncedCache: () => Promise<number>;
  onClearLocalMasters?: () => Promise<{ count: number; freedBytes: number }>;
  onToast: (message: string) => void;
}

const SETTINGS_TABS: Array<{
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: 'recording', label: 'Recording', icon: <Mic size={15} /> },
  { id: 'drive', label: 'Drive', icon: <Cloud size={15} /> },
  { id: 'app', label: 'App', icon: <SlidersHorizontal size={15} /> },
];

export const SettingsSheet: React.FC<SettingsSheetProps> = ({
  open,
  initialTab = 'recording',
  settings,
  authState,
  pwaInstallState,
  isSyncing,
  syncStatusMessage,
  lastMicCapture = null,
  onMicTestCaptured,
  onOpenMicQualityLab,
  onOpenThemeSwitcher,
  onClose,
  onUpdateSettings,
  onInstallApp,
  onConnectDrive,
  onSignOutDrive,
  onSyncAll,
  onOpenShareLibrary,
  onJoinSharedFolder,
  onPickSharedFolder,
  onSwitchToPersonalLibrary,
  onUnlinkSharedBook,
  onClearSyncedCache,
  onClearLocalMasters,
  onToast,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [devices, setDevices] = useState<AudioInputDeviceInfo[]>([]);
  const [micPermGranted, setMicPermGranted] = useState(false);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [caps, setCaps] = useState<CodecCapabilities | null>(null);
  const [storageUsage, setStorageUsage] = useState<{
    usage: number;
    quota: number;
  } | null>(null);
  const [localMastersSummary, setLocalMastersSummary] = useState<{
    count: number;
    totalBytes: number;
  }>({ count: 0, totalBytes: 0 });

  const refreshDevices = useCallback(async () => {
    setDeviceLoading(true);
    setDeviceError(null);
    try {
      const res = await listAudioInputDevices();
      setDevices(res.devices);
      setMicPermGranted(res.permissionGranted);
    } catch (err) {
      setDeviceError(
        err instanceof Error ? err.message : 'Unable to detect microphones.',
      );
    } finally {
      setDeviceLoading(false);
    }
  }, []);

  const micTest = useMicTest({
    device: settings.audioDevice,
    quality: settings.audioQuality,
    onCaptured: onMicTestCaptured,
    onFallbackToast: onToast,
    onStarted: () => {
      // Refresh device list now that mic permission is definitely granted
      void refreshDevices();
    },
  });

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
      if (bodyRef.current) {
        bodyRef.current.scrollTop = 0;
      }
    }
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) {
      micTest.stop();
      return;
    }

    void refreshDevices();
    void probeAudioCapabilities().then(setCaps);
    void getLocalMastersSummary()
      .then(setLocalMastersSummary)
      .catch(() => {});

    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.estimate === 'function'
    ) {
      void navigator.storage
        .estimate()
        .then((est) => {
          setStorageUsage({
            usage: est.usage ?? 0,
            quota: est.quota ?? 0,
          });
        })
        .catch(() => {});
    }

    const unsub = subscribeDeviceChanges(() => {
      void refreshDevices();
    });
    return () => {
      unsub();
      micTest.stop();
    };
  }, [open, refreshDevices, micTest.stop]);

  if (!open) return null;

  const handleSelectTab = (tab: SettingsTab) => {
    if (tab !== 'recording' && micTest.isTesting) {
      micTest.stop();
    }
    setActiveTab(tab);
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
  };

  const handleUnlockDevices = async () => {
    setDeviceLoading(true);
    setDeviceError(null);
    try {
      const res = await requestMicPermissionAndList();
      setDevices(res.devices);
      setMicPermGranted(res.permissionGranted);
      onToast(
        `Detected ${res.devices.length} microphone${res.devices.length === 1 ? '' : 's'}`,
      );
    } catch (err) {
      setDeviceError(
        err instanceof Error ? err.message : 'Microphone permission denied.',
      );
    } finally {
      setDeviceLoading(false);
    }
  };

  const handleToggleMicTest = async () => {
    if (micTest.isTesting) {
      micTest.stop();
      return;
    }
    setDeviceError(null);
    await micTest.start();
  };

  const driveDotTone =
    authState.status === 'connected'
      ? 'connected'
      : authState.isRefreshing || authState.status === 'expired'
        ? 'attention'
        : null;

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      data-testid="settings-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-panel settings-sheet-panel">
        <div className="sheet-header">
          <h2 id="settings-title" className="sheet-title">
            Studio Settings
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={20} />
          </button>
        </div>

        <div className="settings-tabs-bar">
          <div
            className="settings-tabs"
            role="tablist"
            aria-label="Studio Settings sections"
          >
            {SETTINGS_TABS.map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`settings-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`settings-panel-${tab.id}`}
                  data-testid={`settings-tab-${tab.id}`}
                  className={`settings-tab ${selected ? 'settings-tab--active' : ''}`}
                  onClick={() => handleSelectTab(tab.id)}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                  {tab.id === 'drive' && driveDotTone && (
                    <span
                      className={`settings-tab__dot settings-tab__dot--${driveDotTone}`}
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div
          ref={bodyRef}
          id={`settings-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeTab}`}
          className="sheet-body"
        >
          {activeTab === 'recording' && (
            <>
              <DeviceSettingsSection
                settings={settings}
                devices={devices}
                micPermGranted={micPermGranted}
                deviceLoading={deviceLoading}
                deviceError={deviceError || micTest.error}
                testingMic={micTest.isTesting}
                telemetry={micTest.telemetry}
                lastMicCapture={lastMicCapture}
                onRefreshDevices={() => void refreshDevices()}
                onUnlockDevices={() => void handleUnlockDevices()}
                onToggleMicTest={() => void handleToggleMicTest()}
                onSelectDevice={(deviceId, deviceLabel) =>
                  onUpdateSettings({
                    ...settings,
                    audioDevice: { deviceId, deviceLabel },
                  })
                }
                onOpenMicQualityLab={
                  onOpenMicQualityLab
                    ? () => {
                        const fresh = micTest.isTesting ? micTest.stop() : null;
                        onOpenMicQualityLab(fresh ?? lastMicCapture ?? null);
                      }
                    : undefined
                }
              />

              <QualitySettingsSection
                settings={settings}
                caps={caps}
                onUpdateSettings={onUpdateSettings}
              />
            </>
          )}

          {activeTab === 'drive' && (
            <DriveSyncSettingsSection
              settings={settings}
              authState={authState}
              isSyncing={isSyncing}
              syncStatusMessage={syncStatusMessage}
              onUpdateSettings={onUpdateSettings}
              onConnectDrive={onConnectDrive}
              onSignOutDrive={onSignOutDrive}
              onSyncAll={onSyncAll}
              onOpenShareLibrary={onOpenShareLibrary}
              onJoinSharedFolder={onJoinSharedFolder}
              onPickSharedFolder={onPickSharedFolder}
              onSwitchToPersonalLibrary={onSwitchToPersonalLibrary}
              onUnlinkSharedBook={onUnlinkSharedBook}
            />
          )}

          {activeTab === 'app' && (
            <>
              <AppearanceDefaultsSection
                settings={settings}
                onUpdateSettings={onUpdateSettings}
                onOpenThemeSwitcher={onOpenThemeSwitcher}
              />

              <StorageAppSection
                pwaInstallState={pwaInstallState}
                storageUsage={storageUsage}
                localMastersSummary={localMastersSummary}
                onInstallApp={onInstallApp}
                onClearSyncedCache={onClearSyncedCache}
                onClearLocalMasters={onClearLocalMasters}
                onLocalMastersCleared={() =>
                  setLocalMastersSummary({ count: 0, totalBytes: 0 })
                }
                onToast={onToast}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
};
