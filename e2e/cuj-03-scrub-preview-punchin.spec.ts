import { expect, test } from './fixtures';
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

  test('trims trailing audio via Stop here, supports undo after backing out of save prompt, and saves the trimmed chapter', async ({
    page,
  }) => {
    await page.goto('./');
    await createBook(page, { title: 'The Velveteen Rabbit' });

    // Record until timer reaches >= 2.2s so we can scrub into the middle and stop cleanly
    await page.locator('#record-chapter-btn').click();
    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('REC');
    await waitForStudioTimer(
      page,
      (sec) => sec >= 2.2,
      'initial take should reach at least 2.2s before scrubbing to Stop here',
    );

    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');

    const fullDurationSec = parseTimerSeconds(
      (await page.getByTestId('studio-timer').textContent()) || '00:00.0',
    );
    expect(fullDurationSec).toBeGreaterThanOrEqual(2.2);

    // Drag right across a moderate portion of the waveform so playhead lands in the middle (>= 0.3s, < end - 0.5s)
    const canvas = page.locator('.waveform-canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const midY = box!.y + box!.height * 0.5;
    const dragStart = box!.x + box!.width * 0.35;
    const dragEnd = box!.x + box!.width * 0.62;

    await page.mouse.move(dragStart, midY);
    await page.mouse.down();
    await page.mouse.move(dragEnd, midY, { steps: 10 });
    await page.mouse.up();

    await expect(page.locator('.studio-timer-sub')).toContainText('Scrubbed');
    const scrubbedSec = await waitForStudioTimer(
      page,
      (sec) => sec >= 0.3 && sec <= fullDurationSec - 0.4,
      'playhead should scrub cleanly into the middle of the take',
    );

    // Verify Stop here button appears beside Re-record from
    const stopHereBtn = page.locator('#trim-stop-here-btn');
    await expect(stopHereBtn).toBeVisible();
    await expect(stopHereBtn).toContainText('Stop here');

    // 1. Tap Stop here -> trims trailing audio & opens Save Recording modal directly
    await stopHereBtn.click();
    const nameInput = page.locator('#recording-name-input');
    await expect(nameInput).toBeVisible();

    // 2. Tap Back to Recording -> returns paused at trimmed length with Undo trim available!
    await page.getByRole('button', { name: 'Back to Recording', exact: true }).click();
    await expect(nameInput).toBeHidden();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');
    await waitForStudioTimer(
      page,
      (sec) => sec <= scrubbedSec + 0.2 && sec < fullDurationSec - 0.3,
      'studio timer should reflect trimmed duration after Stop here',
    );

    // Undo trim restores full original duration!
    const undoBtn = page.locator('#undo-trim-btn');
    await expect(undoBtn).toBeVisible();
    await undoBtn.click();
    await expect(undoBtn).toBeHidden();
    await waitForStudioTimer(
      page,
      (sec) => sec >= fullDurationSec - 0.15,
      'undo trim should restore full pre-cut duration',
    );

    // 3. Scrub back into middle again -> Stop here -> Save trimmed chapter cleanly
    await page.mouse.move(dragStart, midY);
    await page.mouse.down();
    await page.mouse.move(dragEnd, midY, { steps: 10 });
    await page.mouse.up();
    await expect(stopHereBtn).toBeVisible();

    await stopHereBtn.click();
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Trimmed Ending');
    await page.locator('#confirm-save-recording-btn').click();

    await expect(
      page.locator('.rec-card__title', { hasText: 'Trimmed Ending' }),
    ).toBeVisible();
  });
});
