import { expect, test as base } from '@playwright/test';

export interface StoryTapeTestOptions {
  /**
   * Chrome DevTools Protocol CPU throttling multiplier (1 = unthrottled, 4 = 4x slower CPU).
   * Used by the `mobile-slow-cpu` project to deterministically surface slow-phone and
   * contended-CI timing/animation races locally before pushing.
   */
  cpuThrottleRate: number;
}

function isAllowedLocalUrl(rawUrl: string): boolean {
  if (
    rawUrl.startsWith('data:') ||
    rawUrl.startsWith('blob:') ||
    rawUrl.startsWith('about:')
  ) {
    return true;
  }
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

export const test = base.extend<StoryTapeTestOptions>({
  cpuThrottleRate: [
    Number(process.env.E2E_CPU_THROTTLE || '1'),
    { option: true },
  ],

  context: async ({ context }, use) => {
    const unexpectedExternalUrls: string[] = [];

    // Context-level network fence runs AFTER any test-specific `page.route(...)` stubs.
    // 1. Deterministically neutralize static third-party <head> assets (Google Fonts & GIS loader)
    //    so online CI runners never fetch real webfonts or clobber test mocks.
    // 2. Abort & fail loudly on ANY other unstubbed external request so missing API/script mocks
    //    are caught locally before pushing instead of only failing in online CI.
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (isAllowedLocalUrl(url)) {
        await route.continue();
        return;
      }

      try {
        const parsed = new URL(url);
        if (
          parsed.hostname === 'fonts.googleapis.com' ||
          parsed.hostname === 'fonts.gstatic.com'
        ) {
          await route.fulfill({
            status: 200,
            contentType:
              parsed.hostname === 'fonts.googleapis.com'
                ? 'text/css'
                : 'font/woff2',
            body: '',
          });
          return;
        }
        if (
          parsed.hostname === 'accounts.google.com' &&
          parsed.pathname === '/gsi/client'
        ) {
          await route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: '// Stubbed GSI loader (offline/CI parity fence)\n',
          });
          return;
        }
      } catch {
        // Fall through to strict failure below
      }

      unexpectedExternalUrls.push(`${route.request().method()} ${url}`);
      await route.abort('blockedbyclient');
    });

    await use(context);

    expect(
      unexpectedExternalUrls,
      'Unexpected unstubbed external network request(s) detected. Stub third-party endpoints with page.route(...) so tests are deterministic offline and in CI.',
    ).toEqual([]);
  },

  page: async ({ context, page, cpuThrottleRate }, use) => {
    const uncaughtErrors: string[] = [];
    const viewportOverflowViolations = new Set<string>();

    page.on('pageerror', (err) => {
      uncaughtErrors.push(err.stack || err.message || String(err));
    });

    // Global mobile viewport overflow fence: streams horizontal overflow violations from
    // ANY screen, sheet, or state visited during ANY CUJ E2E test directly into the runner
    // so layout regressions never slip past precheck onto phones.
    await page.exposeFunction('__storyTapeReportOverflow', (detail: string) => {
      viewportOverflowViolations.add(detail);
    });

    await page.addInitScript(() => {
      const CHECK_SELECTORS = [
        '.library-header__inner',
        '.library-page',
        '.project-page',
        '.quality-lab-page',
        '.sheet-panel',
        '.studio-page',
        '.player-sheet',
      ];
      const BOUNDED_ITEM_SELECTORS = [
        '.library-header button',
        '.project-topbar button',
        '.quality-lab-topbar button',
        '[data-testid="theme-switcher-sheet"] [data-theme-option]',
      ];

      let raf1 = 0;
      let raf2 = 0;

      const report = (msg: string) => {
        const fn = (
          window as unknown as { __storyTapeReportOverflow?: (s: string) => void }
        ).__storyTapeReportOverflow;
        if (typeof fn === 'function') fn(msg);
      };

      const checkLayout = () => {
        if (!document.body || !document.documentElement) return;
        const vw = window.innerWidth;
        if (vw <= 0) return;
        const route = window.location.hash || '#/';

        if (Math.abs(window.scrollX) > 1) {
          report(`[${route} @ ${vw}px] window.scrollX=${Math.round(window.scrollX)}`);
        }

        const docScrollW = document.documentElement.scrollWidth;
        const docClientW = document.documentElement.clientWidth;
        if (docScrollW > docClientW + 1) {
          report(
            `[${route} @ ${vw}px] documentElement horizontal overflow (${docScrollW} > ${docClientW})`,
          );
        }

        for (const sel of CHECK_SELECTORS) {
          const nodes = document.querySelectorAll<HTMLElement>(sel);
          for (const el of Array.from(nodes)) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (el.scrollWidth > el.clientWidth + 1) {
              report(
                `[${route} @ ${vw}px] ${sel} scrollWidth overflow (${Math.round(el.scrollWidth)} > ${Math.round(el.clientWidth)})`,
              );
            }
            if (Math.round(rect.right) > vw + 1 || Math.round(rect.left) < -1) {
              report(
                `[${route} @ ${vw}px] ${sel} outside viewport [${Math.round(rect.left)}, ${Math.round(rect.right)}] vs [0, ${vw}]`,
              );
            }
          }
        }

        for (const sel of BOUNDED_ITEM_SELECTORS) {
          const nodes = document.querySelectorAll<HTMLElement>(sel);
          for (const el of Array.from(nodes)) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (Math.round(rect.right) > vw + 1 || Math.round(rect.left) < -1) {
              const label =
                el.id ||
                el.getAttribute('data-theme-option') ||
                el.getAttribute('aria-label') ||
                el.textContent?.trim().slice(0, 20) ||
                sel;
              report(
                `[${route} @ ${vw}px] control "${label}" outside viewport [${Math.round(rect.left)}, ${Math.round(rect.right)}] vs [0, ${vw}]`,
              );
            }
          }
        }
      };

      const scheduleCheck = () => {
        if (raf1) cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
        raf1 = requestAnimationFrame(() => {
          raf2 = requestAnimationFrame(checkLayout);
        });
      };

      window.addEventListener('load', scheduleCheck);
      window.addEventListener('resize', scheduleCheck);
      window.addEventListener('hashchange', scheduleCheck);

      const startObservers = () => {
        if (!document.body) return;
        const mo = new MutationObserver(scheduleCheck);
        mo.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme'],
        });
        if (typeof ResizeObserver !== 'undefined') {
          const ro = new ResizeObserver(scheduleCheck);
          ro.observe(document.documentElement);
        }
        scheduleCheck();
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObservers, { once: true });
      } else {
        startObservers();
      }
    });

    let cdpSession: Awaited<ReturnType<typeof context.newCDPSession>> | null =
      null;
    if (cpuThrottleRate > 1) {
      cdpSession = await context.newCDPSession(page);
      await cdpSession.send('Emulation.setCPUThrottlingRate', {
        rate: cpuThrottleRate,
      });
    }

    await use(page);

    if (cdpSession) {
      await cdpSession
        .send('Emulation.setCPUThrottlingRate', { rate: 1 })
        .catch(() => {});
      await cdpSession.detach().catch(() => {});
    }

    expect(
      Array.from(viewportOverflowViolations),
      'Mobile horizontal viewport overflow detected during E2E execution.',
    ).toEqual([]);

    expect(
      uncaughtErrors,
      'Uncaught pageerror(s) occurred during E2E test execution.',
    ).toEqual([]);
  },
});

export { expect };
export type { Page } from '@playwright/test';
