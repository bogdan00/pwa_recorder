import { expect, test } from './fixtures';
import { createBook, recordAndSaveChapter } from './helpers';

test.describe('CUJ-06: Audiobook Library Browsing (Search, Tags, Sort) & Themes', () => {
  test('filters by book/author/chapter search and tag chips, sorts A-Z, and switches across 10 curated themes via Quick Switcher & Settings', async ({
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

    // 4. Default Pitch OLED theme -> 1-tap Library Theme Switcher -> Braun / Rams -> persists reload
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'pitch-oled');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      '#000000',
    );

    await page.locator('#open-theme-switcher-btn').click();
    const switcher = page.getByTestId('theme-switcher-sheet');
    await expect(switcher).toBeVisible();
    await expect(switcher.locator('[data-theme-option]')).toHaveCount(10);
    await expect(switcher).not.toContainText('Warm Night');
    await expect(switcher).not.toContainText('Warm Paper');

    await switcher.locator('[data-theme-option="braun-light"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'braun-light');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      '#ECECE8',
    );
    await switcher.getByRole('button', { name: 'Done' }).click();
    await expect(switcher).toHaveCount(0);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'braun-light');

    // Switch via Settings to Nord Polar
    await page.locator('#open-settings-btn').click();
    await page.locator('[data-theme-option="nord"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      '#242933',
    );
  });
});
