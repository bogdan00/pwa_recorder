import { expect, test } from '@playwright/test';
import { createBook, waitForStudioTimer } from './helpers';

test.describe('CUJ-02: Core Audio Recording — Start, Live Waveform, Pause, Safe Resume & Stop Name Prompt', () => {
  test('records live audio with advancing timer, pauses, resumes a second time cleanly, backs out of stop modal safely, then saves named chapter', async ({
    page,
  }) => {
    await page.goto('./');
    await createBook(page, { title: 'The Tale of Peter Rabbit', author: 'Beatrix Potter' });

    // 1. Open Recording Studio
    await page.locator('#record-chapter-btn').click();
    await expect(page.getByTestId('recording-studio-view')).toBeVisible();
    await expect(page.locator('.studio-status-pill')).toHaveText('READY');
    await expect(page.getByTestId('studio-timer')).toHaveText('00:00.0');
    await expect(page.locator('#small-stop-btn')).toBeDisabled();

    // Verify big record button is meaningfully larger than smaller stop button
    const bigBox = await page.locator('#big-record-pause-btn').boundingBox();
    const stopBox = await page.locator('#small-stop-btn').boundingBox();
    expect(bigBox).not.toBeNull();
    expect(stopBox).not.toBeNull();
    expect(bigBox!.width).toBeGreaterThan(stopBox!.width + 20);

    // 2. Start recording -> reactively wait for live timer to advance
    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('REC');
    await expect(page.locator('#small-stop-btn')).toBeEnabled();

    const firstSegmentSec = await waitForStudioTimer(
      page,
      (sec) => sec >= 0.8,
      'first recording segment should advance to >= 0.8s',
    );

    // 3. Pause -> then Resume (tests 2nd AudioWorklet attach on same AudioContext!)
    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');

    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('REC');

    await waitForStudioTimer(
      page,
      (sec) => sec >= firstSegmentSec + 0.6,
      'resumed recording segment should advance at least 0.6s beyond first segment',
    );

    // 4. Full Stop -> Recording Name prompt -> verify "Back to Recording" safety escape
    await page.locator('#small-stop-btn').click();
    const nameInput = page.locator('#recording-name-input');
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('Chapter 1');

    await page.getByRole('button', { name: 'Back to Recording', exact: true }).click();
    await expect(nameInput).toBeHidden();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');

    // 5. Stop again, enter custom chapter name + notes, and save
    await page.locator('#small-stop-btn').click();
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Mr. McGregor’s Garden');
    await page.locator('#recording-notes-input').fill('Pages 1–10');
    await page.locator('#confirm-save-recording-btn').click();

    // Returns to Book Detail with saved chapter & persists across reload
    await expect(
      page.locator('.rec-card__title', { hasText: 'Mr. McGregor’s Garden' }),
    ).toBeVisible();
    await expect(page.getByText('Pages 1–10', { exact: true })).toBeVisible();
    await expect(page.locator('.rec-card__meta')).toContainText(/WEBM|M4A|WAV/);

    await page.reload();
    await expect(
      page.locator('.rec-card__title', { hasText: 'Mr. McGregor’s Garden' }),
    ).toBeVisible();
  });
});
