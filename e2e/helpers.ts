import { expect, type Page } from '@playwright/test';

export function parseTimerSeconds(text: string): number {
  const cleaned = text.trim();
  const parts = cleaned.split(':');
  if (parts.length === 2) {
    const mins = Number(parts[0]);
    const secs = Number(parts[1]);
    return mins * 60 + secs;
  }
  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  return 0;
}

export interface CreateBookInput {
  title: string;
  author?: string;
  narrator?: string;
  dedicatedTo?: string;
  language?: string;
  tags?: string;
  description?: string;
  coverFile?: { name: string; mimeType: string; buffer: Buffer };
}

export async function createBook(page: Page, input: CreateBookInput): Promise<void> {
  await page.locator('#empty-new-book-btn, #new-book-fab').first().click();

  await expect(page.locator('#book-title-input')).toBeVisible();

  if (input.coverFile) {
    await page
      .getByLabel('Choose cover photo from library')
      .setInputFiles(input.coverFile);
    await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
  }

  await page.locator('#book-title-input').fill(input.title);
  if (input.author !== undefined) {
    await page.locator('#book-author-input').fill(input.author);
  }
  if (input.narrator !== undefined) {
    await page.locator('#book-narrator-input').fill(input.narrator);
  }
  if (input.dedicatedTo !== undefined) {
    await page.locator('#book-dedicated-input').fill(input.dedicatedTo);
  }
  if (input.language !== undefined) {
    await page.locator('#book-language-input').fill(input.language);
  }
  if (input.tags !== undefined) {
    await page.locator('#book-tags-input').fill(input.tags);
  }
  if (input.description !== undefined) {
    await page.locator('#book-desc-input').fill(input.description);
  }

  await page.locator('#save-book-btn').click();
  await expect(page.getByRole('heading', { name: input.title })).toBeVisible();
}

export async function waitForStudioTimer(
  page: Page,
  predicate: (seconds: number) => boolean,
  message = 'studio timer condition',
): Promise<number> {
  let latest = 0;
  await expect
    .poll(
      async () => {
        const text = (await page.getByTestId('studio-timer').textContent()) || '00:00.0';
        latest = parseTimerSeconds(text);
        return predicate(latest);
      },
      { message },
    )
    .toBe(true);
  return latest;
}

export async function recordAndSaveChapter(
  page: Page,
  options: { name: string; notes?: string; minDurationSec?: number },
): Promise<void> {
  await page.locator('#record-chapter-btn').click();
  await expect(page.getByTestId('recording-studio-view')).toBeVisible();

  await page.locator('#big-record-pause-btn').click();
  await expect(page.locator('.studio-status-pill')).toHaveText('REC');

  const minDurationSec = options.minDurationSec ?? 0.6;
  await waitForStudioTimer(
    page,
    (sec) => sec >= minDurationSec,
    `studio timer should reach at least ${minDurationSec}s`,
  );

  await page.locator('#small-stop-btn').click();
  const nameInput = page.locator('#recording-name-input');
  await expect(nameInput).toBeVisible();
  await nameInput.fill(options.name);
  if (options.notes) {
    await page.locator('#recording-notes-input').fill(options.notes);
  }
  await page.locator('#confirm-save-recording-btn').click();

  await expect(page.locator('.rec-card__title', { hasText: options.name })).toBeVisible();
}

/**
 * Generates a valid 1x1 PNG buffer for testing book cover photo uploads.
 */
export function createTinyPngBuffer(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}

/**
 * Generates a valid PCM WAV buffer (mono 8kHz 16-bit) for mocked Drive downloads.
 */
export function createSilentWavBuffer(durationSec = 2): Buffer {
  const sampleRate = 8000;
  const numFrames = Math.floor(sampleRate * durationSec);
  const dataSize = numFrames * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  // Subtle audible sine tone so waveform/playback aren't pure zeros
  for (let i = 0; i < numFrames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 6000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}
