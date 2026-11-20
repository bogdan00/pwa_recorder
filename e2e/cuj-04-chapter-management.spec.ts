import { expect, test } from './fixtures';
import { createBook, recordAndSaveChapter } from './helpers';

test.describe('CUJ-04: Chapter Management — Rename, Reorder, Download Audio & Delete', () => {
  test('renames inline, reorders chapters with persistence, downloads audio file, and deletes chapter', async ({
    page,
  }) => {
    await page.goto('./');
    await createBook(page, { title: 'Charlotte’s Web', author: 'E. B. White' });

    await recordAndSaveChapter(page, { name: 'Before Breakfast', minDurationSec: 0.6 });
    await recordAndSaveChapter(page, { name: 'Wilbur', minDurationSec: 0.6 });

    // Verify initial order
    const titles = page.locator('.rec-card__title');
    await expect(titles).toHaveText(['Before Breakfast', 'Wilbur']);

    // 1. Inline Rename Chapter 1
    await page.getByLabel('More actions for Before Breakfast').click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const renameInput = page.getByLabel('Rename recording');
    await renameInput.fill('Ch. 1 — Before Breakfast');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(titles).toHaveText(['Ch. 1 — Before Breakfast', 'Wilbur']);

    // 2. Move Down Chapter 1 -> swaps order with Wilbur
    await page.getByLabel('More actions for Ch. 1 — Before Breakfast').click();
    await page.getByRole('menuitem', { name: 'Move Down' }).click();
    await expect(titles).toHaveText(['Wilbur', 'Ch. 1 — Before Breakfast']);

    // Reload to confirm rename & reorder persisted in IndexedDB
    await page.reload();
    await expect(page.locator('.rec-card__title')).toHaveText([
      'Wilbur',
      'Ch. 1 — Before Breakfast',
    ]);

    // 3. Download Local Audio Copy
    const downloadPromise = page.waitForEvent('download');
    await page.getByLabel('More actions for Wilbur').click();
    await page.getByRole('menuitem', { name: 'Download Audio' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^01 - Wilbur\.(webm|m4a|wav)$/);

    // 4. Delete Chapter 1
    await page.getByLabel('More actions for Wilbur').click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.locator('.rec-card__title')).toHaveText([
      'Ch. 1 — Before Breakfast',
    ]);

    await page.reload();
    await expect(page.locator('.rec-card__title')).toHaveText([
      'Ch. 1 — Before Breakfast',
    ]);
  });
});
