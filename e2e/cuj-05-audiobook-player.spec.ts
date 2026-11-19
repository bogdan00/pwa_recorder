import { expect, test } from '@playwright/test';
import { createBook, recordAndSaveChapter } from './helpers';

test.describe('CUJ-05: Minimalistic Audiobook Player, Mini-Player, Speed, Sleep Timer & Continue Listening', () => {
  test('plays chapters via mini-player & full-screen sheet, switches chapters, changes speed & sleep timer, and restores Continue Listening after reload', async ({
    page,
  }) => {
    await page.goto('./');
    await createBook(page, {
      title: 'The Gruffalo',
      author: 'Julia Donaldson',
      narrator: 'Dad',
    });

    await recordAndSaveChapter(page, { name: 'Into the Deep Dark Wood', recordMs: 1100 });
    await recordAndSaveChapter(page, { name: 'The Owl & The Snake', recordMs: 1100 });

    // 1. Tap Chapter 1 to play -> floating MiniPlayerBar appears
    await page
      .getByRole('button', { name: /Play Into the Deep Dark Wood/i })
      .click();
    const miniPlayer = page.getByTestId('mini-player-bar');
    await expect(miniPlayer).toBeVisible();
    await expect(miniPlayer).toContainText('Into the Deep Dark Wood');
    await expect(miniPlayer).toContainText('The Gruffalo');
    // Pause so short 1s test recording doesn't auto-advance before we inspect Chapter 1 controls
    await miniPlayer.getByLabel('Pause audiobook').click();

    // 2. Navigate back to Library -> MiniPlayerBar persists seamlessly while browsing
    await page.getByLabel('Back to library').click();
    await expect(miniPlayer).toBeVisible();

    // 3. Expand full-screen Minimalistic Audiobook Player sheet
    await miniPlayer.getByLabel('Open player for Into the Deep Dark Wood').click();
    const sheet = page.getByTestId('audio-player-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Chapter 1 of 2');
    await expect(sheet).toContainText('Read by Dad');

    // 4. Advance to Next Chapter via transport button
    await page.getByLabel('Next chapter').click();
    await expect(sheet).toContainText('Chapter 2 of 2');
    await expect(sheet).toContainText('The Owl & The Snake');

    // 5. Open Chapters quick-drawer and jump back to Chapter 1
    await page.getByRole('button', { name: 'Chapters', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Chapters' })).toBeVisible();
    await page.getByRole('button', { name: /01\. Into the Deep Dark Wood/i }).click();
    await expect(sheet).toContainText('Chapter 1 of 2');

    // 6. Cycle playback speed (1× -> 1.15× -> 1.25×)
    const speedBtn = page.getByLabel(/Playback speed/i);
    await expect(speedBtn).toHaveText('1×');
    await speedBtn.click();
    await expect(speedBtn).toHaveText('1.15×');
    await speedBtn.click();
    await expect(speedBtn).toHaveText('1.25×');

    // 7. Activate Bedtime Sleep Timer (End of current chapter)
    await page.getByLabel('Sleep timer').click();
    await expect(page.getByRole('region', { name: 'Sleep Timer' })).toBeVisible();
    await page.getByRole('button', { name: 'End of current chapter' }).click();
    await expect(page.getByLabel('Sleep timer')).toContainText('End of Ch.');

    // 8. Minimize player & reload -> Continue Listening card appears in Library
    await page.getByLabel('Minimize player').click();
    await expect(sheet).toBeHidden();
    await expect(miniPlayer).toBeVisible();

    await page.getByLabel('Close player').click();
    await expect(miniPlayer).toBeHidden();

    await page.reload();
    const continueCard = page.getByTestId('continue-listening-card');
    await expect(continueCard).toBeVisible();
    await expect(continueCard).toContainText('The Gruffalo');
    await expect(continueCard).toContainText('Into the Deep Dark Wood');

    // Tapping Play on Continue Listening opens the minimalistic player directly
    await page.getByLabel('Continue listening to The Gruffalo').click();
    await expect(page.getByTestId('audio-player-sheet')).toBeVisible();
  });
});
