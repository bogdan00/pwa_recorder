import { expect, test } from '@playwright/test';
import { createBook, parseTimerSeconds, waitForStudioTimer } from './helpers';

test.describe('CUJ-03: Paused Waveform Drag-to-Scrub, Preview Playback, Punch-In & Undo', () => {
  test('drags waveform canvas to scrub, plays preview, performs punch-in re-recording with undo, and verifies unsaved exit/discard guards', async ({
    page,
  }) => {
    await page.goto('./');
    await createBook(page, { title: 'Where the Wild Things Are' });

    // Record until timer reaches >= 1.8s so we have plenty of waveform to drag-scrub
    await page.locator('#record-chapter-btn').click();
    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('REC');
    await waitForStudioTimer(
      page,
      (sec) => sec >= 1.8,
      'initial take should reach at least 1.8s before scrubbing',
    );

    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');

    const totalBeforeScrub = parseTimerSeconds(
      (await page.getByTestId('studio-timer').textContent()) || '00:00.0',
    );
    expect(totalBeforeScrub).toBeGreaterThanOrEqual(1.8);

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

    await expect(page.locator('.studio-timer-sub')).toContainText('Scrubbed');
    await waitForStudioTimer(
      page,
      (sec) => sec < totalBeforeScrub - 0.35,
      'waveform drag should scrub playhead earlier than end',
    );

    // Safe default label + contextual punch-in button appear when scrubbed back
    await expect(page.getByText('Continue at end')).toBeVisible();
    const punchInBtn = page.locator('#punch-in-btn');
    await expect(punchInBtn).toBeVisible();
    await expect(punchInBtn).toContainText('Re-record from');

    // 3. Play preview from scrubbed position and verify playhead actively advances
    await page.locator('#studio-preview-play-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('PLAYING');
    const playStartSec = parseTimerSeconds(
      (await page.getByTestId('studio-timer').textContent()) || '00:00.0',
    );
    await waitForStudioTimer(
      page,
      (sec) => sec > playStartSec + 0.15,
      'preview playback should advance playhead beyond start position',
    );
    await page.locator('#studio-preview-play-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');

    // Re-scrub back with -5s so playhead is cleanly before the end
    await page.getByLabel('Skip back 5 seconds').click();
    await expect(page.locator('#punch-in-btn')).toBeVisible();

    // 4. Perform Punch-In Re-Recording -> Pause -> Verify Undo Trim restores length!
    await page.locator('#punch-in-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('REC');
    await waitForStudioTimer(
      page,
      (sec) => sec >= 0.4,
      'punch-in re-recording should advance to >= 0.4s',
    );
    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');

    const undoBtn = page.locator('#undo-trim-btn');
    await expect(undoBtn).toBeVisible();
    await undoBtn.click();
    await expect(undoBtn).toBeHidden();

    await waitForStudioTimer(
      page,
      (sec) => sec >= totalBeforeScrub - 0.15,
      'undo trim should restore original recording length',
    );

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
