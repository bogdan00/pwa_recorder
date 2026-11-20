/**
 * PWA Install Prompt controller.
 *
 * - Captures Chromium's `beforeinstallprompt` event as early as module load so it is never missed
 *   before React mounts, and exposes a synchronous gesture-safe `triggerNativeInstall()` call.
 * - Detects iOS / iPadOS devices outside standalone mode (which don't support `beforeinstallprompt`)
 *   so the UI can offer a clear 2-step "Add to Home Screen" guide.
 * - Tracks standalone installation (`display-mode: standalone`, `navigator.standalone`, `appinstalled`)
 *   and respects user banner dismissal with a 14-day cooldown in `localStorage`.
 */

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export interface PwaInstallState {
  isInstalled: boolean;
  canPromptNative: boolean;
  isIosManualInstall: boolean;
  bannerDismissed: boolean;
  showBanner: boolean;
  canInstallFromSettings: boolean;
}

export type InstallPromptOutcome = 'accepted' | 'dismissed' | 'unavailable';

const DISMISS_STORAGE_KEY = 'storytape_install_dismissed_at';
export const INSTALL_DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
}

interface WindowLike {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: NavigatorLike;
}

export function detectStandaloneMode(win?: WindowLike): boolean {
  const target: WindowLike | undefined =
    win ?? (typeof window !== 'undefined' ? (window as unknown as WindowLike) : undefined);
  if (!target) return false;

  if (target.navigator?.standalone === true) {
    return true;
  }

  if (typeof target.matchMedia === 'function') {
    try {
      if (
        target.matchMedia('(display-mode: standalone)').matches ||
        target.matchMedia('(display-mode: window-controls-overlay)').matches
      ) {
        return true;
      }
    } catch {
      // Ignore unsupported media query
    }
  }

  return false;
}

export function detectIosDevice(nav?: NavigatorLike): boolean {
  const target: NavigatorLike | undefined =
    nav ?? (typeof navigator !== 'undefined' ? (navigator as unknown as NavigatorLike) : undefined);
  if (!target) return false;

  const ua = target.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(ua)) {
    return true;
  }

  // iPadOS 13+ reports Macintosh / MacIntel in desktop mode with multi-touch support
  const platform = target.platform || '';
  const maxTouch = target.maxTouchPoints ?? 0;
  if ((platform === 'MacIntel' || /Macintosh/i.test(ua)) && maxTouch > 1) {
    return true;
  }

  return false;
}

export function isInstallBannerDismissed(
  storage?: Pick<Storage, 'getItem'> | null,
  now = Date.now(),
): boolean {
  const store =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  if (!store) return false;

  try {
    const raw = store.getItem(DISMISS_STORAGE_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    return now - ts < INSTALL_DISMISS_COOLDOWN_MS;
  } catch {
    return false;
  }
}

export function persistInstallBannerDismissal(
  storage?: Pick<Storage, 'setItem'> | null,
  now = Date.now(),
): void {
  const store =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  if (!store) return;

  try {
    store.setItem(DISMISS_STORAGE_KEY, String(now));
  } catch {
    // Ignore storage quota / private mode restrictions
  }
}

type StateListener = (state: PwaInstallState) => void;

class PwaInstallController {
  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private isInstalled = false;
  private isIosDevice = false;
  private bannerDismissed = false;
  private listeners = new Set<StateListener>();
  private initialized = false;

  constructor() {
    this.init();
  }

  init(): void {
    if (this.initialized || typeof window === 'undefined') return;
    this.initialized = true;

    this.isInstalled = detectStandaloneMode();
    this.isIosDevice = detectIosDevice();
    this.bannerDismissed = isInstallBannerDismissed();

    window.addEventListener('beforeinstallprompt', this.handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', this.handleAppInstalled);

    if (typeof window.matchMedia === 'function') {
      try {
        const mql = window.matchMedia('(display-mode: standalone)');
        const onChange = (ev: MediaQueryListEvent) => {
          if (ev.matches) {
            this.isInstalled = true;
            this.deferredPrompt = null;
            this.emit();
          }
        };
        if (typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', onChange);
        }
      } catch {
        // Ignore
      }
    }
  }

  private handleBeforeInstallPrompt = (event: Event): void => {
    const bip = event as BeforeInstallPromptEvent;
    if (typeof bip.prompt !== 'function') return;

    event.preventDefault();
    this.deferredPrompt = bip;
    // Refresh dismissal state from storage in case it changed or expired
    this.bannerDismissed = isInstallBannerDismissed();
    this.emit();
  };

  private handleAppInstalled = (): void => {
    this.isInstalled = true;
    this.deferredPrompt = null;
    this.emit();
  };

  getState(): PwaInstallState {
    const canPromptNative = !this.isInstalled && this.deferredPrompt !== null;
    const isIosManualInstall =
      !this.isInstalled && !canPromptNative && this.isIosDevice;
    const canInstallFromSettings = canPromptNative || isIosManualInstall;
    const showBanner = canInstallFromSettings && !this.bannerDismissed;

    return {
      isInstalled: this.isInstalled,
      canPromptNative,
      isIosManualInstall,
      bannerDismissed: this.bannerDismissed,
      showBanner,
      canInstallFromSettings,
    };
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dismissBanner(): void {
    this.bannerDismissed = true;
    persistInstallBannerDismissal();
    this.emit();
  }

  /**
   * Triggers Chromium's native PWA install dialog.
   * Must be invoked directly from a user tap/click handler so browsers preserve gesture activation.
   */
  triggerNativeInstall(): Promise<InstallPromptOutcome> {
    const promptEvent = this.deferredPrompt;
    if (!promptEvent || this.isInstalled) {
      return Promise.resolve('unavailable');
    }

    // Clear reference immediately — BeforeInstallPromptEvent can only be prompted once.
    this.deferredPrompt = null;

    let promptPromise: Promise<void>;
    try {
      promptPromise = Promise.resolve(promptEvent.prompt());
    } catch {
      this.emit();
      return Promise.resolve('unavailable');
    }

    return promptPromise
      .then(() => promptEvent.userChoice)
      .then((choice) => {
        if (choice.outcome === 'accepted') {
          this.isInstalled = true;
          this.emit();
          return 'accepted' as const;
        }
        this.emit();
        return 'dismissed' as const;
      })
      .catch(() => {
        this.emit();
        return 'unavailable' as const;
      });
  }

  /** Test helper to re-evaluate environment & reset internal state cleanly. */
  resetForTests(): void {
    this.deferredPrompt = null;
    this.isInstalled = detectStandaloneMode();
    this.isIosDevice = detectIosDevice();
    this.bannerDismissed = isInstallBannerDismissed();
    this.emit();
  }

  private emit(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }
}

export const pwaInstallController = new PwaInstallController();
