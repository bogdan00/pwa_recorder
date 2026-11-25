import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { encodeWav } from '../../audio/wavEncoder';
import {
  ImportAudioSheet,
  type ImportAudioSubmission,
} from '../ImportAudioSheet';

function makeWavFile(name: string, durationSec = 0.5): File {
  const sr = 8000;
  const frames = Math.floor(sr * durationSec);
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    pcm[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.4;
  }
  const blob = encodeWav([pcm], sr, 16);
  return new File([blob], name, { type: 'audio/wav' });
}

describe('ImportAudioSheet', () => {
  it('naturally sorts picked files, lets user edit titles/narrator/order, flags invalid files, and submits valid chapters', async () => {
    const onImport = vi.fn(async (_sub: ImportAudioSubmission) => {});
    const onClose = vi.fn();

    const { container } = render(
      <ImportAudioSheet
        open
        bookTitle="Goodnight Moon"
        existingChapterCount={1}
        defaultNarrator="Mom"
        onClose={onClose}
        onImport={onImport}
      />,
    );

    const fileInput = container.querySelector(
      '#import-audio-file-input',
    ) as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    const ch10 = makeWavFile('Chapter 10 - Finale.wav', 0.6);
    const ch2 = makeWavFile('Chapter 2 - Stars.wav', 0.4);
    const invalid = new File(['not audio'], 'notes.txt', { type: 'text/plain' });

    fireEvent.change(fileInput, { target: { files: [ch10, invalid, ch2] } });

    // Wait for inspection to settle
    await waitFor(() => {
      expect(
        screen.getByDisplayValue('Chapter 2 - Stars'),
      ).toBeInTheDocument();
      expect(
        screen.getByDisplayValue('Chapter 10 - Finale'),
      ).toBeInTheDocument();
    });

    // Invalid file is flagged inline without blocking the 2 valid chapters
    expect(screen.getByText(/1 unsupported file skipped/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/unsupported file type/i);

    // Edit title of Chapter 2
    const ch2Input = screen.getByDisplayValue('Chapter 2 - Stars');
    fireEvent.change(ch2Input, { target: { value: 'Under the Stars' } });

    // Move Chapter 10 up above Under the Stars
    fireEvent.click(screen.getByLabelText('Move Chapter 10 - Finale up'));

    // Update narrator
    const narratorInput = screen.getByLabelText(/read by/i);
    expect(narratorInput).toHaveValue('Mom');
    fireEvent.change(narratorInput, { target: { value: 'Dad' } });

    // Submit
    const submitBtn = screen.getByRole('button', { name: /import 2 chapters/i });
    expect(submitBtn).toBeEnabled();
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledTimes(1);
    });

    const submission = onImport.mock.calls[0][0];
    expect(submission.recordedBy).toBe('Dad');
    expect(submission.items.map((i) => i.name)).toEqual([
      'Chapter 10 - Finale',
      'Under the Stars',
    ]);
    expect(submission.items[0].analysis.extension).toBe('wav');
    expect(submission.items[0].analysis.durationMs).toBe(600);
  });

  it('keeps Import button disabled when only invalid files are selected', async () => {
    const { container } = render(
      <ImportAudioSheet
        open
        bookTitle="Empty Book"
        existingChapterCount={0}
        defaultNarrator=""
        onClose={vi.fn()}
        onImport={vi.fn()}
      />,
    );

    const fileInput = container.querySelector(
      '#import-audio-file-input',
    ) as HTMLInputElement;
    const bad = new File(['hello'], 'readme.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [bad] } });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    expect(
      screen.getByRole('button', { name: /import chapter/i }),
    ).toBeDisabled();
  });
});
