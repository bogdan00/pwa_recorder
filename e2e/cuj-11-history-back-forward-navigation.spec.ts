import { expect, test } from './fixtures';
import {
  createBook,
  recordAndSaveChapter,
  waitForStudioTimer,
} from './helpers';

test.describe('CUJ-11: Mobile Back & Forward History Navigation', () => {
  test('navigates back and forward cleanly across screens, keeps in-app Back symmetric, and handles deep-linked books', async ({
    page,
  }) => {
    await page.goto('./');
    await expect(page.locator('.library-page')).toBeVisible();

    // Verify horizontal overscroll swipe gestures are NOT blocked (pull-to-refresh still blocked vertically)
    const overscroll = await page.evaluate(() => {
      const style = window.getComputedStyle(document.documentElement);
      return {
        x: style.overscrollBehaviorX,
        y: style.overscrollBehaviorY,
      };
    });
    expect(overscroll.x).toBe('auto');
    expect(overscroll.y).toBe('none');

    // Create a book -> replaces New Book form with Book Detail ([Library, Book])
    await createBook(page, { title: 'The Magic Faraway Tree', author: 'Enid Blyton' });
    const bookHash = await page.evaluate(() => window.location.hash);
    expect(bookHash).toMatch(/^#\/book\//);

    // Enter Recording Studio (idle, 0s) -> [Library, Book, Record]
    await page.locator('#record-chapter-btn').click();
    await expect(page.getByTestId('recording-studio-view')).toBeVisible();

    // Swipe/browser Back: Studio -> Book Detail
    await page.goBack();
    await expect(page.getByTestId('recording-studio-view')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'The Magic Faraway Tree' })).toBeVisible();

    // Swipe/browser Back: Book Detail -> Library (never loops back into New Book form!)
    await page.goBack();
    await expect(page.locator('.library-page')).toBeVisible();
    await expect(page.locator('#book-title-input')).toBeHidden();

    // Swipe/browser Forward twice: Library -> Book Detail -> Recording Studio
    await page.goForward();
    await expect(page.getByRole('heading', { name: 'The Magic Faraway Tree' })).toBeVisible();

    await page.goForward();
    await expect(page.getByTestId('recording-studio-view')).toBeVisible();

    // In-app Back buttons pop history symmetrically (so Forward still works afterward!)
    await page.getByLabel('Leave recording studio').click();
    await expect(page.getByRole('heading', { name: 'The Magic Faraway Tree' })).toBeVisible();

    await page.getByLabel('Back to library').click();
    await expect(page.locator('.library-page')).toBeVisible();

    await page.goForward();
    await expect(page.getByRole('heading', { name: 'The Magic Faraway Tree' })).toBeVisible();

    // Deep-link safe fallback: opening #/book/:id directly in a fresh context at index 0
    const deepPage = await page.context().newPage();
    await deepPage.goto(`./${bookHash}`);
    await expect(
      deepPage.getByRole('heading', { name: 'The Magic Faraway Tree' }),
    ).toBeVisible();
    await deepPage.getByLabel('Back to library').click();
    await expect(deepPage.locator('.library-page')).toBeVisible();
    expect(await deepPage.evaluate(() => window.location.hash)).toBe('#/');
    await deepPage.close();
  });

  test('dismisses sheets, nested Settings -> Theme Switcher, and ConfirmDialog on Back without closing the PWA or resurrecting stale confirms on Forward', async ({
    page,
  }) => {
    await page.goto('./');
    await expect(page.locator('.library-page')).toBeVisible();

    // 1. Settings -> App tab -> Theme Switcher stacked on top
    await page.getByLabel('Open settings').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();

    await page.getByTestId('settings-tab-app').click();
    await expect(page.getByTestId('settings-theme-row')).toBeVisible();

    await page.getByTestId('settings-theme-row').click();
    await expect(page.getByTestId('theme-switcher-sheet')).toBeVisible();

    // Swipe Back once -> closes Theme Switcher while Settings stays open on App tab
    await page.goBack();
    await expect(page.getByTestId('theme-switcher-sheet')).toBeHidden();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();
    await expect(page.getByTestId('settings-tab-app')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Swipe Back again -> closes Settings cleanly back to Library (PWA stays open!)
    await page.goBack();
    await expect(page.getByTestId('settings-sheet')).toBeHidden();
    await expect(page.locator('.library-page')).toBeVisible();

    // Swipe Forward twice -> restores Settings (on App tab!) then Theme Switcher
    await page.goForward();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();
    await expect(page.getByTestId('settings-tab-app')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.goForward();
    await expect(page.getByTestId('theme-switcher-sheet')).toBeVisible();

    // Close both via in-app Close buttons
    await page.getByLabel('Close theme switcher').click();
    await expect(page.getByTestId('theme-switcher-sheet')).toBeHidden();
    await page.getByLabel('Close settings').click();
    await expect(page.getByTestId('settings-sheet')).toBeHidden();

    // 2. BookEditorSheet & ShareSheet dismiss cleanly on Back
    await page.locator('#empty-new-book-btn, #new-book-fab').first().click();
    await expect(page.locator('#book-title-input')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#book-title-input')).toBeHidden();
    await expect(page.locator('.library-page')).toBeVisible();

    await page.getByLabel('Share family library').click();
    await expect(page.getByTestId('share-sheet')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('share-sheet')).toBeHidden();
    await expect(page.locator('.library-page')).toBeVisible();

    // 3. ConfirmDialog dismisses on Back without leaving Book Detail & never resurrects on Forward
    await createBook(page, { title: 'Confirm Back Book' });
    await recordAndSaveChapter(page, { name: 'Chapter One', minDurationSec: 0.4 });

    await page.getByLabel('More actions for Chapter One').click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();

    // Swipe Back -> closes ConfirmDialog while remaining on Book Detail
    await page.goBack();
    await expect(page.getByTestId('confirm-dialog')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Confirm Back Book' })).toBeVisible();
    await expect(page.locator('.rec-card__title', { hasText: 'Chapter One' })).toBeVisible();

    // Swipe Forward -> dead ConfirmDialog MUST NOT resurrect
    await page.goForward();
    await expect(page.getByTestId('confirm-dialog')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Confirm Back Book' })).toBeVisible();
  });

  test('dismisses AudioPlayerSheet drawers then minimizes full-screen player on Back and re-expands on Forward', async ({
    page,
  }) => {
    await page.goto('./');
    await createBook(page, { title: 'Bedtime Fables' });
    await recordAndSaveChapter(page, { name: 'The Tortoise', minDurationSec: 0.5 });

    // Start playing from Book Detail -> opens full-screen AudioPlayerSheet
    await page.getByRole('button', { name: /listen/i }).click();
    await expect(page.getByTestId('audio-player-sheet')).toBeVisible();

    // Open Chapters sub-drawer inside player
    const chaptersDrawer = page
      .getByTestId('audio-player-sheet')
      .getByRole('region', { name: 'Chapters' });
    await page.getByRole('button', { name: 'Chapters', exact: true }).click();
    await expect(chaptersDrawer).toBeVisible();

    // Swipe Back #1 -> closes Chapters drawer while keeping full-screen Player open
    await page.goBack();
    await expect(chaptersDrawer).toBeHidden();
    await expect(page.getByTestId('audio-player-sheet')).toBeVisible();

    // Swipe Back #2 -> minimizes Player back to Book Detail with MiniPlayerBar visible
    await page.goBack();
    await expect(page.getByTestId('audio-player-sheet')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Bedtime Fables' })).toBeVisible();
    await expect(page.getByTestId('mini-player-bar')).toBeVisible();

    // Swipe Forward -> re-expands full-screen AudioPlayerSheet
    await page.goForward();
    await expect(page.getByTestId('audio-player-sheet')).toBeVisible();

    // Minimize via in-app ChevronDown -> returns to Book Detail, then Back -> Library
    await page.getByLabel('Minimize player').click();
    await expect(page.getByTestId('audio-player-sheet')).toBeHidden();
    await page.goBack();
    await expect(page.locator('.library-page')).toBeVisible();

    // Expand from Library via MiniPlayerBar -> Back stays on Library (does not close PWA!)
    await page.getByLabel('Open player for The Tortoise').click();
    await expect(page.getByTestId('audio-player-sheet')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('audio-player-sheet')).toBeHidden();
    await expect(page.locator('.library-page')).toBeVisible();
  });

  test('maintains clean Back history after saving a recording, resuming & saving a draft, and deleting a book', async ({
    page,
  }) => {
    await page.goto('./');
    await createBook(page, { title: 'Clean Stack Book' });

    // 1. Book -> Record -> Save -> single Back from Book must land on Library (not Studio!)
    await recordAndSaveChapter(page, { name: 'Chapter 1', minDurationSec: 0.4 });
    await page.goBack();
    await expect(page.locator('.library-page')).toBeVisible();

    // 2. Create a draft, return to Library, Resume Draft -> Save -> single Back must land on Library
    await page.getByRole('button', { name: /clean stack book/i }).click();
    await page.locator('#record-chapter-btn').click();
    await page.locator('#big-record-pause-btn').click();
    await waitForStudioTimer(page, (sec) => sec >= 0.4, 'draft timer >= 0.4s');
    await page.getByLabel('Leave recording studio').click();
    await page.getByRole('button', { name: 'Keep Draft & Leave' }).click();
    await expect(page.getByRole('heading', { name: 'Clean Stack Book' })).toBeVisible();

    await page.goBack();
    await expect(page.locator('.library-page')).toBeVisible();

    const banner = page.getByLabel('Unfinished recording draft');
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByTestId('recording-studio-view')).toBeVisible();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');

    await page.locator('#small-stop-btn').click();
    await page.locator('#recording-name-input').fill('Recovered Ch 2');
    await page.locator('#confirm-save-recording-btn').click();
    await expect(
      page.locator('.rec-card__title', { hasText: 'Recovered Ch 2' }),
    ).toBeVisible();

    // Single swipe Back from Book Detail goes straight to Library
    await page.goBack();
    await expect(page.locator('.library-page')).toBeVisible();

    // 3. Delete book from BookEditorSheet -> lands cleanly on Library
    await page.getByRole('button', { name: /clean stack book/i }).click();
    await page.locator('#edit-book-btn').click();
    await expect(page.locator('#book-title-input')).toBeVisible();
    await page.getByRole('button', { name: 'Delete Book' }).click();
    await page.getByRole('button', { name: 'Confirm Delete' }).click();
    await expect(page.locator('.library-page')).toBeVisible();
    await expect(page.getByText('Clean Stack Book')).toBeHidden();
    expect(await page.evaluate(() => window.location.hash)).toBe('#/');
  });

  test('protects unsaved Recording Studio audio on swipe-back and dismisses SaveRecordingSheet safely', async ({
    page,
  }) => {
    await page.goto('./');
    await createBook(page, { title: 'Protected Take Book' });

    await page.locator('#record-chapter-btn').click();
    await expect(page.getByTestId('recording-studio-view')).toBeVisible();

    // Record > 0.6s of audio
    await page.locator('#big-record-pause-btn').click();
    await expect(page.locator('.studio-status-pill')).toHaveText('REC');
    await waitForStudioTimer(page, (sec) => sec >= 0.6, 'recording >= 0.6s');

    // 1. Open SaveRecordingSheet -> swipe Back closes save sheet back to paused Studio
    await page.locator('#small-stop-btn').click();
    await expect(page.locator('#recording-name-input')).toBeVisible();

    await page.goBack();
    await expect(page.locator('#recording-name-input')).toBeHidden();
    await expect(page.getByTestId('recording-studio-view')).toBeVisible();
    await expect(page.locator('.studio-status-pill')).toHaveText('PAUSED');

    // 2. Swipe Back while unsaved audio exists -> intercepts exit, stays mounted, opens Unsaved Recording prompt
    await page.goBack();
    await expect(page.getByTestId('recording-studio-view')).toBeVisible();
    await expect(page.getByText('Unsaved Recording')).toBeVisible();

    // 3. Swipe Back while Unsaved Recording prompt is open -> dismisses prompt ("Stay"), keeps audio intact
    await page.goBack();
    await expect(page.getByText('Unsaved Recording')).toBeHidden();
    await expect(page.getByTestId('recording-studio-view')).toBeVisible();
    await waitForStudioTimer(
      page,
      (sec) => sec >= 0.5,
      'unsaved take audio must remain intact after staying',
    );

    // 4. Swipe Back again -> choose Keep Draft & Leave -> returns cleanly to Book Detail
    await page.goBack();
    await expect(page.getByText('Unsaved Recording')).toBeVisible();
    await page.getByRole('button', { name: 'Keep Draft & Leave' }).click();
    await expect(page.getByTestId('recording-studio-view')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Protected Take Book' })).toBeVisible();

    // One more swipe Back from Book Detail goes straight to Library
    await page.goBack();
    await expect(page.locator('.library-page')).toBeVisible();
    await expect(page.getByLabel('Unfinished recording draft')).toBeVisible();
  });
});
