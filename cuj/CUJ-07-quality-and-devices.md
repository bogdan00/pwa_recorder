# CUJ-07: Studio Audio Quality (Presets, Bitrate, Sample Rate, WAV Export) & Multi-Device Microphone Settings

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-07-quality-and-devices.spec.ts`](../e2e/cuj-07-quality-and-devices.spec.ts)  
**Related ADRs:** [ADR-03](../adr/ADR-03-off-main-thread-pcm-capture-and-timeline.md)

## Goal
A parent tailors recording quality (from compact uploads up to 510 kbps compressed or lossless 96 kHz / 32-bit Float WAV, with raw phone-mic DSP toggles and input gain) and selects among multiple microphones with a live input level test before recording.

## Preconditions
- StoryTape PWA opened; browser exposes 1 or more audio input devices.

## User Steps & Acceptance Criteria

1. **Multi-Microphone Selection & Live Mic Test**
   - Open **Studio Settings** → **Recording Device**.
   - Verify available microphones appear (with **Detect Microphones** unlock button if labels are hidden), select a non-default microphone, and tap **Test Mic** → **Stop Test**.
   - **Expected:** Selected microphone persists across reload, displays in the Recording Studio audio spec pill, live mic test displays a responsive logarithmic dBFS meter (`-60 dB` to `0 dB`) with channel/sample-rate telemetry (and indicates `Auto +XdB` when StoryTape's studio auto-gain fallback activates on browsers without native `autoGainControl`, such as iOS Safari), and stops cleanly without leaving mic streams open.

2. **Quality Presets & Automatic Custom Detection**
   - Tap presets (`Voice Compact`, `Studio Raw (320k)`, `Master Archival WAV`) and verify the live summary banner (`MB/min`) and DSP toggles update (Studio Raw & Master Archival turn browser Noise Suppression & AGC OFF).
   - Customize Sample Rate (`96 kHz`), Bitrate (`510k` / `CBR`), Channels (`Stereo`), Input Gain slider (`-6 dB` to `+24 dB`, with animated quieter/louder wave preview, clickable logarithmic doubling ticks `0.5×`–`16×`, and plain-English logarithmic scale guidance), and 80 Hz Rumble Filter / Limiter switches.
   - **Expected:** Preset badge flips to `Custom`, estimated file size recalculates live, gain guidance/visual preview responds live to slider & quick-tick changes, and every setting persists across page reload.

3. **Real End-to-End Lossless WAV Recording with Custom Specs**
   - Select `WAV (Lossless)`, `48 kHz`, `24-bit PCM`, `Stereo (2 ch)`.
   - Open Recording Studio, record ~1s, stop, and save.
   - **Expected:** Saved chapter card displays `WAV · 48 kHz · 24-bit · Stereo` and the stored IndexedDB binary begins with valid RIFF/WAVE header bytes (`RIFF....WAVE`) with 2 channels and 24-bit depth.
