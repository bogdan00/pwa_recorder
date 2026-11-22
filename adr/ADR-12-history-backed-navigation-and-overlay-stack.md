# ADR-12: Unified Browser History Navigation, Overlay Stack & Non-Destructive Back Guard

- **Status:** Accepted
- **Date:** 2026-11-21
- **Related CUJs:** [CUJ-01](../cuj/CUJ-01-book-management.md), [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-05](../cuj/CUJ-05-audiobook-player.md), [CUJ-06](../cuj/CUJ-06-library-browsing-themes.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-11](../cuj/CUJ-11-history-back-forward-navigation.md)

## Context
StoryTape is installed and used primarily as a standalone mobile PWA on Android Chrome and iOS Safari. Previously, StoryTape had four structural navigation issues:
1. **Unbacked overlays closed the PWA on swipe-back**: Full-screen and bottom-sheet surfaces (`AudioPlayerSheet`, `SettingsSheet`, `ThemeSwitcherSheet`, `BookEditorSheet`, `ShareSheet`, `IosInstallGuideModal`, `ConfirmDialog`, `SaveRecordingSheet`, and player sub-drawers) lived purely in React `useState`. Swiping back from Library while any sheet or the full-screen Audiobook Player was open had no prior browser history entry, causing mobile OSes to close/minimize the PWA; swiping back from Book Detail with a sheet open navigated the underlying route away while leaving the sheet stuck on screen.
2. **In-app Back buttons polluted forward history**: Tapping in-app Back controls called `window.location.hash = ...`, pushing new forward entries instead of popping (`history.back()`), creating history loops (`[Library, Book, Library]`) and breaking Forward navigation.
3. **Unsaved Recording Studio audio lacked swipe-back protection**: Swiping back while recording or paused immediately triggered `hashchange` and unmounted `RecordingStudioView` without pausing or prompting **Keep Draft & Leave** / **Discard & Leave**.
4. **Global CSS blocked horizontal swipe gestures**: `html { overscroll-behavior: none; }` in [`src/styles/global.css`](../src/styles/global.css) suppressed horizontal overscroll navigation (`overscroll-behavior-x: none`) in addition to pull-to-refresh (`overscroll-behavior-y: none`).

## Decision
Replace ad-hoc `window.location.hash` mutations and unbacked modal booleans with a **unified browser-history navigation controller** ([`src/navigation/appHistory.ts`](../src/navigation/appHistory.ts)) exposed via React context ([`src/navigation/AppNavigationContext.tsx`](../src/navigation/AppNavigationContext.tsx)):

- **Unified `history.state` model (`StoryTapeHistoryState`)**:
  - Every history entry stores `{ __storytape: true, sessionId, index, route, overlays, transientId? }` alongside the canonical hash URL (`#/`, `#/book/:id`, `#/record/:id`, `#/book/:id/compare/:recId`, `#/quality-lab/mic-test`), preserving subpath compatibility on GitHub Pages ([ADR-01](./ADR-01-zero-backend-offline-first-pwa.md)).
  - Re-openable sheets (`settings`, `theme`, `book-editor`, `share`, `ios-install`, `player`, `player-drawer`) are pushed onto `overlays[]` via `history.pushState` inside user tap handlers (satisfying Chromium's user-activation history requirement so Back gestures are never skipped).
  - Ephemeral dialogs (`ConfirmDialog`, `SaveRecordingSheet`) use `pushTransient(kind, onDismiss)`: swiping back dismisses them cleanly without navigating the underlying screen, while swiping forward onto an expired `transientId` never resurrects a stale destructive prompt.
- **Serialized History Command Queue with Optimistic Synchronous State**:
  - Because `window.history.back()` / `window.history.go(delta)` fire `popstate` asynchronously in browsers and `jsdom`, the controller updates its logical state synchronously for immediate zero-lag UI updates and serializes subsequent `pushState`/`replaceState`/`go` calls behind any in-flight browser `go(delta)` until its matching `popstate` settles. This eliminates race conditions when a user (or test) closes a sheet and immediately opens another screen.
- **Post-Mutation History Unwinding**:
  - In-app Back controls call `goBackOrReplace(fallbackRoute)` (popping history when `index > 0`, or replacing safely when deep-linked at `index === 0`).
  - Creating a book replaces the `BookEditor` entry with `Book Detail`; saving a recording unwinds back to an existing `Book Detail` entry or replaces `Record` with `Book Detail`; deleting a book unwinds back to `Library`; dismissing `#/join?...` replaces with `#/` so Back never reopens a dismissed invite.
- **Non-Destructive Back Guard for Recording Studio**:
  - While `RecordingStudioView` has unsaved audio (`durationMs > 0 || phase === 'recording'`), it registers a back-guard. When a backward `popstate` attempts to leave the guarded entry, the controller keeps `RecordingStudioView` mounted, restores the browser history pointer with `history.go(+delta)`, and invokes the guard callback to pause capture and display the **Unsaved Recording** sheet.
- **Horizontal Edge-Swipe Preservation**:
  - `html` and `body` in [`src/styles/global.css`](../src/styles/global.css) set `overscroll-behavior-y: none` (preventing pull-to-refresh) while leaving `overscroll-behavior-x` at default `auto`. Interactive horizontal scrubbers (`.waveform-canvas`, `.player-scrub`) retain `touch-action: none` so waveform/timeline scrubbing never collides with edge-swipe navigation.

## System Invariants
1. **Zero unbacked full-screen sheets or modals**: Opening any top-level sheet (`SettingsSheet`, `ThemeSwitcherSheet`, `BookEditorSheet`, `ShareSheet`, `IosInstallGuideModal`, `AudioPlayerSheet`, player sub-drawers, `ConfirmDialog`, `SaveRecordingSheet`) pushes a user-activated browser history entry so a mobile Back gesture dismisses the top-most surface instead of closing the PWA.
2. **No history-loop pollution**: In-app Back buttons pop history (`history.back()`/`go`) when a prior StoryTape entry exists (`index > 0`) rather than pushing duplicate forward routes, preserving clean browser Back & Forward symmetry.
3. **Deep-link safe root fallback**: When launched directly onto a non-Library route at `index === 0`, tapping in-app Back replaces with `#/` rather than invoking `history.back()` out of the PWA.
4. **No stale destructive dialog resurrection**: Swiping Forward onto a previously dismissed `transientId` never re-opens a `ConfirmDialog` or `SaveRecordingSheet`.
5. **Unsaved recording safety**: Swiping Back from Recording Studio while audio is unsaved never unmounts `RecordingStudioView` without explicit user choice (**Keep Draft & Leave** or **Discard & Leave**).
6. **Pull-to-refresh blocked without blocking swipe-back**: `src/styles/global.css` uses `overscroll-behavior-y: none` and never sets shorthand `overscroll-behavior: none` or `overscroll-behavior-x: none` on `html`/`body`.

## Consequences & Trade-offs
- **Pros:** Native-feeling back and forward swipe navigation across every screen and sheet in standalone Android/iOS PWAs, zero accidental PWA exits from overlays, protected recording sessions, and clean linear browser history.
- **Cons:** History operations (`go(delta)` followed by `pushState`/`replaceState`) must stay serialized through `AppHistoryController` rather than calling `window.history.*` or mutating `window.location.hash` directly in view components.
