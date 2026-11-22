import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { resetDbConnectionForTests } from '../storage/db';
import { resetCapabilitiesCacheForTests } from '../audio/qualityPresets';
import {
  RecordingEngine,
  type StudioSnapshot,
} from '../audio/recordingEngine';
import type { AudioQualitySettings } from '../types/models';

/**
 * Lightweight mock RecordingEngine for deterministic UI testing of:
 * Big Record/Pause -> Waveform live -> Pause -> Scrub -> Preview Play -> Punch-In -> Stop -> Name Sheet
 */
class FakeRecordingEngine extends RecordingEngine {
  private mockSnap: StudioSnapshot = {
    phase: 'idle',
    durationMs: 0,
    playheadMs: 0,
    liveLevel: 0,
    peaks: [],
    canUndoTrim: false,
    activeDeviceLabel: 'Shure MV7 USB',
    actualSampleRate: 48000,
    channels: 1,
    draftId: null,
  };
  private subs = new Set<(s: StudioSnapshot) => void>();

  constructor(projectId: string) {
    super(projectId);
  }

  private push() {
    const copy = { ...this.mockSnap };
    this.subs.forEach((fn) => fn(copy));
  }

  override subscribe(fn: (snap: StudioSnapshot) => void): () => void {
    this.subs.add(fn);
    fn({ ...this.mockSnap });
    return () => this.subs.delete(fn);
  }

  override getSnapshot(): StudioSnapshot {
    return { ...this.mockSnap };
  }

  override async startOrResumeFromEnd() {
    this.mockSnap = {
      ...this.mockSnap,
      phase: 'recording',
      durationMs: Math.max(this.mockSnap.durationMs, 10000),
      playheadMs: Math.max(this.mockSnap.durationMs, 10000),
      liveLevel: 0.65,
      peaks: Array.from({ length: 500 }, () => 0.45),
    };
    this.push();
    return { usedFallbackDevice: false };
  }

  override async pause() {
    this.mockSnap = {
      ...this.mockSnap,
      phase: 'paused',
      liveLevel: 0,
    };
    this.push();
  }

  override seekToMs(ms: number) {
    this.mockSnap = {
      ...this.mockSnap,
      playheadMs: Math.max(0, Math.min(ms, this.mockSnap.durationMs)),
    };
    this.push();
  }

  override async playPreviewFromPlayhead() {
    this.mockSnap = { ...this.mockSnap, phase: 'playing' };
    this.push();
  }

  override pausePreview() {
    this.mockSnap = { ...this.mockSnap, phase: 'paused' };
    this.push();
  }

  override async punchInFromPlayhead() {
    const trimmedMs = this.mockSnap.durationMs - this.mockSnap.playheadMs;
    this.mockSnap = {
      ...this.mockSnap,
      phase: 'recording',
      durationMs: this.mockSnap.playheadMs,
      canUndoTrim: true,
    };
    this.push();
    return { usedFallbackDevice: false, trimmedMs };
  }

  override async pauseForStopPrompt() {
    this.mockSnap = { ...this.mockSnap, phase: 'paused' };
    this.push();
  }

  override async finalizeAndEncode(quality: AudioQualitySettings) {
    return {
      encoded: {
        blob: new Blob(['mock-audio-data'], { type: 'audio/mp4' }),
        mimeType: 'audio/mp4',
        extension: 'm4a' as const,
        sampleRate: quality.sampleRate,
        bitrateKbps: quality.bitrateKbps,
        channels: quality.channels,
      },
      durationMs: this.mockSnap.durationMs || 10000,
      overviewPeaks: [0.3, 0.6, 0.4],
      deviceLabel: this.mockSnap.activeDeviceLabel,
    };
  }

  override async dispose() {
    this.subs.clear();
  }
}

