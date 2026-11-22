# CUJ-07: Studio Audio Quality (Presets, Bitrate, Sample Rate, WAV Export) & Multi-Device Microphone Settings

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-07-quality-and-devices.spec.ts`](../e2e/cuj-07-quality-and-devices.spec.ts)  
**Related ADRs:** [ADR-03](../adr/ADR-03-off-main-thread-pcm-capture-and-timeline.md)

## Goal
A parent tailors recording quality (from compact uploads up to 510 kbps compressed or lossless 96 kHz / 32-bit Float WAV, with raw phone-mic DSP toggles and input gain) and selects among multiple microphones with a live input level test before recording.

## Preconditions
- StoryTape PWA opened; browser exposes 1 or more audio input devices.

## User Steps & Acceptance Criteria

1. **Multi-Microphone Selection, iOS Software AGC Parity & Live Mic Test**
   - Open **Studio Settings** (**Recording** tab by default; also opened directly from the Recording Studio audio spec chip) → **Recording Device**.
   - Verify available microphones appear (with **Detect Microphones** unlock button if labels are hidden), select a non-default microphone, and tap **Test Mic** → **Stop Test**.
   - **Expected:** Selected microphone persists across reload, displays in the Recording Studio audio spec pill, live mic test displays a responsive logarithmic dBFS meter (`-60 dB` to `0 dB`) with channel/sample-rate telemetry (and indicates `Auto +XdB` when StoryTape's studio auto-gain fallback activates on browsers without native `autoGainControl`, such as iOS Safari), mono capture extracts channel 0 at `1.0×` unity gain (`discrete` channel interpretation — never halving `(L, 0)` streams to `-6 dB` / `0.4383`), Software AGC backs off cleanly whenever compressor gain reduction engages so vocals stay natural and unclipped, Debug JSON `lastRecordingPerf` surfaces redacted mic `trackSettings` and DSP headroom telemetry, and mic test stops cleanly without leaving mic streams open (including if the user switches settings tabs).

2. **Quality Presets, Collapsible Advanced Audio & Automatic Custom Detection**
   - Tap presets (`Voice Compact`, `Studio Raw (320k)`, `Master Archival WAV`) directly on the **Recording** tab and verify the live summary banner (`MB/min`) and collapsed **Advanced Audio & Input Gain** summary update.
   - Expand **Advanced Audio & Input Gain** (collapsed by default so everyday presets stay uncluttered) and verify DSP toggles reflect the selected preset (Studio Raw & Master Archival turn browser Noise Suppression & AGC OFF).
   - Customize Sample Rate (`96 kHz`), Bitrate (`510k` / `CBR`), Channels (`Stereo`), Input Gain slider (`-6 dB` to `+24 dB`, with animated quieter/louder wave preview, clickable logarithmic doubling ticks `0.5×`–`16×`, and plain-English logarithmic scale guidance), and 80 Hz Rumble Filter / Limiter switches.
   - **Expected:** Preset badge flips to `Custom`, estimated file size and Advanced Audio summary recalculate live, gain guidance/visual preview responds live to slider & quick-tick changes, and every setting persists across page reload.

3. **Real End-to-End Lossless WAV Recording with Custom Specs**
   - Inside **Advanced Audio & Input Gain**, select `WAV (Lossless)`, `48 kHz`, `24-bit PCM`, `Stereo (2 ch)`.
   - Open Recording Studio, record ~1s, stop, and save.
   - **Expected:** Saved chapter card displays `WAV · 48 kHz · 24-bit · Stereo` and the stored IndexedDB binary begins with valid RIFF/WAVE header bytes (`RIFF....WAVE`) with 2 channels and 24-bit depth.

4. **Tap-to-Expand `?` Helper Tooltips for Recording Options**
   - Tap the `?` help button next to recording options (e.g., **Recording Device**, **Recording Quality**, **Save Local Lossless Master**, **Format / Codec**, **Sample Rate**, **Bitrate**, **Bitrate Mode**, **Channels**, **Input Gain Boost**, and **Mic Processing (DSP)** toggles).
   - **Expected:** Each `?` button toggles an accessible inline guidance card (`aria-expanded="true"`) explaining what the option does and when to pick each choice in plain English (for example, explaining why **Mono** is recommended for phone voice recording vs. **Stereo** for external 2-mic recorders), fits cleanly within `360px`–`390px` viewports with zero horizontal overflow, keeps **Input Gain Boost** + `?` on a single line and the gain readout (`7.94× (+18.0 dB)` / `15.85× (+24.0 dB)`) + **Reset** button cleanly on a single line without mid-value wrapping, and collapses cleanly when tapped again.
