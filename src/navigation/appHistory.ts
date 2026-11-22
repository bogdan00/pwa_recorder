import {
  type JoinShareInvite,
  parseJoinInviteInput,
} from '../drive/shareUtils';

export type SettingsTab = 'recording' | 'drive' | 'app' | 'debug';

export type Route =
  | { view: 'library' }
  | { view: 'book'; projectId: string }
  | { view: 'compare'; projectId: string; recordingId: string }
  | { view: 'mic-compare' }
  | { view: 'record'; projectId: string; draftId?: string | null };

export type NavigationOverlay =
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'theme' }
  | { kind: 'book-editor'; projectId: string | null }
  | { kind: 'share'; scope: 'library' }
  | { kind: 'share'; scope: 'book'; projectId: string }
  | { kind: 'ios-install' }
  | { kind: 'player' }
  | { kind: 'player-drawer'; drawer: 'chapters' | 'sleep' };

export type NavigationOverlayKind = NavigationOverlay['kind'];

export interface StoryTapeHistoryState {
  __storytape: true;
  sessionId: string;
  index: number;
  route: Route;
  overlays: NavigationOverlay[];
  transientId?: string;
}

export interface NavigationSnapshot {
  index: number;
  route: Route;
  overlays: NavigationOverlay[];
  transientId?: string;
  pendingJoinInvite: JoinShareInvite | null;
}

export interface BackGuard {
  /**
   * Return true to block a browser/gesture back navigation leaving the current entry.
   * The controller restores the browser history pointer and invokes `onBlocked()`.
   */
  shouldBlock: (
    current: NavigationSnapshot,
    target: NavigationSnapshot,
  ) => boolean;
  onBlocked: () => void;
}

type BrowserOp =
  | { op: 'push'; state: StoryTapeHistoryState; url: string }
  | { op: 'replace'; state: StoryTapeHistoryState; url: string }
  | {
      op: 'go';
      delta: number;
      targetIndex: number;
      syncFromPopstate?: boolean;
    };

export function parseHashRoute(rawHash?: string): Route {
  const source =
    rawHash !== undefined
      ? rawHash
      : typeof window !== 'undefined'
        ? window.location.hash
        : '';
  const hash = source.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);

  if (parts[0] === 'quality-lab' && parts[1] === 'mic-test') {
    return { view: 'mic-compare' };
  }
  if (parts[0] === 'book' && parts[1] && parts[2] === 'compare' && parts[3]) {
    return {
      view: 'compare',
      projectId: decodeURIComponent(parts[1]),
      recordingId: decodeURIComponent(parts[3]),
    };
  }
  if (parts[0] === 'book' && parts[1]) {
    return { view: 'book', projectId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'record' && parts[1]) {
    const params = new URLSearchParams(queryPart || '');
    return {
      view: 'record',
      projectId: decodeURIComponent(parts[1]),
      draftId: params.get('draft') ?? undefined,
    };
  }
  return { view: 'library' };
}

export function parseJoinInviteFromHash(rawHash?: string): JoinShareInvite | null {
  const source =
    rawHash !== undefined
      ? rawHash
      : typeof window !== 'undefined'
        ? window.location.hash
        : '';
  if (!source.includes('/join')) return null;
  return parseJoinInviteInput(source);
}

export function serializeRoute(route: Route): string {
  if (route.view === 'mic-compare') return '#/quality-lab/mic-test';
  if (route.view === 'compare') {
    return `#/book/${encodeURIComponent(route.projectId)}/compare/${encodeURIComponent(route.recordingId)}`;
  }
  if (route.view === 'book') {
    return `#/book/${encodeURIComponent(route.projectId)}`;
  }
  if (route.view === 'record') {
    const base = `#/record/${encodeURIComponent(route.projectId)}`;
    return route.draftId
      ? `${base}?draft=${encodeURIComponent(route.draftId)}`
      : base;
  }
  return '#/';
}

