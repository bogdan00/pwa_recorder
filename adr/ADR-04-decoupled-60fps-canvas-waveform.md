# ADR-04: Decoupled 60/120fps Canvas Waveform & Deterministic Scrub Momentum

- **Status:** Accepted
- **Date:** 2026-11-20
- **Related CUJs:** [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-03](../cuj/CUJ-03-scrub-preview-punchin.md)

## Context
Driving a scrolling audio waveform through React state updates on every incoming audio chunk causes React reconciliation churn, dropped frames on mobile phones, and stepped/janky scrolling. Calling DOM layout APIs (`getBoundingClientRect()`, `getComputedStyle()`) inside `requestAnimationFrame` causes layout thrashing. Additionally, pointer-flick scrub momentum that outlives external state transitions (such as `Stop here` trim, `Undo trim`, `End`, `-5s`/`+5s`, or resuming recording) can overwrite the user's playhead unexpectedly—especially on slower mobile CPUs or contended CI runners.

## Decision
Implement [`src/components/WaveformCanvas.tsx`](../src/components/WaveformCanvas.tsx) and [`src/views/RecordingStudioView.tsx`](../src/views/RecordingStudioView.tsx) as a **React-decoupled, zero-layout-thrash 60/120fps renderer**:
- **Live `rAF` direct reads, clock-aligned playhead PLL & direct timer DOM updates**: During `'recording'` and `'playing'`, read live peaks, duration, playhead, and level directly from `RecordingEngine.getLiveRenderState()` inside `requestAnimationFrame`. Compute elapsed time since the last audio chunk strictly in the `performance.now()` domain (never subtracting `lastChunkPerfMs` from a VSync `rAF` timestamp that can lag or offset on Android/Safari), and drive the scrolling playhead with a bounded-slew phase-locked loop (`220ms` burst extrapolation horizon, `180ms` phase-lock time constant, slew rate clamped to `0.75×–1.25×` real time) so even 90/120Hz displays or occasional bursty mobile audio callbacks never freeze at a hard cap or jump forward. Update the studio timer text directly via a DOM ref (with CSS `contain: layout style paint` and fixed tabular width) only when the formatted tenth-of-a-second string changes, eliminating steady-state React re-renders and full-page DOM layouts during active recording/playback.
- **Fast opaque Canvas2D rasterization**: Cap canvas DPR at `Math.min(window.devicePixelRatio || 1, 2)` (cutting pixel fill-rate by 56% on 3× phones while remaining Retina-crisp), request an opaque 2D context (`{ alpha: false }`) painted with the cached `--bg-surface` color to skip per-frame alpha compositing, draw waveform bars via batched `ctx.rect()` + `ctx.fill()` (at most 2 `fill()` calls per frame, avoiding both `roundRect()` Bezier tessellation and `lineCap = 'round'` semicircle arc tessellation on mobile Adreno/Mali GPUs), configure `ctx.font`/`textAlign`/`textBaseline` once on context init/resize rather than every frame, pre-render the recording playhead halo radial gradient into a cached offscreen sprite, and suspend the canvas `rAF` loop while pure-black OLED Blackout Mode covers the screen.
- **Zero per-frame DOM reads & zero per-frame style recalculations**: Cache CSS theme colors once via `MutationObserver` on `document.documentElement`'s `data-theme` attribute, cache canvas logical dimensions/DPR once via `ResizeObserver`, isolate canvas paint with `contain: strict`, and avoid main-thread-ticking CSS animations during active recording.
- **Strict scrub momentum cancellation**: Track the last momentum-emitted `(ms, durationMs)` and cancel the momentum `rAF` immediately whenever:
  1. `phase !== 'paused'` (resuming recording or starting preview playback),
  2. `durationMs` changes (trim via **Stop here**, **Undo trim**, or punch-in), or
  3. `playheadMs` changes externally by `> 5ms` (`-5s`, `+5s`, `End`, `Undo trim`).
  Guard inside the `glide` callback itself against live engine/prop phase and duration changes so stale closures can never seek after a transition.

## System Invariants
1. **Zero `getComputedStyle()` or `getBoundingClientRect()` inside `rAF`**.
2. **Zero steady-state React re-renders, DOM layouts, or per-frame `RecalcStyle` during active recording**.
3. **Opaque, DPR-capped (`<= 2`) batched `rect()` + `fill()` Canvas2D rendering** with cached font state, no per-frame `roundRect` / round-cap arc tessellation or `createRadialGradient` allocation, and paused `rAF` while obscured by OLED Blackout Mode.
4. **Monotonic, freeze-free & jump-free playhead motion**: Live recording playhead interpolation stays in a single clock domain and advances smoothly within `0.75×–1.25×` real time across bursty chunk arrival without hitting low hard-clamp walls or visibly jumping frames.
5. **Scrub momentum never overrides user actions**: Any phase change, timeline duration change, or external seek immediately terminates inertia gliding (verified deterministically in [`src/components/__tests__/WaveformCanvas.test.tsx`](../src/components/__tests__/WaveformCanvas.test.tsx)).

## Consequences & Trade-offs
- **Pros:** Sustained 60fps scrolling even under 4× CPU throttling and on 3× DPR mobile phones, dramatically lower battery/thermal load, zero main-thread starvation competing with audio IPC, and predictable touch scrubbing without playhead snap-back bugs.
- **Cons:** Canvas and live timer DOM updates bypass React state during active recording/playback, requiring explicit synchronization on phase transitions and unit/E2E verification of both DOM timer and canvas telemetry.
