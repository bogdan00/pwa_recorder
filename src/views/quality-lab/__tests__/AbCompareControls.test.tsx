import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SideBySideAbTab } from '../SideBySideAbTab';
import { ThresholdFinderTab } from '../ThresholdFinderTab';

describe('Quality Lab A/B sample controls', () => {
  it('renders Sample A / Sample B as Play/Pause toggles without a redundant transport play button', () => {
    const onToggleSlot = vi.fn();

    const baseProps = {
      caps: null,
      usingLocalMaster: true,
      blindFormat: 'auto' as const,
      blindBitrate: 64 as const,
      blindSampleRate: 48000 as const,
      blindEncoding: false,
      blindCandidate: null,
      aIsMaster: true,
      lastReveal: null,
      tierResults: {},
      recommendation: null,
      isPlaying: false,
      activeSlot: null as 'master' | 'candidate' | null,
      playheadSec: 0,
      playDurationSec: 12,
      onChangeFormat: vi.fn(),
      onChangeBitrate: vi.fn(),
      onToggleSlot,
      onVote: vi.fn(),
      onNextTrial: vi.fn(),
      onAdvanceBitrate: vi.fn(),
      onApplyRecommendation: vi.fn(),
    };

    const { rerender } = render(<ThresholdFinderTab {...baseProps} />);

    // No separate Play/Pause button in the progress bar
    const progressBar = screen.getByTestId('ql-progress-bar');
    expect(progressBar.querySelector('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /comparison/i })).toBeNull();

    const btnA = screen.getByTestId('blind-play-a');
    const btnB = screen.getByTestId('blind-play-b');
    expect(btnA).toHaveAttribute('aria-label', 'Play Sample A');
    expect(btnA).toHaveAttribute('aria-pressed', 'false');
    expect(btnB).toHaveAttribute('aria-label', 'Play Sample B');
    expect(btnB).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(btnA);
    expect(onToggleSlot).toHaveBeenCalledWith('master');

    // Playing Sample A -> Sample A becomes Pause, Sample B remains Play
    rerender(
      <ThresholdFinderTab
        {...baseProps}
        isPlaying
        activeSlot="master"
        playheadSec={2.4}
      />,
    );
    expect(screen.getByTestId('blind-play-a')).toHaveAttribute(
      'aria-label',
      'Pause Sample A',
    );
    expect(screen.getByTestId('blind-play-a')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('blind-play-a')).toHaveTextContent('Pause');
    expect(screen.getByTestId('blind-play-b')).toHaveAttribute(
      'aria-label',
      'Play Sample B',
    );

    // Paused on Sample A mid-track -> Sample A shows Resume, Sample B shows Play
    rerender(
      <ThresholdFinderTab
        {...baseProps}
        isPlaying={false}
        activeSlot="master"
        playheadSec={2.4}
      />,
    );
    expect(screen.getByTestId('blind-play-a')).toHaveAttribute(
      'aria-label',
      'Resume Sample A',
    );
    expect(screen.getByTestId('blind-play-a')).toHaveTextContent('Resume');
    expect(screen.getByTestId('blind-play-b')).toHaveAttribute(
      'aria-label',
      'Play Sample B',
    );

    // Clicking Sample B triggers candidate slot
    fireEvent.click(screen.getByTestId('blind-play-b'));
    expect(onToggleSlot).toHaveBeenLastCalledWith('candidate');
  });

  it('renders Master / Export as Play/Pause toggles in SideBySideAbTab without a redundant transport play button', () => {
    const onToggleSlot = vi.fn();

    const { rerender } = render(
      <SideBySideAbTab
        spec={{
          format: 'wav',
          sampleRate: 48000,
          bitrateKbps: 96,
          bitrateMode: 'variable',
          wavBitDepth: 16,
        }}
        caps={null}
        encoding={false}
        candidate={null}
        compareReferenceBytes={100000}
        isPlaying={false}
        activeSlot={null}
        playheadSec={0}
        playDurationSec={8}
        onChangeSpec={vi.fn()}
        onToggleSlot={onToggleSlot}
      />,
    );

    expect(screen.getByTestId('ql-progress-bar').querySelector('button')).toBeNull();
    expect(screen.getByTestId('ab-play-master')).toHaveAttribute(
      'aria-label',
      'Play Master',
    );
    expect(screen.getByTestId('ab-play-export')).toHaveAttribute(
      'aria-label',
      'Play 16-bit WAV',
    );

    fireEvent.click(screen.getByTestId('ab-play-export'));
    expect(onToggleSlot).toHaveBeenCalledWith('candidate');

    rerender(
      <SideBySideAbTab
        spec={{
          format: 'wav',
          sampleRate: 48000,
          bitrateKbps: 96,
          bitrateMode: 'variable',
          wavBitDepth: 16,
        }}
        caps={null}
        encoding={false}
        candidate={null}
        compareReferenceBytes={100000}
        isPlaying
        activeSlot="candidate"
        playheadSec={1.5}
        playDurationSec={8}
        onChangeSpec={vi.fn()}
        onToggleSlot={onToggleSlot}
      />,
    );

    expect(screen.getByTestId('ab-play-export')).toHaveAttribute(
      'aria-label',
      'Pause 16-bit WAV',
    );
    expect(screen.getByTestId('ab-play-export')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('ab-play-master')).toHaveAttribute(
      'aria-label',
      'Play Master',
    );
    expect(screen.getByTestId('ab-play-master')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
