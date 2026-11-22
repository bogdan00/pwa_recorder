import { expect, test } from './fixtures';
import { createBook, recordAndSaveChapter } from './helpers';

test.describe('CUJ-06: Audiobook Library Browsing (Search & Sort) & Themes', () => {
  test('filters by book/author/notes/chapter search, sorts A-Z, and switches across 10 curated themes via Quick Switcher & Settings', async ({
    page,
  }) => {
    await page.goto('./');

    // Seed 3 distinct books (one with a distinctive chapter name and one with a note)
    await createBook(page, {
      title: 'Zog',
      author: 'Julia Donaldson',
    });
    await recordAndSaveChapter(page, { name: 'Madame Dragon’s School', minDurationSec: 0.6 });

    await page.getByLabel('Back to library').click();
    await createBook(page, {
      title: 'Alice in Wonderland',
      author: 'Lewis Carroll',
    });

    await page.getByLabel('Back to library').click();
    await createBook(page, {
      title: 'Goodnight Moon',
      author: 'Margaret Wise Brown',
      description: 'Recorded with a scratchy cold voice',
    });

    await page.getByLabel('Back to library').click();
    const shelf = page.getByLabel('Audiobook library');
    await expect(shelf.locator('.book-card')).toHaveCount(3);

    // 1. Search by chapter title ("Madame Dragon") finds Zog!
    const search = page.getByLabel('Search audiobooks');
    await search.fill('Madame Dragon');
    await expect(shelf.locator('.book-card')).toHaveCount(1);
    await expect(shelf).toContainText('Zog');

    // Search by book note finds Goodnight Moon!
    await search.fill('scratchy cold');
    await expect(shelf.locator('.book-card')).toHaveCount(1);
    await expect(shelf).toContainText('Goodnight Moon');

    // Search with no matches -> empty message + Show All Books button
    await search.fill('Nonexistent Dinosaur');
    await expect(page.getByText('No Matching Books')).toBeVisible();
    await page.getByRole('button', { name: 'Show All Books' }).click();
    await expect(shelf.locator('.book-card')).toHaveCount(3);

    // 2. Sort A-Z orders books alphabetically
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

    // Switch via Settings -> App tab -> compact Color Theme row -> Theme Switcher to Nord Polar
    await page.locator('#open-settings-btn').click();
    await page.getByTestId('settings-tab-app').click();
    const themeRow = page.getByTestId('settings-theme-row');
    await expect(themeRow).toContainText('Braun / Rams');
    await themeRow.click();
    await expect(switcher).toBeVisible();
    await switcher.locator('[data-theme-option="nord"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      '#242933',
    );
    await switcher.getByRole('button', { name: 'Done' }).click();
    await expect(switcher).toHaveCount(0);
    await expect(themeRow).toContainText('Nord Polar');
  });

  test('fits cleanly within mobile phone viewports (360px & 390px) with zero horizontal overflow and no studio/player viewport scroll', async ({
    page,
  }) => {
    const assertNoHorizontalOverflow = async (
      screenLabel: string,
      extraSelectors: string[] = [],
    ) => {
      const metrics = await page.evaluate((selectors) => {
        const vw = window.innerWidth;
        const containers = [
          '.library-header__inner',
          '.library-page',
          '.sheet-panel',
          '.studio-page',
          '.player-sheet',
          ...selectors,
        ];
        const overflowingContainers: Array<{
          selector: string;
          scrollW: number;
          clientW: number;
          right: number;
          vw: number;
        }> = [];

        for (const sel of containers) {
          for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (el.scrollWidth > el.clientWidth + 1 || Math.round(rect.right) > vw) {
              overflowingContainers.push({
                selector: sel,
                scrollW: Math.round(el.scrollWidth),
                clientW: Math.round(el.clientWidth),
                right: Math.round(rect.right),
                vw,
              });
            }
          }
        }

        return {
          docScrollW: document.documentElement.scrollWidth,
          docClientW: document.documentElement.clientWidth,
          bodyScrollW: document.body.scrollWidth,
          innerW: vw,
          scrollX: window.scrollX,
          overflowingContainers,
        };
      }, extraSelectors);

      expect(
        metrics.scrollX,
        `${screenLabel}: window.scrollX must remain 0`,
      ).toBe(0);
      expect(
        metrics.docScrollW,
        `${screenLabel}: documentElement.scrollWidth (${metrics.docScrollW}) must not exceed clientWidth (${metrics.docClientW})`,
      ).toBeLessThanOrEqual(metrics.docClientW);
      expect(
        metrics.bodyScrollW,
        `${screenLabel}: body.scrollWidth (${metrics.bodyScrollW}) must not exceed innerWidth (${metrics.innerW})`,
      ).toBeLessThanOrEqual(metrics.innerW);
      expect(
        metrics.overflowingContainers,
        `${screenLabel}: container(s) overflowed viewport`,
      ).toEqual([]);
    };

    const assertElementsFitViewport = async (
      screenLabel: string,
      selector: string,
    ) => {
      const result = await page.evaluate((sel) => {
        const vw = window.innerWidth;
        return Array.from(document.querySelectorAll<HTMLElement>(sel)).map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.id || el.getAttribute('data-theme-option') || el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 24),
            left: Math.round(r.left),
            right: Math.round(r.right),
            vw,
          };
        });
      }, selector);
      expect(result.length, `${screenLabel}: expected elements for ${selector}`).toBeGreaterThan(0);
      for (const el of result) {
        expect(
          el.left,
          `${screenLabel}: element "${el.id}" overflows left edge (${el.left})`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          el.right,
          `${screenLabel}: element "${el.id}" overflows right edge (${el.right} > ${el.vw})`,
        ).toBeLessThanOrEqual(el.vw);
      }
    };

    // Test at narrow 360x740 Android/small-phone viewport AND standard 390x844 iPhone viewport
    for (const vp of [
      { width: 360, height: 740, label: '360x740' },
      { width: 390, height: 844, label: '390x844' },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('./');
      await expect(page.getByRole('heading', { name: 'StoryTape' })).toBeVisible();

      // Seed a book + chapter on first pass so Continue Listening and Mini-Player exist
      if (vp.width === 360) {
        await createBook(page, {
          title: 'The Wind in the Willows',
          author: 'Kenneth Grahame',
        });
        await recordAndSaveChapter(page, {
          name: 'Chapter 1: The River Bank',
          minDurationSec: 0.5,
        });
        await page.getByLabel('Back to library').click();
        await expect(page.getByRole('heading', { name: 'StoryTape' })).toBeVisible();
      }

      // 1. Library screen: zero horizontal scroll + every header button inside viewport
      await assertNoHorizontalOverflow(`Library (${vp.label})`);
      await assertElementsFitViewport(`Library (${vp.label})`, '.library-header button');

      // 2. Theme Switcher sheet: zero horizontal scroll & every theme card fits inside viewport
      await page.locator('#open-theme-switcher-btn').click();
      await expect(page.getByTestId('theme-switcher-sheet')).toBeVisible();
      await assertNoHorizontalOverflow(`ThemeSwitcherSheet (${vp.label})`, ['.theme-grid']);
      await assertElementsFitViewport(
        `ThemeSwitcherSheet (${vp.label})`,
        '[data-testid="theme-switcher-sheet"] [data-theme-option]',
      );
      await page.getByRole('button', { name: 'Done' }).click();

      // 3. Settings sheet: zero horizontal scroll across all tabs (including expanded Advanced Audio)
      await page.locator('#open-settings-btn').click();
      await expect(page.getByRole('heading', { name: 'Studio Settings' })).toBeVisible();
      await assertNoHorizontalOverflow(`SettingsSheet Recording (${vp.label})`, ['.settings-tabs']);
      await assertElementsFitViewport(`SettingsSheet Tabs (${vp.label})`, '.settings-tab');
      await page.getByTestId('advanced-audio-toggle').click();
      await expect(page.getByTestId('advanced-audio-panel')).toBeVisible();
      await page.getByTestId('help-btn-channels').click();
      await expect(page.getByTestId('help-panel-channels')).toBeVisible();
      await assertNoHorizontalOverflow(`SettingsSheet Advanced Audio (${vp.label})`, ['.gain-scale-ticks', '.info-tip-panel']);
      await page.getByTestId('settings-tab-drive').click();
      await assertNoHorizontalOverflow(`SettingsSheet Drive (${vp.label})`);
      await page.getByTestId('settings-tab-app').click();
      await assertNoHorizontalOverflow(`SettingsSheet App (${vp.label})`);
      await page.getByLabel('Close settings').click();

      // 4. Book Detail + Full-Screen Audio Player: zero overflow
      await page.locator('.book-card').first().click();
      await expect(page.locator('#record-chapter-btn')).toBeVisible();
      await assertNoHorizontalOverflow(`BookDetail (${vp.label})`);

      await page.getByRole('button', { name: /Play Chapter 1/i }).click();
      await expect(page.getByTestId('mini-player-bar')).toBeVisible();
      await page.getByTestId('mini-player-bar').locator('.mini-player__tap-zone').click();
      await expect(page.getByTestId('audio-player-sheet')).toBeVisible();
      await assertNoHorizontalOverflow(`AudioPlayerSheet (${vp.label})`);
      const playerVertical = await page.evaluate(() => ({
        scrollH: document.documentElement.scrollHeight,
        clientH: document.documentElement.clientHeight,
      }));
      expect(
        playerVertical.scrollH,
        `AudioPlayerSheet (${vp.label}): should fit without vertical page scroll`,
      ).toBeLessThanOrEqual(playerVertical.clientH);
      await page.getByLabel('Minimize player').click();

      // 5. Recording Studio: zero horizontal scroll AND zero vertical page scroll in 100dvh
      await page.locator('#record-chapter-btn').click();
      await expect(page.getByTestId('recording-studio-view')).toBeVisible();
      await assertNoHorizontalOverflow(`RecordingStudio (${vp.label})`);
      const studioVertical = await page.evaluate(() => ({
        scrollH: document.documentElement.scrollHeight,
        clientH: document.documentElement.clientHeight,
      }));
      expect(
        studioVertical.scrollH,
        `RecordingStudio (${vp.label}): should fit in 100dvh without vertical page scroll (${studioVertical.scrollH} > ${studioVertical.clientH})`,
      ).toBeLessThanOrEqual(studioVertical.clientH);

      await page.getByLabel('Leave recording studio').click();
      await page.getByLabel('Back to library').click();
    }
  });
});
