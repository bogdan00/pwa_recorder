import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BeforeInstallPromptEvent,
  detectIosDevice,
  detectStandaloneMode,
  INSTALL_DISMISS_COOLDOWN_MS,
  isInstallBannerDismissed,
  persistInstallBannerDismissal,
  pwaInstallController,
} from '../installPrompt';

function createMockInstallEvent(
  outcome: 'accepted' | 'dismissed',
): BeforeInstallPromptEvent & { promptSpy: ReturnType<typeof vi.fn> } {
  const promptSpy = vi.fn().mockResolvedValue(undefined);
  const event = new Event('beforeinstallprompt', {
    cancelable: true,
  }) as BeforeInstallPromptEvent & { promptSpy: ReturnType<typeof vi.fn> };
  event.prompt = promptSpy;
  Object.defineProperty(event, 'userChoice', {
    value: Promise.resolve({ outcome, platform: 'web' }),
  });
  event.promptSpy = promptSpy;
  return event;
}

describe('PWA install prompt utilities & controller', () => {
  beforeEach(() => {
    localStorage.clear();
    pwaInstallController.resetForTests();
  });

  afterEach(() => {
    localStorage.clear();
    pwaInstallController.resetForTests();
  });

  it('detects standalone mode from navigator.standalone and display-mode media queries', () => {
    expect(
      detectStandaloneMode({
        navigator: { standalone: true },
        matchMedia: () => ({ matches: false }),
      }),
    ).toBe(true);

    expect(
      detectStandaloneMode({
        navigator: { standalone: false },
        matchMedia: (q) => ({ matches: q.includes('standalone') }),
      }),
    ).toBe(true);

    expect(
      detectStandaloneMode({
        navigator: { standalone: false },
        matchMedia: () => ({ matches: false }),
      }),
    ).toBe(false);
  });

  it('detects iPhone, iPad, and iPadOS 13+ MacIntel touch devices without false positives', () => {
    expect(
      detectIosDevice({
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15',
        platform: 'iPhone',
        maxTouchPoints: 5,
      }),
    ).toBe(true);

    expect(
      detectIosDevice({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      }),
    ).toBe(true);

    expect(
      detectIosDevice({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      }),
    ).toBe(false);

    expect(
      detectIosDevice({
        userAgent:
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0',
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
      }),
    ).toBe(false);
  });

  it('persists dismissal cooldown and expires after 14 days', () => {
    const start = 1_700_000_000_000;
    expect(isInstallBannerDismissed(localStorage, start)).toBe(false);

    persistInstallBannerDismissal(localStorage, start);
    expect(isInstallBannerDismissed(localStorage, start + 1_000)).toBe(true);
    expect(
      isInstallBannerDismissed(
        localStorage,
        start + INSTALL_DISMISS_COOLDOWN_MS - 1_000,
      ),
    ).toBe(true);
    expect(
      isInstallBannerDismissed(
        localStorage,
        start + INSTALL_DISMISS_COOLDOWN_MS + 1_000,
      ),
    ).toBe(false);
  });

  it('captures beforeinstallprompt, respects banner dismissal while keeping settings action, and handles accepted install', async () => {
    expect(pwaInstallController.getState().showBanner).toBe(false);

    const bip = createMockInstallEvent('accepted');
    window.dispatchEvent(bip);

    expect(bip.defaultPrevented).toBe(true);
    expect(pwaInstallController.getState().canPromptNative).toBe(true);
    expect(pwaInstallController.getState().showBanner).toBe(true);

    // Dismissing hides the Library banner but keeps Settings install button available
    pwaInstallController.dismissBanner();
    expect(pwaInstallController.getState().showBanner).toBe(false);
    expect(pwaInstallController.getState().canInstallFromSettings).toBe(true);

    // Triggering native install calls prompt() and marks app installed on accept
    const outcome = await pwaInstallController.triggerNativeInstall();
    expect(bip.promptSpy).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('accepted');
    expect(pwaInstallController.getState().isInstalled).toBe(true);
    expect(pwaInstallController.getState().showBanner).toBe(false);
    expect(pwaInstallController.getState().canInstallFromSettings).toBe(false);
  });

  it('clears install prompt cleanly when user declines or appinstalled fires', async () => {
    const declined = createMockInstallEvent('dismissed');
    window.dispatchEvent(declined);
    expect(pwaInstallController.getState().showBanner).toBe(true);

    const outcome = await pwaInstallController.triggerNativeInstall();
    expect(outcome).toBe('dismissed');
    expect(pwaInstallController.getState().isInstalled).toBe(false);
    expect(pwaInstallController.getState().canPromptNative).toBe(false);

    // Another beforeinstallprompt arrives later, then appinstalled fires externally
    const second = createMockInstallEvent('accepted');
    window.dispatchEvent(second);
    expect(pwaInstallController.getState().canPromptNative).toBe(true);

    window.dispatchEvent(new Event('appinstalled'));
    expect(pwaInstallController.getState().isInstalled).toBe(true);
    expect(pwaInstallController.getState().showBanner).toBe(false);
  });
});
