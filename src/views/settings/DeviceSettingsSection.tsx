import React from 'react';
import {
  Check,
  FlaskConical,
  Mic,
  RefreshCw,
  Volume2,
} from 'lucide-react';
import type { AppSettings } from '../../types/models';
import type {
  AudioInputDeviceInfo,
  CapturedMicTestAudio,
  MicTestTelemetry,
} from '../../audio/audioDevices';
import {
  InfoTipButton,
  InfoTipPanel,
  useInfoTip,
} from '../../components/InfoTip';
import { formatDurationMs, formatSampleRate } from '../../utils/format';
import { SETTINGS_HELP } from './settingsHelpContent';

export interface DeviceSettingsSectionProps {
  settings: AppSettings;
  devices: AudioInputDeviceInfo[];
  micPermGranted: boolean;
  deviceLoading: boolean;
  deviceError: string | null;
  testingMic: boolean;
  telemetry: MicTestTelemetry | null;
  lastMicCapture: CapturedMicTestAudio | null;
  onRefreshDevices: () => void;
  onUnlockDevices: () => void;
  onToggleMicTest: () => void;
  onSelectDevice: (deviceId: string, deviceLabel: string) => void;
  onOpenMicQualityLab?: () => void;
}

export const DeviceSettingsSection: React.FC<DeviceSettingsSectionProps> = ({
  settings,
  devices,
  micPermGranted,
  deviceLoading,
  deviceError,
  testingMic,
  telemetry,
  lastMicCapture,
  onRefreshDevices,
  onUnlockDevices,
  onToggleMicTest,
  onSelectDevice,
  onOpenMicQualityLab,
}) => {
  const deviceTip = useInfoTip();

  return (
    <section className="settings-section" aria-label="Recording Device">
      <div className="settings-section__head">
        <div className="info-tip-label-row">
          <h3 className="settings-section__title">
            <Mic size={17} />
            Recording Device
          </h3>
          <InfoTipButton
            content={SETTINGS_HELP['recording-device']}
            open={deviceTip.open}
            panelId={deviceTip.panelId}
            onToggle={deviceTip.toggle}
          />
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onRefreshDevices}
          disabled={deviceLoading}
          aria-label="Refresh microphones"
        >
          <RefreshCw size={14} className={deviceLoading ? 'spin' : ''} />
          Refresh
        </button>
      </div>

      {deviceTip.open && (
        <InfoTipPanel
          content={SETTINGS_HELP['recording-device']}
          panelId={deviceTip.panelId}
          onClose={deviceTip.close}
        />
      )}

    {!micPermGranted && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="field-hint">
          Browsers hide microphone names until permission is granted. Tap below
          to list built-in, Bluetooth, or USB microphones.
        </span>
        <div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onUnlockDevices}
            disabled={deviceLoading}
            id="detect-microphones-btn"
          >
            <Mic size={14} />
            Detect Microphones
          </button>
        </div>
      </div>
    )}

    <div
      className="device-list"
      role="radiogroup"
      aria-label="Microphone input"
    >
      <button
        type="button"
        role="radio"
        aria-checked={settings.audioDevice.deviceId === 'default'}
        className={`device-radio ${settings.audioDevice.deviceId === 'default' ? 'device-radio--active' : ''}`}
        onClick={() => onSelectDevice('default', 'System Default Microphone')}
      >
        <span className="device-radio__label">System Default Microphone</span>
        {settings.audioDevice.deviceId === 'default' && (
          <Check size={16} color="var(--accent-amber)" />
        )}
      </button>

      {devices
        .filter((d) => d.deviceId !== 'default')
        .map((dev) => {
          const selected = settings.audioDevice.deviceId === dev.deviceId;
          return (
            <button
              key={dev.deviceId}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`device-radio ${selected ? 'device-radio--active' : ''}`}
              onClick={() => onSelectDevice(dev.deviceId, dev.label)}
            >
              <span className="device-radio__label">{dev.label}</span>
              {selected && <Check size={16} color="var(--accent-amber)" />}
            </button>
          );
        })}
    </div>

    {micPermGranted &&
      devices.filter((d) => d.deviceId !== 'default').length <= 1 && (
        <span className="field-hint">
          Connect a USB-C/Lightning mic or Bluetooth headset to switch between
          multiple inputs.
        </span>
      )}

    {/* Built-in live microphone test meter */}
    <div className="mic-tester-box">
      <div className="mic-tester-row">
        <span
          className="field-label"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Volume2 size={14} />
          Live Input Level Check
        </span>
        <button
          type="button"
          className={`btn btn-sm ${testingMic ? 'btn-danger' : 'btn-secondary'}`}
          onClick={onToggleMicTest}
        >
          {testingMic ? 'Stop Test' : 'Test Mic'}
        </button>
      </div>

      <div className="mic-meter-track" aria-hidden="true">
        <div
          className={`mic-meter-fill ${
            telemetry?.clipping
              ? 'mic-meter-fill--clip'
              : (telemetry?.db ?? -60) > -3
                ? 'mic-meter-fill--hot'
                : ''
          }`}
          style={{
            width: `${
              telemetry
                ? Math.max(
                    0,
                    Math.min(100, Math.round(((telemetry.db + 60) / 60) * 100)),
                  )
                : 0
            }%`,
          }}
        />
      </div>

      <div className="mic-telemetry">
        <span>
          {telemetry
            ? `${telemetry.db.toFixed(0)} dB${telemetry.clipping ? ' · CLIP' : ''}${
                telemetry.softwareAgcActive &&
                typeof telemetry.autoGainDb === 'number'
                  ? ` · Auto ${telemetry.autoGainDb >= 0 ? '+' : ''}${telemetry.autoGainDb.toFixed(0)} dB`
                  : ''
              }${
                telemetry.capturedDurationMs >= 200
                  ? ` · ${formatDurationMs(telemetry.capturedDurationMs)}`
                  : ''
              }`
            : lastMicCapture
              ? `Last test clip ready: ${formatDurationMs(lastMicCapture.pcm.durationMs)} (${formatSampleRate(lastMicCapture.pcm.sampleRate)} 32f)`
              : 'Tap Test Mic to verify level & capture a lossless A/B sample'}
        </span>
        {telemetry && (
          <span>
            {formatSampleRate(telemetry.actualSampleRate)} ·{' '}
            {telemetry.actualChannels} ch
          </span>
        )}
      </div>

      {onOpenMicQualityLab && (
        <div className="mic-tester-lab-row">
          <span className="field-hint">
            Compare bitrates blind using this mic
          </span>
          <button
            type="button"
            className={`btn btn-sm ${
              lastMicCapture || (telemetry?.capturedDurationMs ?? 0) >= 200
                ? 'btn-amber'
                : 'btn-secondary'
            }`}
            data-testid="open-mic-quality-lab-btn"
            onClick={onOpenMicQualityLab}
          >
            <FlaskConical size={14} />
            {testingMic && (telemetry?.capturedDurationMs ?? 0) >= 200
              ? `Open in A/B Lab (${formatDurationMs(telemetry!.capturedDurationMs)})`
              : lastMicCapture
                ? `Open in A/B Lab (${formatDurationMs(lastMicCapture.pcm.durationMs)})`
                : 'A/B Quality Lab'}
          </button>
        </div>
      )}
    </div>

    {deviceError && <span className="badge badge-danger">{deviceError}</span>}
  </section>
  );
};
