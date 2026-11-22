# CUJ-11: Mobile Back & Forward History Navigation, Sheet Dismissal & Recording Exit Guard

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-11-history-back-forward-navigation.spec.ts`](../e2e/cuj-11-history-back-forward-navigation.spec.ts)  
**Related ADRs:** [ADR-01](../adr/ADR-01-zero-backend-offline-first-pwa.md), [ADR-07](../adr/ADR-07-vanilla-css-token-theming-and-mobile-ergonomics.md), [ADR-12](../adr/ADR-12-history-backed-navigation-and-overlay-stack.md)

## Goal
A parent using StoryTape as an installed mobile PWA (or mobile browser) swipes back or forward using their phone's native edge-swipe gesture (or browser Back/Forward buttons) and navigates naturally across screens, full-screen sheets, nested modals, the audiobook player, and confirmation dialogs—without accidentally closing the PWA or losing an active/unsaved recording.

## Preconditions
- StoryTape is loaded at `/pwa_recorder/` (root Library `#/`).
- Horizontal browser swipe navigation is not suppressed (`html` uses `overscroll-behavior-y: none` rather than `overscroll-behavior: none`).

## User Steps & Acceptance Criteria

1. **Multi-Screen Back & Forward Traversal**
   - From Library (`#/`), create or open a Book (`#/book/:id`), then open Recording Studio (`#/record/:id`, idle with 0 audio) or Chapter Quality Lab (`#/book/:id/compare/:recId`).
   - Trigger browser/gesture **Back** → returns cleanly to Book Detail (`#/book/:id`), then **Back** again → returns cleanly to Library (`#/`).
   - Trigger browser/gesture **Forward** → returns cleanly to Book Detail, then **Forward** again → returns cleanly to Recording Studio / Quality Lab.
   - Tapping the in-app **Back** arrow (`Back to library`, `Back to book`, `Leave recording studio`) pops the history stack instead of pushing duplicate entries, so subsequent **Back** gestures never loop back to the screen just left, and **Forward** still returns to the previous screen.

2. **Full-Screen Overlays, Sheets & Nested Modals Dismiss on Swipe Back (Without Closing PWA)**
   - From Library (`#/`), open **Studio Settings** → swipe **Back** → Settings closes and Library remains open (PWA does not exit). Swipe **Forward** → Settings re-opens.
   - Open **Studio Settings** → switch to **App** tab → open **Theme Switcher** stacked on top of Settings → swipe **Back** once → Theme Switcher closes while Studio Settings stays open on the **App** tab → swipe **Back** again → Studio Settings closes back to Library. Swipe **Forward** twice → Settings then Theme Switcher restore in order.
   - Open **New Book** (`BookEditorSheet`) or **Share Library** (`ShareSheet`) from Library → swipe **Back** → sheet closes cleanly back to Library.
   - Open a **Confirm Dialog** (e.g., Discard Draft or Delete Recording) → swipe **Back** → dialog cancels cleanly without leaving the underlying screen; swiping **Forward** afterward never resurrects a stale destructive confirmation dialog.

3. **Expanded Audiobook Player & Internal Drawers**
   - From Library or Book Detail, expand the full-screen **AudioPlayerSheet** (e.g., via Continue Listening or tapping MiniPlayerBar) → open the **Chapters** or **Sleep Timer** drawer.
   - Swipe **Back** once → closes the internal drawer while keeping the full-screen Audio Player open.
   - Swipe **Back** again → minimizes the Audio Player back to the underlying screen (Library or Book Detail) while audio playback continues in `MiniPlayerBar` (does not close the PWA or leave the current screen).
   - Swipe **Forward** → re-expands the full-screen Audio Player.

4. **Post-Save & Post-Delete History Hygiene**
   - **New Book Creation**: Library → New Book → Create Book → lands on Book Detail (`[Library, Book]`). Swiping **Back** goes straight to Library (never back into the New Book form).
   - **Recording Saved**: Library → Book Detail → Record → Save Chapter → lands on Book Detail (`[Library, Book]`). Swiping **Back** goes straight to Library (never back into Recording Studio or SaveRecordingSheet).
   - **Draft Resumed & Saved**: Library → Resume Draft → Save Chapter → lands on Book Detail (`[Library, Book]`). Swiping **Back** goes straight to Library.
   - **Book Deleted**: Library → Book Detail → Edit Book → Delete Book → lands on Library (`[Library]`). History contains no stale loop back to the deleted book.

5. **Unsaved Recording Studio Exit Protection on Swipe Back**
   - In Recording Studio with recorded audio (actively recording or paused with `durationMs > 0`):
     - If **SaveRecordingSheet** is open, swiping **Back** dismisses the save prompt ("Back to Recording") and keeps the paused take intact inside Recording Studio.
     - If no sheet is open, swiping **Back** intercepts exit, pauses capture cleanly, keeps `RecordingStudioView` mounted with all recorded audio intact, and opens the **Unsaved Recording** confirmation sheet (**Stay** / **Discard & Leave** / **Keep Draft & Leave**).
     - Tapping **Stay** (or swiping **Back** again) dismisses the confirmation sheet and keeps the user in Recording Studio with the take intact.
     - Tapping **Keep Draft & Leave** or **Discard & Leave** exits cleanly back to the previous screen (Book Detail or Library).

6. **Deep-Link Safe Fallback**
   - Loading `#/book/:id` directly in a fresh browser history entry (no prior Library entry) and tapping the in-app **Back to library** button navigates cleanly to Library (`#/`) instead of attempting to exit the tab/PWA.
