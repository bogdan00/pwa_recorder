import { expect, test } from './fixtures';
import {
  createTinyPngBuffer,
  recordAndSaveChapter,
} from './helpers';

test.describe('CUJ-01: Book Project Creation, Metadata, Cover Art, Editing & Deletion', () => {
  test('creates a book with simplified metadata and photo cover, auto-derives narrator from recordings, persists across reload, edits to cloth cover, and deletes cleanly', async ({
    page,
  }) => {
    await page.goto('./');

    // Configure narrator name in Settings so recorded chapters auto-credit the book
    await page.locator('#open-settings-btn').click();
    await page.locator('#default-narrator-input').fill('Dad');
    await page.getByLabel('Close settings').click();

    // 1. Verify simplified book definition sheet hides narrator, kid name/dedication, language, and tags
    await page.locator('#empty-new-book-btn').click();
    await expect(page.locator('#book-title-input')).toBeVisible();
    await expect(page.locator('#book-author-input')).toBeVisible();
    await expect(page.locator('#book-desc-input')).toBeVisible();
    await expect(page.locator('#book-narrator-input')).toHaveCount(0);
    await expect(page.locator('#book-dedicated-input')).toHaveCount(0);
    await expect(page.locator('#book-language-input')).toHaveCount(0);
    await expect(page.locator('#book-tags-input')).toHaveCount(0);

    // Create first book with uploaded cover photo + title, author, and optional notes
    await page
      .getByLabel('Choose cover photo from library')
      .setInputFiles({
        name: 'gruffalo-cover.png',
        mimeType: 'image/png',
        buffer: createTinyPngBuffer(),
      });
    await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
    await page.locator('#book-title-input').fill('The Gruffalo');
    await page.locator('#book-author-input').fill('Julia Donaldson');
    await page
      .locator('#book-desc-input')
      .fill('Recorded while recovering from a mild cold.');
    await page.locator('#save-book-btn').click();

    await expect(page.getByRole('heading', { name: 'The Gruffalo' })).toBeVisible();
    await expect(page.getByText('by Julia Donaldson')).toBeVisible();
    await expect(
      page.getByText('Recorded while recovering from a mild cold.'),
    ).toBeVisible();
    await expect(page.getByAltText('The Gruffalo cover')).toBeVisible();
    // Before any chapters exist, no narrator credit is shown
    await expect(page.locator('.project-hero__credits')).toHaveCount(0);

    // 2. Record a chapter -> book narrator credit is automatically derived from the recording creator
    await recordAndSaveChapter(page, {
      name: 'Into the Deep Dark Wood',
      minDurationSec: 0.5,
    });
    await expect(page.locator('.project-hero__credits')).toContainText('Read by Dad');

    // Verify full persistence across page reload
    await page.reload();
    await expect(page.getByRole('heading', { name: 'The Gruffalo' })).toBeVisible();
    await expect(page.getByAltText('The Gruffalo cover')).toBeVisible();
    await expect(page.locator('.project-hero__credits')).toContainText('Read by Dad');

    // 3. Create second book -> verify cloth cover swatch works with just title & author
    await page.getByLabel('Back to library').click();
    await page.locator('#new-book-fab').click();
    await page.locator('#book-title-input').fill('Winnie-the-Pooh');
    await page.locator('#book-author-input').fill('A. A. Milne');
    await page.getByRole('radio', { name: 'Warm Ochre' }).click();
    await page.locator('#save-book-btn').click();
    await expect(page.getByRole('heading', { name: 'Winnie-the-Pooh' })).toBeVisible();
    await expect(page.locator('.book-cover__cloth').first()).toBeVisible();

    // 4. Edit first book: remove cover photo, pick Forest Sage cloth color, edit title & notes
    await page.getByLabel('Back to library').click();
    await page.getByRole('button', { name: /The Gruffalo/i }).click();
    await page.locator('#edit-book-btn').click();
    await page.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('radio', { name: 'Forest Sage' }).click();
    await page.locator('#book-title-input').fill('The Gruffalo (Deluxe)');
    await page.locator('#book-desc-input').fill('Voice back to normal for chapter 2.');
    await page.locator('#save-book-btn').click();

    await expect(
      page.getByRole('heading', { name: 'The Gruffalo (Deluxe)' }),
    ).toBeVisible();
    await expect(
      page.getByText('Voice back to normal for chapter 2.'),
    ).toBeVisible();
    await expect(page.locator('.book-cover__cloth').first()).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'The Gruffalo (Deluxe)' }),
    ).toBeVisible();

    // 5. Delete book with confirmation
    await page.locator('#edit-book-btn').click();
    await page.getByRole('button', { name: 'Delete Book' }).click();
    await page.getByRole('button', { name: 'Confirm Delete' }).click();

    await expect(page.getByLabel('Audiobook library')).not.toContainText(
      'The Gruffalo (Deluxe)',
    );
    await expect(page.getByLabel('Audiobook library')).toContainText(
      'Winnie-the-Pooh',
    );
  });
});
