# ADR-04: Decoupled 60/120fps Canvas Waveform & Deterministic Scrub Momentum

- **Status:** Accepted
- **Date:** 2026-11-20
- **Related CUJs:** [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-03](../cuj/CUJ-03-scrub-preview-punchin.md)

## Context
Driving a scrolling audio waveform through React state updates on every incoming audio chunk causes React reconciliation churn, dropped frames on mobile phones, and stepped/janky scrolling. Calling DOM layout APIs (`getBoundingClientRect()`, `getComputedStyle()`) inside `requestAnimationFrame` causes layout thrashing. Additionally, pointer-flick scrub momentum that outlives external state transitions (such as `Stop here` trim, `Undo trim`, `End`, `-5s`/`+5s`, or resuming recording) can overwrite the user's playhead unexpectedly—especially on slower mobile CPUs or contended CI runners.

## Decision
Implement [`src/components/WaveformCanvas.tsx`](../src/components/WaveformCanvas.tsx) as a **React-decoupled Canvas 2D renderer**:
- **Live `rAF` direct reads**: During `'recording'` and `'playing'`, read live peaks, duration, playhead, and level directly from `RecordingEngine.getLiveRenderState()` inside `requestAnimationFrame`, with smooth sub-chunk playhead interpolation between 25ms worklet flushes. Throttle React snapshot emissions (`RecordingEngine.emit()`) to ~15Hz solely for timer text updates.
- **Zero per-frame DOM reads**: Cache CSS theme colors once via `MutationObserver` on `document.documentElement`'s `data-theme` attribute, and cache canvas logical dimensions/DPR once via `ResizeObserver`.
- **Batched Canvas 2D drawing**: Group bars by style into a handful of `beginPath()`/`fill()`/`stroke()` calls per frame rather than per-bar draw calls.
- **Strict scrub momentum cancellation**: Track the last momentum-emitted `(ms, durationMs)` and cancel the momentum `rAF` immediately whenever:
  1. `phase !== 'paused'` (resuming recording or starting preview playback),
  2. `durationMs` changes (trim via **Stop here**, **Undo trim**, or punch-in), or
  3. `playheadMs` changes externally by `> 5ms` (`-5s`, `+5s`, `End`, `Undo trim`).
  Guard inside the `glide` callback itself against live engine/prop phase and duration changes so stale closures can never seek after a transition.

## System Invariants
1. **Zero `getComputedStyle()` or `getBoundingClientRect()` inside `rAF`**.
2. **Canvas animation must never trigger 60fps React re-renders**.
3. **Scrub momentum never overrides user actions**: Any phase change, timeline duration change, or external seek immediately terminates inertia gliding (verified deterministically in [`src/components/__tests__/WaveformCanvas.test.tsx`](../src/components/__tests__/WaveformCanvas.test.tsx)).

## Consequences & Trade-offs
- **Pros:** Smooth 60/120fps scrolling on mobile devices; predictable, responsive touch scrubbing without playhead snap-back bugs.
- **Cons:** Canvas state lives in refs alongside React props, requiring discipline to keep live engine state and React prop updates synchronized.
