# CUJ-03: Paused Waveform Drag-to-Scrub, Preview Playback, Punch-In, Stop Here & Undo

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-03-scrub-preview-punchin.spec.ts`](../e2e/cuj-03-scrub-preview-punchin.spec.ts)  
**Related ADRs:** [ADR-03](../adr/ADR-03-off-main-thread-pcm-capture-and-timeline.md), [ADR-04](../adr/ADR-04-decoupled-60fps-canvas-waveform.md), [ADR-09](../adr/ADR-09-strict-local-to-ci-verification-parity.md)

## Goal
While reading aloud, the parent pauses, drags the waveform directly with touch/pointer gestures to scrub back to an earlier moment, plays back to check how the last bit sounded, and chooses between continuing safely from the end, punching in (**Re-record from MM:SS**), or trimming the trailing audio and finishing immediately (**Stop here**), with 1-step Undo trim and discard protection.

## Preconditions
- Inside Recording Studio with a paused recording of at least 2–3 seconds.

## User Steps & Acceptance Criteria

1. **Direct Waveform Drag-to-Scrub & Zoom**
   - While paused, drag horizontally across the `<canvas>` waveform (pointer down → move right → pointer up).
   - **Expected:** Playhead timestamp decreases smoothly to an earlier time, sub-timer displays `Scrubbed · MM:SS.t total`, and tapping the `1×`/`2×` zoom toggle updates horizontal scale cleanly.
   - Tap **End** to jump back to full duration, and `-5s` / `+5s` buttons to step cleanly within `[0, duration]`.

2. **Preview Playback While Paused**
   - While paused at the end of a take (without scrubbing), tap **Play** in the paused review bar.
   - **Expected:** Status switches to `PLAYING` and preview playback starts from the beginning (`00:00.0`); tapping **Pause** stops preview cleanly back to `PAUSED`.
   - Scrub back earlier than the end and tap **Play** again.
   - **Expected:** Status switches to `PLAYING`, Web Audio preview plays from the scrubbed playhead and advances the timer; tapping **Pause** stops preview cleanly back to `PAUSED`.

3. **Safe Default Continue vs Contextual Punch-In ("Re-record from MM:SS")**
   - When scrubbed > 0.3s before the end, verify:
     - Big Record button label reads **Continue at end** (safe append).
     - Contextual **Re-record from MM:SS** pill appears above transport controls.
   - Tap **Re-record from MM:SS**.
   - **Expected:** Audio after the playhead is trimmed with a 15ms crossfade splice, recording resumes from that timestamp (`REC`), and pausing reveals the **Undo trim** button.

4. **Contextual Trim & Finish ("Stop here")**
   - While paused and scrubbed back (with playhead ≥ 0.15s so the remaining take is non-empty), verify a contextual **Stop here (MM:SS)** button appears next to **Re-record from MM:SS**.
   - Tap **Stop here (MM:SS)**.
   - **Expected:**
     - Everything after the scrubbed playhead is trimmed with a smooth 15ms fade-out and a 1-step Undo snapshot is saved.
     - The **Save Recording** name prompt opens immediately showing the shorter trimmed duration.
     - Tapping **Back to Recording** returns to `PAUSED` with **Undo trim** available to restore the cut tail; confirming **Save** encodes and saves the trimmed chapter cleanly.

5. **1-Step Undo Trim**
   - Tap **Undo trim** while paused (after either **Re-record from** or **Stop here** → **Back to Recording**).
   - **Expected:** Restores the pre-trim duration and hides the **Undo trim** button.

6. **Discard Take & Unsaved Leave Protection**
   - Tap Back while unsaved audio exists → **Unsaved Recording** dialog appears with **Stay**, **Discard & Leave**, and **Keep Draft & Leave**.
   - Tap **Stay**, then test the **Discard** button → confirmation modal → **Discard Take** resets studio back to `READY` / `00:00.0`.
