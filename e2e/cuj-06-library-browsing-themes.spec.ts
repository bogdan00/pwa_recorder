import { expect, test } from '@playwright/test';
import { createBook, recordAndSaveChapter } from './helpers';

test.describe('CUJ-06: Audiobook Library Browsing (Search, Tags, Sort) & Themes', () => {
  test('filters by book/author/chapter search and tag chips, sorts A-Z, and persists Warm Paper / Warm Night themes', async ({
    page,
  }) => {
    await page.goto('./');

    // Seed 3 distinct books (one with a distinctive chapter name)
    await createBook(page, {
      title: 'Zog',
      author: 'Julia Donaldson',
      tags: 'Dragons, Bedtime',
    });
    await recordAndSaveChapter(page, { name: 'Madame Dragon’s School', minDurationSec: 0.6 });

    await page.getByLabel('Back to library').click();
    await createBook(page, {
      title: 'Alice in Wonderland',
      author: 'Lewis Carroll',
      tags: 'Classics',
    });

    await page.getByLabel('Back to library').click();
    await createBook(page, {
      title: 'Goodnight Moon',
      author: 'Margaret Wise Brown',
      tags: 'Bedtime',
    });

    await page.getByLabel('Back to library').click();
    const shelf = page.getByLabel('Audiobook library');
    await expect(shelf.locator('.book-card')).toHaveCount(3);

    // 1. Search by chapter title ("Madame Dragon") finds Zog!
    const search = page.getByLabel('Search audiobooks');
    await search.fill('Madame Dragon');
    await expect(shelf.locator('.book-card')).toHaveCount(1);
    await expect(shelf).toContainText('Zog');

    // Search with no matches -> empty message + Show All Books button
    await search.fill('Nonexistent Dinosaur');
    await expect(page.getByText('No Matching Books')).toBeVisible();
    await page.getByRole('button', { name: 'Show All Books' }).click();
    await expect(shelf.locator('.book-card')).toHaveCount(3);

    // 2. Tag chip filtering
    await page.getByRole('tab', { name: 'Bedtime' }).click();
    await expect(shelf.locator('.book-card')).toHaveCount(2);
    await expect(shelf).toContainText('Zog');
    await expect(shelf).toContainText('Goodnight Moon');
    await expect(shelf).not.toContainText('Alice in Wonderland');

    await page.getByRole('tab', { name: 'All Books' }).click();
    await expect(shelf.locator('.book-card')).toHaveCount(3);

    // 3. Sort A-Z orders books alphabetically
    await page.getByLabel('Sort audiobooks').selectOption('title');
    await expect(shelf.locator('.book-card__title')).toHaveText([
      'Alice in Wonderland',
      'Goodnight Moon',
      'Zog',
    ]);

    // 4. Switch Theme: Warm Night (default) -> Warm Paper (light) -> persists reload
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#open-settings-btn').click();
    await page.getByRole('button', { name: 'Warm Paper' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      '#F8F3EC',
    );
    await page.getByLabel('Close settings').click();

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Switch back to Warm Night
    await page.locator('#open-settings-btn').click();
    await page.getByRole('button', { name: 'Warm Night' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