export function routesEqual(a: Route, b: Route): boolean {
  if (a.view !== b.view) return false;
  if (a.view === 'book' && b.view === 'book') {
    return a.projectId === b.projectId;
  }
  if (a.view === 'compare' && b.view === 'compare') {
    return a.projectId === b.projectId && a.recordingId === b.recordingId;
  }
  if (a.view === 'record' && b.view === 'record') {
    return a.projectId === b.projectId && (a.draftId ?? null) === (b.draftId ?? null);
  }
  return true;
}

export function overlaysEqual(
  a: readonly NavigationOverlay[],
  b: readonly NavigationOverlay[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.kind !== y.kind) return false;
    if (x.kind === 'settings' && y.kind === 'settings' && x.tab !== y.tab) {
      return false;
    }
    if (
      x.kind === 'book-editor' &&
      y.kind === 'book-editor' &&
      x.projectId !== y.projectId
    ) {
      return false;
    }
    if (x.kind === 'share' && y.kind === 'share') {
      if (x.scope !== y.scope) return false;
      if (
        x.scope === 'book' &&
        y.scope === 'book' &&
        x.projectId !== y.projectId
      ) {
        return false;
      }
    }
    if (
      x.kind === 'player-drawer' &&
      y.kind === 'player-drawer' &&
      x.drawer !== y.drawer
    ) {
      return false;
    }
  }
  return true;
}

function isStoryTapeHistoryState(value: unknown): value is StoryTapeHistoryState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoryTapeHistoryState>;
  return (
    candidate.__storytape === true &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.index === 'number' &&
    Number.isFinite(candidate.index) &&
    candidate.index >= 0 &&
    Boolean(candidate.route && typeof candidate.route === 'object') &&
    Array.isArray(candidate.overlays)
  );
}

function buildHashUrl(hash: string): string {
  if (typeof window === 'undefined') return hash;
  const normalizedHash = hash.startsWith('#') ? hash : `#${hash}`;
  return `${window.location.pathname}${window.location.search}${normalizedHash}`;
}

function cloneOverlays(overlays: readonly NavigationOverlay[]): NavigationOverlay[] {
  return overlays.map((item) => ({ ...item }));
}

let sessionCounter = 0;
let transientCounter = 0;

/**
 * Unified browser-history navigation controller (ADR-12).
 *
 * Manages both primary hash routes and stacked UI overlays/modals through the
 * Web History API (`pushState`, `replaceState`, `go`, `popstate`) so mobile
 * edge-swipe Back/Forward gestures traverse screens and dismiss sheets instead
 * of closing the standalone PWA.
 */
export class AppHistoryController {
  private readonly sessionId: string;
  private readonly entries = new Map<number, StoryTapeHistoryState>();
  private readonly listeners = new Set<() => void>();
  private readonly guards = new Set<BackGuard>();
  private readonly transients = new Map<string, () => void>();

  private currentIndex = 0;
  private browserIndex = 0;
  private pendingJoinInvite: JoinShareInvite | null = null;
  private snapshotCache: NavigationSnapshot;

  private inFlightGo: {
    targetIndex: number;
    syncFromPopstate: boolean;
  } | null = null;
  private pendingOps: BrowserOp[] = [];
  private attached = false;

  constructor() {
    sessionCounter += 1;
    this.sessionId = `st-${Date.now().toString(36)}-${sessionCounter}`;

    const initialHash =
      typeof window !== 'undefined' ? window.location.hash : '';
    const initialRoute = parseHashRoute(initialHash);
    this.pendingJoinInvite = parseJoinInviteFromHash(initialHash);

    let initialIndex = 0;
    if (typeof window !== 'undefined') {
      const existing = window.history.state;
      if (
        isStoryTapeHistoryState(existing) &&
        routesEqual(existing.route, initialRoute)
      ) {
        initialIndex = existing.index;
      }
    }

    const initialState: StoryTapeHistoryState = {
      __storytape: true,
      sessionId: this.sessionId,
      index: initialIndex,
      route: initialRoute,
      overlays: [],
    };

    this.currentIndex = initialIndex;
    this.browserIndex = initialIndex;
    this.entries.set(initialIndex, initialState);
    this.snapshotCache = this.buildSnapshot(initialState);

    if (typeof window !== 'undefined') {
      const keepHash =
        this.pendingJoinInvite !== null || initialHash.length > 0
          ? initialHash
          : serializeRoute(initialRoute);
      try {
        window.history.replaceState(initialState, '', buildHashUrl(keepHash));
      } catch {
        // Non-fatal in constrained environments
      }
      this.attach();
    }
  }

  attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    this.attached = true;
    window.addEventListener('popstate', this.handlePopState);
    window.addEventListener('hashchange', this.handleHashChange);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener('popstate', this.handlePopState);
      window.removeEventListener('hashchange', this.handleHashChange);
    }
    this.pendingOps = [];
    this.inFlightGo = null;
  }

  dispose(): void {
    this.detach();
    this.listeners.clear();
    this.guards.clear();
    this.transients.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): NavigationSnapshot => {
    return this.snapshotCache;
  };

  registerBackGuard(guard: BackGuard): () => void {
    this.guards.add(guard);
    return () => {
      this.guards.delete(guard);
    };
  }

  setPendingJoinInvite(invite: JoinShareInvite | null): void {
    if (this.pendingJoinInvite === invite) return;
    this.pendingJoinInvite = invite;
    this.updateSnapshotAndEmit();
  }

  clearJoinHash(): void {
    if (typeof window === 'undefined') return;
    if (!window.location.hash.includes('/join')) return;
    const current = this.getCurrentState();
    const cleaned: StoryTapeHistoryState = {
      ...current,
      route: { view: 'library' },
    };
    this.entries.set(this.currentIndex, cleaned);
    this.enqueueBrowserOp({
      op: 'replace',
      state: cleaned,
      url: buildHashUrl('#/'),
    });
    this.updateSnapshotAndEmit();
  }

  /**
   * Push a new primary route (clearing any open overlays on the new screen).
   */
  navigate(nextRoute: Route, overlays: NavigationOverlay[] = []): void {
    const current = this.getCurrentState();
    const nextOverlays = cloneOverlays(overlays);
    if (
      routesEqual(current.route, nextRoute) &&
      overlaysEqual(current.overlays, nextOverlays) &&
      !current.transientId
    ) {
      return;
    }
    this.pushStateEntry(nextRoute, nextOverlays);
  }

  /**
   * Replace the current history entry with a new route and overlay stack.
   */
  replace(nextRoute: Route, overlays: NavigationOverlay[] = []): void {
    const current = this.getCurrentState();
    const nextState: StoryTapeHistoryState = {
      __storytape: true,
      sessionId: this.sessionId,
      index: this.currentIndex,
      route: nextRoute,
      overlays: cloneOverlays(overlays),
    };
    if (current.transientId) {
      this.transients.delete(current.transientId);
    }
    this.entries.set(this.currentIndex, nextState);
    this.enqueueBrowserOp({
      op: 'replace',
      state: nextState,
      url: buildHashUrl(serializeRoute(nextRoute)),
    });
    this.updateSnapshotAndEmit();
  }

  /**
   * Push an overlay sheet onto the current route's overlay stack.
   * If an overlay of the same kind is already on top, updates it in place via replaceState.
   */
  openOverlay(overlay: NavigationOverlay): void {
    const current = this.getCurrentState();
    const top = current.overlays[current.overlays.length - 1];
    if (top && top.kind === overlay.kind && !current.transientId) {
      if (overlaysEqual([top], [overlay])) return;
      const replacedOverlays = [
        ...cloneOverlays(current.overlays.slice(0, -1)),
        { ...overlay },
      ];
      this.replace(current.route, replacedOverlays);
      return;
    }

    // Avoid duplicating the same overlay kind deeper in the stack
    const withoutSameKind = current.overlays.filter(
      (o) => o.kind !== overlay.kind,
    );
    this.pushStateEntry(current.route, [
      ...cloneOverlays(withoutSameKind),
      { ...overlay },
    ]);
  }

  /**
   * Update an existing overlay in place (e.g., switching tabs inside SettingsSheet)
   * without creating an extra Back history entry.
   */
  updateOverlayInPlace(overlay: NavigationOverlay): void {
    const current = this.getCurrentState();
    const idx = current.overlays.findIndex((o) => o.kind === overlay.kind);
    if (idx < 0) return;
    const nextOverlays = cloneOverlays(current.overlays);
    nextOverlays[idx] = { ...overlay };
    if (overlaysEqual(current.overlays, nextOverlays)) return;
    const nextState: StoryTapeHistoryState = {
      ...current,
      overlays: nextOverlays,
    };
    this.entries.set(this.currentIndex, nextState);
    this.enqueueBrowserOp({
      op: 'replace',
      state: nextState,
      url: buildHashUrl(serializeRoute(current.route)),
    });
    this.updateSnapshotAndEmit();
  }

  /**
   * Replace the current route's overlay stack (e.g., Settings -> Share Library or iOS Guide)
   * in place so closing the replacement returns cleanly to the underlying route.
   */
  replaceOverlays(overlays: NavigationOverlay[]): void {
    const current = this.getCurrentState();
    this.replace(current.route, overlays);
  }

  /**
   * Close an overlay (and any overlays stacked above it, such as player-drawer above player).
   * Pops browser history cleanly when the preceding entry matches the target overlay stack.
   */
  closeOverlay(kind: NavigationOverlayKind): void {
    const current = this.getCurrentState();
    const targetIdx = current.overlays.findIndex((o) => o.kind === kind);
    if (targetIdx < 0) return;

    const desiredOverlays = cloneOverlays(current.overlays.slice(0, targetIdx));
    const backIdx = this.findNearestBackIndex(
      (entry) =>
        routesEqual(entry.route, current.route) &&
        overlaysEqual(entry.overlays, desiredOverlays) &&
        !entry.transientId,
    );

    if (backIdx !== null) {
      this.goToIndex(backIdx);
      return;
    }

    // Fallback (e.g., after reload or non-linear stack): replace cleanly
    this.replace(current.route, desiredOverlays);
  }

  /**
   * Push an ephemeral dialog layer (e.g. ConfirmDialog or SaveRecordingSheet).
   * Swiping Back invokes `onDismiss` cleanly; swiping Forward after dismissal
   * never resurrects the stale dialog.
   */
  pushTransient(tag: string, onDismiss: () => void): string {
    transientCounter += 1;
    const id = `${tag}-${transientCounter}`;
    this.transients.set(id, onDismiss);
    const current = this.getCurrentState();
    this.pushStateEntry(current.route, cloneOverlays(current.overlays), id);
    return id;
  }

  /**
   * Programmatically dismiss an active ephemeral dialog layer (e.g. Cancel/Confirm tap).
   * Safely no-ops if already dismissed by swipe-back or a route unwind.
   */
  dismissTransient(transientId: string): void {
    this.transients.delete(transientId);
    const current = this.getCurrentState();
    if (current.transientId !== transientId) {
      return;
    }
    if (this.currentIndex > 0) {
      this.goToIndex(this.currentIndex - 1);
    } else {
      this.replace(current.route, cloneOverlays(current.overlays));
    }
  }

  /**
   * Go back 1 step in browser history when a prior StoryTape entry exists (`index > 0`),
   * or safely replace with `fallbackRoute` when deep-linked at root (`index === 0`).
   */
  goBackOrReplace(fallbackRoute: Route): void {
    if (this.currentIndex > 0) {
      this.goToIndex(this.currentIndex - 1, fallbackRoute);
      return;
    }
    this.replace(fallbackRoute, []);
  }

  /**
   * Unwind back to the nearest prior entry matching `targetRoute` with no open overlays
   * (e.g., returning to Book Detail after saving a recording or Library after deleting a book).
   * If no matching prior entry exists:
   * - If `keepParentOnReplace` is true and we are above index 0 with a transient/overlay stacked
   *   above the route (e.g. `Library -> Record -> SaveSheet`), unwinds to the route slot and
   *   replaces it with `targetRoute` so Back from `targetRoute` still reaches `Library`.
   * - Otherwise replaces the current entry with `targetRoute`.
   */
  unwindToRoute(
    targetRoute: Route,
    options?: { unwindFromViews?: Route['view'][] },
  ): void {
    const backIdx = this.findNearestBackIndex(
      (entry) =>
        routesEqual(entry.route, targetRoute) &&
        entry.overlays.length === 0 &&
        !entry.transientId,
    );

    if (backIdx !== null) {
      this.goToIndex(backIdx);
      return;
    }

    // Walk back past transient dialogs and any specified ephemeral views (e.g. 'record')
    // to find the lowest index we should replace with `targetRoute`.
    const unwindViews = options?.unwindFromViews ?? [];
    let replaceIndex = this.currentIndex;
    while (replaceIndex > 0) {
      const prev = this.entries.get(replaceIndex - 1);
      if (!prev) break;
      const cur = this.entries.get(replaceIndex);
      const isSameTransientOrOverlay =
        Boolean(cur?.transientId) ||
        (cur !== undefined &&
          cur.overlays.length > 0 &&
          routesEqual(prev.route, cur.route));
      const isUnwindView = unwindViews.includes(prev.route.view);
      if (isSameTransientOrOverlay || isUnwindView) {
        replaceIndex -= 1;
      } else {
        break;
      }
    }

    if (replaceIndex < this.currentIndex) {
      const delta = replaceIndex - this.currentIndex;
      const nextState: StoryTapeHistoryState = {
        __storytape: true,
        sessionId: this.sessionId,
        index: replaceIndex,
        route: targetRoute,
        overlays: [],
      };
      this.clearTransientsAbove(replaceIndex - 1);
      this.pruneEntriesAbove(replaceIndex);
      this.currentIndex = replaceIndex;
      this.entries.set(replaceIndex, nextState);
      this.enqueueBrowserOp({
        op: 'go',
        delta,
        targetIndex: replaceIndex,
      });
      this.enqueueBrowserOp({
        op: 'replace',
        state: nextState,
        url: buildHashUrl(serializeRoute(targetRoute)),
      });
      this.updateSnapshotAndEmit();
      return;
    }

    this.replace(targetRoute, []);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private getCurrentState(): StoryTapeHistoryState {
    const existing = this.entries.get(this.currentIndex);
    if (existing) return existing;
    return {
      __storytape: true,
      sessionId: this.sessionId,
      index: this.currentIndex,
      route: this.snapshotCache.route,
      overlays: cloneOverlays(this.snapshotCache.overlays),
      transientId: this.snapshotCache.transientId,
    };
  }

  private buildSnapshot(state: StoryTapeHistoryState): NavigationSnapshot {
    return {
      index: state.index,
      route: state.route,
      overlays: cloneOverlays(state.overlays),
      transientId: state.transientId,
      pendingJoinInvite: this.pendingJoinInvite,
    };
  }

  private updateSnapshotAndEmit(): void {
    const current = this.getCurrentState();
    this.snapshotCache = this.buildSnapshot(current);
    this.listeners.forEach((fn) => fn());
  }

  private pushStateEntry(
    route: Route,
    overlays: NavigationOverlay[],
    transientId?: string,
  ): void {
    const nextIndex = this.currentIndex + 1;
    this.pruneEntriesAbove(this.currentIndex);
    const nextState: StoryTapeHistoryState = {
      __storytape: true,
      sessionId: this.sessionId,
      index: nextIndex,
      route,
      overlays,
      ...(transientId ? { transientId } : {}),
    };
    this.currentIndex = nextIndex;
    this.entries.set(nextIndex, nextState);
    this.enqueueBrowserOp({
      op: 'push',
      state: nextState,
      url: buildHashUrl(serializeRoute(route)),
    });
    this.updateSnapshotAndEmit();
  }

  private goToIndex(targetIndex: number, fallbackRoute?: Route): void {
    const clampedTarget = Math.max(0, targetIndex);
    const delta = clampedTarget - this.currentIndex;
    if (delta === 0) return;

    this.clearTransientsAbove(clampedTarget);

    const knownTarget = this.entries.get(clampedTarget);
    this.currentIndex = clampedTarget;

    if (knownTarget) {
      this.enqueueBrowserOp({
        op: 'go',
        delta,
        targetIndex: clampedTarget,
        syncFromPopstate: false,
      });
      this.updateSnapshotAndEmit();
    } else {
      // Pre-reload browser entry not yet in our in-memory mirror:
      // optimistically render fallbackRoute and sync when popstate delivers the real entry.
      const optimistic: StoryTapeHistoryState = {
        __storytape: true,
        sessionId: this.sessionId,
        index: clampedTarget,
        route: fallbackRoute ?? { view: 'library' },
        overlays: [],
      };
      this.entries.set(clampedTarget, optimistic);
      this.enqueueBrowserOp({
        op: 'go',
        delta,
        targetIndex: clampedTarget,
        syncFromPopstate: true,
      });
      this.updateSnapshotAndEmit();
    }
  }

  private findNearestBackIndex(
    predicate: (entry: StoryTapeHistoryState) => boolean,
  ): number | null {
    for (let i = this.currentIndex - 1; i >= 0; i -= 1) {
      const entry = this.entries.get(i);
      if (entry && predicate(entry)) {
        return i;
      }
    }
    return null;
  }

  private pruneEntriesAbove(maxIndex: number): void {
    for (const key of Array.from(this.entries.keys())) {
      if (key > maxIndex) {
        const entry = this.entries.get(key);
        if (entry?.transientId) {
          this.transients.delete(entry.transientId);
        }
        this.entries.delete(key);
      }
    }
  }

  private clearTransientsAbove(maxIndex: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (key > maxIndex && entry.transientId) {
        this.transients.delete(entry.transientId);
      }
    }
  }

  private enqueueBrowserOp(op: BrowserOp): void {
    if (typeof window === 'undefined') return;
    this.pendingOps.push(op);
    this.flushBrowserOps();
  }

  private flushBrowserOps(): void {
    if (typeof window === 'undefined' || !this.attached) return;

    while (this.inFlightGo === null && this.pendingOps.length > 0) {
      const next = this.pendingOps.shift()!;
      if (next.op === 'push') {
        try {
          window.history.pushState(next.state, '', next.url);
          this.browserIndex = next.state.index;
        } catch {
          // Ignore constrained history errors
        }
      } else if (next.op === 'replace') {
        try {
          window.history.replaceState(next.state, '', next.url);
          this.browserIndex = next.state.index;
        } catch {
          // Ignore constrained history errors
        }
      } else if (next.op === 'go') {
        if (next.delta === 0) continue;
        this.inFlightGo = {
          targetIndex: next.targetIndex,
          syncFromPopstate: Boolean(next.syncFromPopstate),
        };
        try {
          window.history.go(next.delta);
        } catch {
          this.inFlightGo = null;
        }
        break;
      }
    }
  }

  private handlePopState = (event: PopStateEvent): void => {
    if (!this.attached) return;

    const rawState = event.state;

    // 1. Completing a programmatic `history.go(delta)` we initiated
    if (this.inFlightGo !== null) {
      const completed = this.inFlightGo;
      this.inFlightGo = null;

      if (isStoryTapeHistoryState(rawState)) {
        this.browserIndex = rawState.index;
        if (completed.syncFromPopstate && this.pendingOps.length === 0) {
          const synced: StoryTapeHistoryState = {
            __storytape: true,
            sessionId: this.sessionId,
            index: rawState.index,
            route: rawState.route,
            overlays: cloneOverlays(rawState.overlays),
          };
          this.currentIndex = synced.index;
          this.entries.set(synced.index, synced);
          this.updateSnapshotAndEmit();
        }
      } else {
        this.browserIndex = completed.targetIndex;
        if (completed.syncFromPopstate && this.pendingOps.length === 0) {
          const parsedRoute = parseHashRoute(window.location.hash);
          const synced: StoryTapeHistoryState = {
            __storytape: true,
            sessionId: this.sessionId,
            index: completed.targetIndex,
            route: parsedRoute,
            overlays: [],
          };
          this.currentIndex = synced.index;
          this.entries.set(synced.index, synced);
          this.updateSnapshotAndEmit();
        }
      }

      this.flushBrowserOps();
      return;
    }

    // 2. Genuine browser / phone-gesture Back or Forward navigation
    const invite = parseJoinInviteFromHash(window.location.hash);
    if (invite) {
      this.pendingJoinInvite = invite;
    }

    const prevState = this.getCurrentState();
    const prevSnapshot = this.snapshotCache;
    const prevBrowserIndex = this.browserIndex;

    let targetState: StoryTapeHistoryState;
    if (isStoryTapeHistoryState(rawState)) {
      const activeTransient =
        rawState.transientId && this.transients.has(rawState.transientId)
          ? rawState.transientId
          : undefined;
      targetState = {
        __storytape: true,
        sessionId: this.sessionId,
        index: rawState.index,
        route: rawState.route,
        overlays: cloneOverlays(rawState.overlays),
        ...(activeTransient ? { transientId: activeTransient } : {}),
      };
    } else {
      const parsedRoute = parseHashRoute(window.location.hash);
      targetState = {
        __storytape: true,
        sessionId: this.sessionId,
        index: Math.max(0, prevBrowserIndex - 1),
        route: parsedRoute,
        overlays: [],
      };
    }

    const targetSnapshot = this.buildSnapshot(targetState);

    // Check registered non-destructive back guards (e.g., unsaved Recording Studio audio)
    for (const guard of Array.from(this.guards)) {
      if (guard.shouldBlock(prevSnapshot, targetSnapshot)) {
        const restoreDelta = prevBrowserIndex - targetState.index;
        this.browserIndex = targetState.index;
        if (restoreDelta !== 0) {
          this.enqueueBrowserOp({
            op: 'go',
            delta: restoreDelta,
            targetIndex: prevState.index,
            syncFromPopstate: false,
          });
        } else {
          this.enqueueBrowserOp({
            op: 'push',
            state: prevState,
            url: buildHashUrl(serializeRoute(prevState.route)),
          });
        }
        guard.onBlocked();
        return;
      }
    }

    // Dismiss any active ephemeral dialog we just navigated away from
    if (
      prevState.transientId &&
      prevState.transientId !== targetState.transientId
    ) {
      const dismissFn = this.transients.get(prevState.transientId);
      this.transients.delete(prevState.transientId);
      dismissFn?.();
    }

    this.browserIndex = targetState.index;
    this.currentIndex = targetState.index;
    this.entries.set(targetState.index, targetState);
    this.updateSnapshotAndEmit();
  };

  private handleHashChange = (): void => {
    if (!this.attached) return;

    const invite = parseJoinInviteFromHash(window.location.hash);
    if (invite) {
      this.pendingJoinInvite = invite;
      this.updateSnapshotAndEmit();
    }

    // Ignore hashchange echoes while programmatic history ops are running
    if (this.inFlightGo !== null || this.pendingOps.length > 0) {
      return;
    }

    const parsedRoute = parseHashRoute(window.location.hash);
    const current = this.getCurrentState();
    if (routesEqual(parsedRoute, current.route)) {
      return;
    }

    // Manual hash edit in URL bar
    const nextIndex = this.currentIndex + 1;
    const nextState: StoryTapeHistoryState = {
      __storytape: true,
      sessionId: this.sessionId,
      index: nextIndex,
      route: parsedRoute,
      overlays: [],
    };
    this.currentIndex = nextIndex;
    this.browserIndex = nextIndex;
    this.entries.set(nextIndex, nextState);
    try {
      window.history.replaceState(
        nextState,
        '',
        buildHashUrl(window.location.hash || serializeRoute(parsedRoute)),
      );
    } catch {
      // Ignore constrained environments
    }
    this.updateSnapshotAndEmit();
  };
}
