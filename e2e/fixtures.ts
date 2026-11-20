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
    page.on('pageerror', (err) => {
      uncaughtErrors.push(err.stack || err.message || String(err));
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
      uncaughtErrors,
      'Uncaught pageerror(s) occurred during E2E test execution.',
    ).toEqual([]);
  },
});

export { expect };
export type { Page } from '@playwright/test';