describe('StoryTape end-to-end UI workflows', () => {
  const originalMediaDevices = navigator.mediaDevices;

  beforeEach(async () => {
    window.localStorage.clear();
    window.location.hash = '#/';
    resetCapabilitiesCacheForTests();
    vi.stubGlobal('AudioEncoder', {
      isConfigSupported: vi.fn().mockResolvedValue({ supported: true }),
    });
    vi.stubGlobal('AudioData', class {});

    await resetDbConnectionForTests();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('storytape-db');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'audioinput', deviceId: 'default', label: 'Built-in Mic', groupId: 'g1' },
          { kind: 'audioinput', deviceId: 'usb-1', label: 'Shure MV7 USB', groupId: 'g2' },
        ]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCapabilitiesCacheForTests();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it('creates a book with metadata, configures mic & high-ceiling quality settings, records with pause/scrub/punch-in/name prompt, and opens the minimalistic player', async () => {
    const user = userEvent.setup();
    render(<App engineFactory={(pid) => new FakeRecordingEngine(pid)} />);

    // 1. Open Settings and configure Microphone + Studio Quality (510 kbps + Stereo + Custom)
    await user.click(screen.getByLabelText('Open settings'));
    expect(await screen.findByText('Studio Settings')).toBeInTheDocument();

    const usbRadio = await screen.findByRole('radio', { name: 'Shure MV7 USB' });
    await user.click(usbRadio);
    expect(usbRadio).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByTestId('advanced-audio-toggle'));
    await user.click(await screen.findByRole('button', { name: '510k' }));
    await user.click(screen.getByRole('button', { name: 'Stereo (2 ch · External Mic)' }));
    expect(screen.getByTestId('quality-preset-badge')).toHaveTextContent('Custom');

    await user.click(screen.getByTestId('settings-tab-app'));
    await user.type(screen.getByLabelText(/default narrator name/i), 'Dad');

    await user.click(screen.getByLabelText('Close settings'));

    // 2. Create a new Book project with simplified fields (title, author, optional notes)
    await user.click(screen.getByRole('button', { name: /create first book/i }));
    expect(screen.queryByLabelText(/read by/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/recorded for/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/language/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/tags/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/book title/i), 'The Gruffalo');
    await user.type(screen.getByLabelText(/author/i), 'Julia Donaldson');
    await user.type(screen.getByLabelText(/notes/i), 'Recorded with a mild cold');
    await user.click(screen.getByRole('button', { name: /create book/i }));

    // Navigates into Book Project Detail view (narrator not shown until a chapter is recorded)
    expect(
      await screen.findByRole('heading', { name: 'The Gruffalo' }),
    ).toBeInTheDocument();
    expect(screen.getByText('by Julia Donaldson')).toBeInTheDocument();
    expect(screen.getByText('Recorded with a mild cold')).toBeInTheDocument();
    expect(screen.queryByText('Read by Dad')).not.toBeInTheDocument();

    // 3. Enter Recording Studio (and simulate real browser hashchange firing right after navigate)
    await user.click(
      screen.getByRole('button', { name: /record first chapter/i }),
    );
    act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByTestId('recording-studio-view')).toBeInTheDocument();

    const bigBtn = screen.getByLabelText('Start recording');
    const stopBtn = screen.getByLabelText('Stop and save recording');
    expect(stopBtn).toBeDisabled();

    // Tap big Start -> recording
    await user.click(bigBtn);
    expect(screen.getByText('REC')).toBeInTheDocument();
    expect(stopBtn).not.toBeDisabled();

    // Tap big Pause -> paused
    await user.click(screen.getByLabelText('Pause recording'));
    expect(screen.getByText('PAUSED')).toBeInTheDocument();

    // Scrub back 5 seconds while paused -> verify preview play & contextual punch-in button!
    await user.click(screen.getByLabelText('Skip back 5 seconds'));
    expect(screen.getByRole('button', { name: /re-record from 00:05/i })).toBeInTheDocument();

    // Preview play the last bit
    await user.click(screen.getByRole('button', { name: /^play$/i }));
    expect(screen.getByText('PLAYING')).toBeInTheDocument();

    // Tap smaller Stop button -> Recording Name prompt appears!
    await user.click(stopBtn);
    const nameInput = await screen.findByLabelText('Recording Name');
    expect(nameInput).toHaveValue('Chapter 1');

    await user.clear(nameInput);
    await user.type(nameInput, 'Into the Deep Dark Wood');
    await user.click(screen.getByRole('button', { name: /^save recording$/i }));

    // Returns to Project Detail with the newly saved chapter and auto-derived narrator credit
    expect(
      await screen.findByText('Into the Deep Dark Wood'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Read by Dad').length).toBeGreaterThanOrEqual(2);

    // 4. Play chapter -> verify floating MiniPlayerBar & full-screen minimalistic player
    await user.click(
      screen.getByRole('button', { name: /play into the deep dark wood/i }),
    );
    expect(await screen.findByTestId('mini-player-bar')).toBeInTheDocument();

    // Expand minimalistic full-screen player sheet
    await user.click(
      screen.getByLabelText('Open player for Into the Deep Dark Wood'),
    );
    expect(await screen.findByTestId('audio-player-sheet')).toBeInTheDocument();

    // Cycle playback speed & open bedtime sleep timer
    const speedBtn = screen.getByLabelText(/playback speed/i);
    await user.click(speedBtn);
    expect(speedBtn).toHaveTextContent('1.15×');

    await user.click(screen.getByLabelText('Sleep timer'));
    await user.click(screen.getByRole('button', { name: '15 minutes' }));

    // Minimize player & browse library with search
    await user.click(screen.getByLabelText('Minimize player'));
    await user.click(screen.getByLabelText('Back to library'));

    const searchInput = await screen.findByLabelText('Search audiobooks');
    expect(screen.getByTestId('mini-player-bar')).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'Deep Dark Wood' } });
    await waitFor(() => {
      expect(screen.getByLabelText('Audiobook library')).toHaveTextContent(
        'The Gruffalo',
      );
    });

    fireEvent.change(searchInput, { target: { value: 'Nonexistent Story' } });
    expect(await screen.findByText('No Matching Books')).toBeInTheDocument();
  });
});
