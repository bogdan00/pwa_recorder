# CUJ-02: Core Audio Recording — Start, Live Waveform, Pause, Safe Resume & Stop Name Prompt

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-02-core-recording.spec.ts`](../e2e/cuj-02-core-recording.spec.ts)  
**Related ADRs:** [ADR-02](../adr/ADR-02-indexeddb-arraybuffer-storage-and-drafts.md), [ADR-03](../adr/ADR-03-off-main-thread-pcm-capture-and-timeline.md), [ADR-04](../adr/ADR-04-decoupled-60fps-canvas-waveform.md), [ADR-09](../adr/ADR-09-strict-local-to-ci-verification-parity.md)

## Goal
A parent enters the mobile Recording Studio for a book, starts recording with the large tactile Start/Pause button, watches the live waveform and timer advance in real time, pauses, safely resumes recording to append more audio, and taps the smaller Stop button to name and save the chapter.

## Preconditions
- A book project exists and microphone access is granted.

## User Steps & Acceptance Criteria

1. **Open Recording Studio**
   - From Book Detail, tap **Record First Chapter** (or **Record Chapter**).
   - **Expected:** Navigates to `#/record/:id` (even after browser `hashchange` fires), displays `READY`, timer `00:00.0`, big Record button (`#big-record-pause-btn`), disabled smaller Stop button (`#small-stop-btn`), and tappable audio spec pill.

2. **Start Recording & Observe Live Waveform**
   - Tap the big **Start** button.
   - **Expected:** Status transitions to `REC`, Stop button enables, timer advances smoothly past `00:01.0`, and real PCM audio flows through `AudioWorklet` drawing live waveform bars onto `<canvas>` without 30-second silent-sink clock-drop clicks or digital peak clipping.
   - **Smooth 60fps Waveform Rendering:** During active recording, the live waveform scrolls continuously via `requestAnimationFrame` (targeting 60fps with sub-pixel horizontal progression aligned to elapsed recording time) rather than jumping in discrete audio-chunk increments, producing smooth animation with no stair-stepping or visible jank.

3. **Pause & Safe Resume (2nd Worklet Attach)**
   - Tap the big **Pause** button.
   - **Expected:** Status becomes `PAUSED`, timer freezes at recorded duration, a 15ms anti-click tail fade-out is applied, and paused review controls appear.
   - Tap the big **Resume** button.
   - **Expected:** Status returns to `REC` without throwing duplicate `AudioWorklet.addModule()` errors, subsequent audio fades in smoothly over 15ms without a splice click, and timer continues advancing beyond the paused timestamp.

4. **Full Stop & Recording Name Prompt**
   - Tap the smaller **Stop** button.
   - **Expected:** Opens **Name this Recording** bottom sheet pre-filled with smart default `Chapter 1` (or `Chapter N`).
   - Test **Back to Recording** safety escape returns calmly to paused state without losing audio.
   - Tap **Stop** again, type a custom recording name + optional notes, and tap **Save Recording**.
   - **Expected:** Encodes audio to browser-native format (WebM/M4A/WAV), saves metadata + audio blob in IndexedDB, navigates back to Book Detail, and displays the new chapter with duration and audio spec badge. Survives page reload.

5. **Lock-Screen Background Resilience & OLED Blackout Mode**
   - While recording, `RecordingEngine` activates `navigator.audioSession.type = 'play-and-record'`, a synchronous inaudible looping `<audio>` background keepalive + Lock Screen MediaSession status, `AudioContext` `interrupted`/`suspended` auto-resume, immediate draft persistence on `visibilitychange` (`hidden`), and `MediaStreamTrack` interruption monitoring.
   - If the OS forcibly ends the microphone track while backgrounded/locked, `RecordingEngine` flushes all captured PCM to IndexedDB, auto-pauses cleanly without losing audio, and displays a clear recovery warning (`data-testid="studio-capture-warning"`).
   - While recording, tapping **Blackout screen** (`data-testid="blackout-mode-btn"`) activates a pure-black OLED pocket/bedtime overlay (`data-testid="studio-blackout-overlay"`) with accidental-tap protection (double-tap to wake) while recording continues uninterrupted.
