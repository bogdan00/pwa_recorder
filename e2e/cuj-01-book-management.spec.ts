import { expect, test } from '@playwright/test';
import { createBook, createTinyPngBuffer } from './helpers';

test.describe('CUJ-01: Book Project Creation, Metadata, Cover Art, Editing & Deletion', () => {
  test('creates a book with photo cover and full metadata, persists across reload, edits to cloth cover, and deletes cleanly', async ({
    page,
  }) => {
    await page.goto('./');

    // 1. Create first book with uploaded cover photo + full metadata
    await createBook(page, {
      title: 'The Gruffalo',
      author: 'Julia Donaldson',
      narrator: 'Dad',
      dedicatedTo: 'Emma',
      language: 'English',
      tags: 'Bedtime, Favorites',
      description: 'Read with extra silly monster voices.',
      coverFile: {
        name: 'gruffalo-cover.png',
        mimeType: 'image/png',
        buffer: createTinyPngBuffer(),
      },
    });

    await expect(page.getByText('by Julia Donaldson')).toBeVisible();
    await expect(page.getByText('Read by Dad')).toBeVisible();
    await expect(page.getByText('For Emma')).toBeVisible();
    await expect(page.getByText('Read with extra silly monster voices.')).toBeVisible();
    await expect(page.getByAltText('The Gruffalo cover')).toBeVisible();
    await expect(page.locator('.project-hero__tags')).toContainText('Bedtime');
    await expect(page.locator('.project-hero__tags')).toContainText('Favorites');

    // Verify full persistence across page reload
    await page.reload();
    await expect(page.getByRole('heading', { name: 'The Gruffalo' })).toBeVisible();
    await expect(page.getByAltText('The Gruffalo cover')).toBeVisible();

    // 2. Create second book -> verify default narrator is pre-populated and cloth cover swatch works
    await page.getByLabel('Back to library').click();
    await page.locator('#new-book-fab').click();
    await expect(page.locator('#book-narrator-input')).toHaveValue('Dad');
    await page.locator('#book-title-input').fill('Winnie-the-Pooh');
    await page.locator('#book-author-input').fill('A. A. Milne');
    await page.getByRole('radio', { name: 'Warm Ochre' }).click();
    await page.locator('#save-book-btn').click();
    await expect(page.getByRole('heading', { name: 'Winnie-the-Pooh' })).toBeVisible();
    await expect(page.locator('.book-cover__cloth').first()).toBeVisible();

    // 3. Edit first book: remove cover photo, pick Forest Sage cloth color, edit title & notes
    await page.getByLabel('Back to library').click();
    await page.getByRole('button', { name: /The Gruffalo/i }).click();
    await page.locator('#edit-book-btn').click();
    await page.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('radio', { name: 'Forest Sage' }).click();
    await page.locator('#book-title-input').fill('The Gruffalo (Deluxe)');
    await page.locator('#book-desc-input').fill('Updated bedtime edition.');
    await page.locator('#save-book-btn').click();

    await expect(
      page.getByRole('heading', { name: 'The Gruffalo (Deluxe)' }),
    ).toBeVisible();
    await expect(page.getByText('Updated bedtime edition.')).toBeVisible();
    await expect(page.locator('.book-cover__cloth').first()).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'The Gruffalo (Deluxe)' }),
    ).toBeVisible();

    // 4. Delete book with confirmation
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
