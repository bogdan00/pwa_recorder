# CUJ-02: Core Audio Recording — Start, Live Waveform, Pause, Safe Resume & Stop Name Prompt

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-02-core-recording.spec.ts`](../e2e/cuj-02-core-recording.spec.ts)

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
   - **Expected:** Status transitions to `REC`, Stop button enables, timer advances smoothly past `00:01.0`, and real PCM audio flows through `AudioWorklet` drawing live waveform bars onto `<canvas>`.

3. **Pause & Safe Resume (2nd Worklet Attach)**
   - Tap the big **Pause** button.
   - **Expected:** Status becomes `PAUSED`, timer freezes at recorded duration, paused review controls appear.
   - Tap the big **Resume** button.
   - **Expected:** Status returns to `REC` without throwing duplicate `AudioWorklet.addModule()` errors, and timer continues advancing beyond the paused timestamp.

4. **Full Stop & Recording Name Prompt**
   - Tap the smaller **Stop** button.
   - **Expected:** Opens **Name this Recording** bottom sheet pre-filled with smart default `Chapter 1` (or `Chapter N`).
   - Test **Back to Recording** safety escape returns calmly to paused state without losing audio.
   - Tap **Stop** again, type a custom recording name + optional notes, and tap **Save Recording**.
   - **Expected:** Encodes audio to browser-native format (WebM/M4A/WAV), saves metadata + audio blob in IndexedDB, navigates back to Book Detail, and displays the new chapter with duration and audio spec badge. Survives page reload.
