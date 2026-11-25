import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppHistoryController,
  parseHashRoute,
  routesEqual,
  serializeRoute,
} from '../appHistory';

/** Flush jsdom's async history.go/back/forward popstate queue. */
async function flushHistoryQueue(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 15);
  });
}

describe('AppHistoryController (ADR-12)', () => {
  let controller: AppHistoryController | null = null;

  beforeEach(() => {
    window.history.replaceState(null, '', '/pwa_recorder/#/');
  });

  afterEach(() => {
    controller?.dispose();
    controller = null;
  });

  it('round-trips all StoryTape hash routes cleanly', () => {
    const samples = [
      { view: 'library' as const },
      { view: 'book' as const, projectId: 'book-42' },
      { view: 'record' as const, projectId: 'book-42' },
      { view: 'record' as const, projectId: 'book-42', draftId: 'draft-9' },
      { view: 'compare' as const, projectId: 'book-42', recordingId: 'rec-7' },
      { view: 'mic-compare' as const },
    ];
    for (const r of samples) {
      const hash = serializeRoute(r);
      expect(routesEqual(parseHashRoute(hash), r)).toBe(true);
    }
  });

  it('supports full browser Back and Forward traversal across screens without duplicating history', async () => {
    controller = new AppHistoryController();
    expect(controller.getSnapshot().route).toEqual({ view: 'library' });
    expect(controller.getSnapshot().index).toBe(0);

    controller.navigate({ view: 'book', projectId: 'b1' });
    expect(controller.getSnapshot().index).toBe(1);
    expect(window.location.hash).toBe('#/book/b1');

    controller.navigate({ view: 'record', projectId: 'b1' });
    expect(controller.getSnapshot().index).toBe(2);
    expect(window.location.hash).toBe('#/record/b1');

    // Browser Back: Record -> Book
    window.history.back();
    await flushHistoryQueue();
    expect(controller.getSnapshot().route).toEqual({ view: 'book', projectId: 'b1' });
    expect(controller.getSnapshot().index).toBe(1);

    // Browser Back: Book -> Library
    window.history.back();
    await flushHistoryQueue();
    expect(controller.getSnapshot().route).toEqual({ view: 'library' });
    expect(controller.getSnapshot().index).toBe(0);

    // Browser Forward: Library -> Book -> Record
    window.history.forward();
    await flushHistoryQueue();
    expect(controller.getSnapshot().route).toEqual({ view: 'book', projectId: 'b1' });

    window.history.forward();
    await flushHistoryQueue();
    expect(controller.getSnapshot().route).toEqual({ view: 'record', projectId: 'b1' });
  });

  it('pushes and pops nested overlays (Settings -> Theme Switcher) cleanly on Back and Forward', async () => {
    controller = new AppHistoryController();

    controller.openOverlay({ kind: 'settings', tab: 'recording' });
    expect(controller.getSnapshot().overlays).toEqual([
      { kind: 'settings', tab: 'recording' },
    ]);

    // Switching tabs updates in place without pushing an extra Back stop
    controller.updateOverlayInPlace({ kind: 'settings', tab: 'app' });
    expect(controller.getSnapshot().index).toBe(1);
    expect(controller.getSnapshot().overlays).toEqual([
      { kind: 'settings', tab: 'app' },
    ]);

    // Stack Theme Switcher on top of Settings
    controller.openOverlay({ kind: 'theme' });
    expect(controller.getSnapshot().index).toBe(2);
    expect(controller.getSnapshot().overlays).toEqual([
      { kind: 'settings', tab: 'app' },
      { kind: 'theme' },
    ]);

    // Swipe Back once -> closes Theme Switcher, keeps Settings open on App tab
    window.history.back();
    await flushHistoryQueue();
    expect(controller.getSnapshot().overlays).toEqual([
      { kind: 'settings', tab: 'app' },
    ]);

    // Swipe Back again -> closes Settings back to Library
    window.history.back();
    await flushHistoryQueue();
    expect(controller.getSnapshot().overlays).toEqual([]);
    expect(controller.getSnapshot().route).toEqual({ view: 'library' });

    // Swipe Forward twice -> restores Settings (App tab) then Theme Switcher
    window.history.forward();
    await flushHistoryQueue();
    expect(controller.getSnapshot().overlays).toEqual([
      { kind: 'settings', tab: 'app' },
    ]);

    window.history.forward();
    await flushHistoryQueue();
    expect(controller.getSnapshot().overlays).toEqual([
      { kind: 'settings', tab: 'app' },
      { kind: 'theme' },
    ]);
  });

  it('serializes rapid closeOverlay() followed immediately by openOverlay() without async popstate clobbering', async () => {
    controller = new AppHistoryController();

    controller.openOverlay({ kind: 'settings', tab: 'recording' });
    expect(controller.getSnapshot().index).toBe(1);

    // Close Settings and IMMEDIATELY open BookEditor before browser popstate fires
    controller.closeOverlay('settings');
    expect(controller.getSnapshot().overlays).toEqual([]);

    controller.openOverlay({ kind: 'book-editor', projectId: null });
    expect(controller.getSnapshot().overlays).toEqual([
      { kind: 'book-editor', projectId: null },
    ]);

    // After async browser history settles, BookEditor MUST remain open (not clobbered!)
    await flushHistoryQueue();
    expect(controller.getSnapshot().overlays).toEqual([
      { kind: 'book-editor', projectId: null },
    ]);
    expect(controller.getSnapshot().index).toBe(1);

    // Swiping Back now cleanly returns to Library (index 0)
    window.history.back();
    await flushHistoryQueue();
    expect(controller.getSnapshot().overlays).toEqual([]);
    expect(controller.getSnapshot().index).toBe(0);
  });

  it('dismisses transient dialogs on Back and never resurrects them on Forward', async () => {
    controller = new AppHistoryController();
    const onDismiss = vi.fn();

    controller.pushTransient('confirm', onDismiss);
    expect(controller.getSnapshot().index).toBe(1);
    expect(controller.getSnapshot().transientId).toBeTruthy();

    // Swipe Back -> invokes onDismiss and clears transientId
    window.history.back();
    await flushHistoryQueue();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().transientId).toBeUndefined();
    expect(controller.getSnapshot().index).toBe(0);

    // Swipe Forward -> dead transientId is stripped, dialog never resurrects
    window.history.forward();
    await flushHistoryQueue();
    expect(controller.getSnapshot().transientId).toBeUndefined();
    expect(controller.getSnapshot().route).toEqual({ view: 'library' });
  });

  it('unwinds cleanly after recording save from Book -> Record -> SaveSheet AND from Library -> Draft -> SaveSheet', async () => {
    // Path A: Library (0) -> Book (1) -> Record (2) -> SaveSheet (3)
    controller = new AppHistoryController();
    controller.navigate({ view: 'book', projectId: 'b1' });
    controller.navigate({ view: 'record', projectId: 'b1' });
    controller.pushTransient('studio-save', () => {});
    expect(controller.getSnapshot().index).toBe(3);

    controller.unwindToRoute(
      { view: 'book', projectId: 'b1' },
      { unwindFromViews: ['record'] },
    );
    await flushHistoryQueue();
    expect(controller.getSnapshot().index).toBe(1);
    expect(controller.getSnapshot().route).toEqual({ view: 'book', projectId: 'b1' });

    // Single swipe back from Book goes straight to Library (never back to Studio!)
    window.history.back();
    await flushHistoryQueue();
    expect(controller.getSnapshot().route).toEqual({ view: 'library' });
    expect(controller.getSnapshot().index).toBe(0);

    // Path B: Library (0) -> Resume Draft Record (1) -> SaveSheet (2)
    controller.navigate({ view: 'record', projectId: 'b1', draftId: 'd1' });
    controller.pushTransient('studio-save', () => {});
    expect(controller.getSnapshot().index).toBe(2);

    controller.unwindToRoute(
      { view: 'book', projectId: 'b1' },
      { unwindFromViews: ['record'] },
    );
    await flushHistoryQueue();
    expect(controller.getSnapshot().index).toBe(1);
    expect(controller.getSnapshot().route).toEqual({ view: 'book', projectId: 'b1' });
    expect(window.location.hash).toBe('#/book/b1');

    // Single swipe back from Book goes straight to Library
    window.history.back();
    await flushHistoryQueue();
    expect(controller.getSnapshot().route).toEqual({ view: 'library' });
    expect(controller.getSnapshot().index).toBe(0);
  });

  it('intercepts Back with registered BackGuard, restores history pointer, and allows subsequent exit', async () => {
    controller = new AppHistoryController();
    controller.navigate({ view: 'book', projectId: 'b1' });
    controller.navigate({ view: 'record', projectId: 'b1' });

    let blocked = true;
    const onBlocked = vi.fn();
    controller.registerBackGuard({
      shouldBlock: (cur, target) =>
        blocked && cur.route.view === 'record' && !routesEqual(cur.route, target.route),
      onBlocked,
    });

    // Swipe Back while guard active -> stays on Record and triggers onBlocked
    window.history.back();
    await flushHistoryQueue();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().route).toEqual({ view: 'record', projectId: 'b1' });
    expect(controller.getSnapshot().index).toBe(2);

    // Disable guard and exit intentionally -> cleanly lands on Book (index 1)
    blocked = false;
    controller.goBackOrReplace({ view: 'book', projectId: 'b1' });
    await flushHistoryQueue();
    expect(controller.getSnapshot().route).toEqual({ view: 'book', projectId: 'b1' });
    expect(controller.getSnapshot().index).toBe(1);
  });

  it('replaces safely instead of exiting when goBackOrReplace is called from deep-linked root (index 0)', async () => {
    window.history.replaceState(null, '', '/pwa_recorder/#/book/deep-1');
    controller = new AppHistoryController();
    expect(controller.getSnapshot().route).toEqual({
      view: 'book',
      projectId: 'deep-1',
    });
    expect(controller.getSnapshot().index).toBe(0);

    controller.goBackOrReplace({ view: 'library' });
    await flushHistoryQueue();
    expect(controller.getSnapshot().route).toEqual({ view: 'library' });
    expect(controller.getSnapshot().index).toBe(0);
    expect(window.location.hash).toBe('#/');
  });

  it('replaces #/join hash on clearJoinHash so Back does not reopen a dismissed invite', async () => {
    window.history.replaceState(
      null,
      '',
      '/pwa_recorder/#/join?folderId=folder-1&name=Family&scope=library&role=writer',
    );
    controller = new AppHistoryController();
    expect(controller.getSnapshot().pendingJoinInvite?.folderId).toBe('folder-1');

    controller.setPendingJoinInvite(null);
    controller.clearJoinHash();
    await flushHistoryQueue();
    expect(window.location.hash).toBe('#/');
    expect(controller.getSnapshot().index).toBe(0);
  });

  it('pushes and dismisses the import-audio overlay via browser history cleanly', async () => {
    controller = new AppHistoryController();
    controller.navigate({ view: 'book', projectId: 'book-42' });
    controller.openOverlay({ kind: 'import-audio', projectId: 'book-42' });
    await flushHistoryQueue();

    expect(controller.getSnapshot().overlays).toEqual([
      { kind: 'import-audio', projectId: 'book-42' },
    ]);

    controller.closeOverlay('import-audio');
    await flushHistoryQueue();
    expect(controller.getSnapshot().overlays).toEqual([]);
    expect(controller.getSnapshot().route).toEqual({
      view: 'book',
      projectId: 'book-42',
    });
  });
});
