# CUJ-05: Minimalistic Audiobook Player — Mini-Player, Full-Screen Sheet, Speed, Sleep Timer & Continue Listening

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-05-audiobook-player.spec.ts`](../e2e/cuj-05-audiobook-player.spec.ts)  
**Related ADRs:** [ADR-07](../adr/ADR-07-vanilla-css-token-theming-and-mobile-ergonomics.md), [ADR-08](../adr/ADR-08-persistent-player-and-media-session.md)

## Goal
A parent (or child at bedtime) listens to recorded audiobooks through a calm, minimalistic persistent player with floating mini-player navigation, full-screen Now Playing controls, chapter switching, playback speed, bedtime sleep timer, and automatic resume position memory.

## Preconditions
- A book project exists with 2+ recorded audio chapters.

## User Steps & Acceptance Criteria

1. **Start Playing from Chapter Row & Persistent Floating Mini-Player**
   - Tap a chapter card inside Book Detail.
   - **Expected:** Floating `MiniPlayerBar` appears above the bottom safe area displaying chapter title, book title, cover thumbnail, progress hairline, Play/Pause, and Close controls.
   - Navigate back to the Library.
   - **Expected:** `MiniPlayerBar` persists smoothly across views while browsing (and hides automatically if entering Recording Studio).

2. **Expand Minimalistic Full-Screen Player Sheet**
   - Tap the `MiniPlayerBar` (or tap **Listen / Continue** on Book Detail).
   - **Expected:** Opens full-screen `AudioPlayerSheet` showing `Chapter X of Y`, book cover art, book/chapter titles, narrator, waveform scrub timeline, elapsed & `-remaining` times, and transport controls (`Prev`, `-15s`, `Play/Pause`, `+15s`, `Next`).

3. **Chapter Navigation, Playback Speed & Bedtime Sleep Timer**
   - Tap **Next chapter** and **Chapters** quick-drawer to jump between chapters cleanly.
   - Tap the **Speed** pill (`1×` → `1.15×` → `1.25×`).
   - Tap **Sleep** → choose `15 minutes` (or `End of current chapter`) → verify active timer indicator/countdown.

4. **Continue Listening Persistence & Close Player**
   - Minimize the player, reload the app, and return to the Library.
   - **Expected:** **Continue Listening** card appears at the top of the Library for the active book with remaining time and one-tap Play button.
   - Tapping **Close player** (`×`) on the mini-player cleanly dismisses playback.
