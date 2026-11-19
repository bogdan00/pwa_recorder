import { expect, test } from '@playwright/test';
import { createBook, parseTimerSeconds } from './helpers';

test.describe('CUJ-03: Paused Waveform Drag-to-Scrub, Preview Playback, Punch-In & Undo', () => {
  test('drags waveform canvas to scrub, plays preview, performs punch-in re-recording with undo, and verifies unsaved exit/discard guards', async ({
    page,
  }) => {
    await page.goto('./');
    await createBook(page, { title: 'Where the Wild Things Are' });

    // Record ~2.4 seconds so we have plenty of waveform to drag-scrub
    await page.locator('#record-chapter-btn').click();
    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('REC');
    await page.waitForTimeout(2400);

    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');

    const totalBeforeScrub = parseTimerSeconds(
      (await page.getByTestId('studio-timer').textContent()) || '00:00.0',
    );
    expect(totalBeforeScrub).toBeGreaterThan(1.6);

    // 1. Toggle waveform zoom 1× -> 2×
    const zoomBtn = page.getByRole('button', { name: /Waveform zoom/i });
    await expect(zoomBtn).toHaveText('1×');
    await zoomBtn.click();
    await expect(zoomBtn).toHaveText('2×');

    // 2. Direct pointer drag right across the waveform canvas to scrub backward!
    const canvas = page.locator('.waveform-canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width * 0.25;
    const endX = box!.x + box!.width * 0.85;
    const midY = box!.y + box!.height * 0.5;

    await page.mouse.move(startX, midY);
    await page.mouse.down();
    await page.mouse.move(endX, midY, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    const scrubbedSec = parseTimerSeconds(
      (await page.getByTestId('studio-timer').textContent()) || '00:00.0',
    );
    expect(scrubbedSec).toBeLessThan(totalBeforeScrub - 0.35);
    await expect(page.locator('.studio-timer-sub')).toContainText('Scrubbed');

    // Safe default label + contextual punch-in button appear when scrubbed back
    await expect(page.getByText('Continue at end')).toBeVisible();
    const punchInBtn = page.locator('#punch-in-btn');
    await expect(punchInBtn).toBeVisible();
    await expect(punchInBtn).toContainText('Re-record from');

    // 3. Play preview from scrubbed position
    await page.locator('#studio-preview-play-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('PLAYING');
    await page.waitForTimeout(450);
    await page.locator('#studio-preview-play-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');

    // Re-scrub back with -5s so we know playhead is at 00:00.0 (or before end)
    await page.getByLabel('Skip back 5 seconds').click();
    await expect(page.locator('#punch-in-btn')).toBeVisible();

    // 4. Perform Punch-In Re-Recording -> Pause -> Verify Undo Trim restores length!
    await page.locator('#punch-in-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('REC');
    await page.waitForTimeout(600);
    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');

    const undoBtn = page.locator('#undo-trim-btn');
    await expect(undoBtn).toBeVisible();
    await undoBtn.click();
    await expect(undoBtn).toBeHidden();

    const restoredSec = parseTimerSeconds(
      (await page.getByTestId('studio-timer').textContent()) || '00:00.0',
    );
    expect(restoredSec).toBeGreaterThanOrEqual(totalBeforeScrub - 0.15);

    // 5. Unsaved exit guard (Stay) + Discard Take confirmation
    await page.getByLabel('Leave recording studio').click();
    await expect(page.getByText('Unsaved Recording')).toBeVisible();
    await page.getByRole('button', { name: 'Stay' }).click();
    await expect(page.getByText('Unsaved Recording')).toBeHidden();

    await page.getByLabel('Discard current recording').click();
    await expect(page.getByText('Discard this Take?')).toBeVisible();
    await page.getByRole('button', { name: 'Discard Take' }).click();

    await expect(page.locator('.studio-status-pill')).toHaveText('READY');
    await expect(page.getByTestId('studio-timer')).toHaveText('00:00.0');
  });
});
