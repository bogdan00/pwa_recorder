# ADR-03: Off-Main-Thread `AudioWorklet` PCM Capture, Mutable Timeline & Post-Encode Pipeline

- **Status:** Accepted
- **Date:** 2026-11-19
- **Related CUJs:** [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-03](../cuj/CUJ-03-scrub-preview-punchin.md), [CUJ-07](../cuj/CUJ-07-quality-and-devices.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-10](../cuj/CUJ-10-local-master-export-compare.md)

## Context
StoryTape requires pause/resume, drag-to-scrub preview playback, punch-in re-recording, contextual **Stop here** tail trimming, 1-step undo, configurable high-ceiling output formats (AAC M4A, Opus WebM, lossless 16/24/32-bit WAV up to 96 kHz), optional full-resolution local master archival, and offline multi-bitrate re-encoding / synchronized blind A/B comparison. Standard `MediaRecorder` outputs opaque compressed streams that cannot be frame-accurately scrubbed, spliced without audible clicks, or undone cleanly across pause/resume sessions. Furthermore, `ScriptProcessorNode` is deprecated and causes audio glitches on the main thread.

## Decision
Adopt a **two-stage PCM capture → post-recording encode & client-side transcode** architecture in [`src/audio/`](../src/audio/) and [`public/audio/pcm-capture-worklet.js`](../public/audio/pcm-capture-worklet.js):
- **Off-main-thread capture (`AudioWorklet`)**: Capture interleaved float32 PCM frames inside `pcm-capture-worklet.js` with a ~25ms flush cadence and 50 waveform peaks/second.
- **iOS/Mobile WebKit pull-graph invariant**: Instantiate `AudioWorkletNode` with `numberOfOutputs: 1` and route it through a muted `GainNode(0)` into `ctx.destination`, ensuring iOS Safari WebKit and mobile Chrome continuously pull audio render quanta. Guard `ctx.audioWorklet.addModule()` per `AudioContext` so re-resuming never reloads the module.
- **Mutable `PcmTimeline` ([`src/audio/pcmTimeline.ts`](../src/audio/pcmTimeline.ts))**: Maintain captured audio as contiguous PCM chunks supporting exact frame-level truncation (`truncateAtFrame`), automatic **15ms anti-click tail fade-out + next-append fade-in crossfade**, and a deep **1-step undo snapshot** shared by both punch-in re-recording and **Stop here** (`RecordingEngine.trimToPlayhead()`).
- **Decoupled lifecycle in `RecordingEngine` ([`src/audio/recordingEngine.ts`](../src/audio/recordingEngine.ts))**: Keep React listener subscriptions strictly separate from draft-loading effects; never clear active UI listeners inside async `dispose()`.
- **Post-recording dual-output encoding ([`src/audio/nativeEncoder.ts`](../src/audio/nativeEncoder.ts), [`src/audio/wavEncoder.ts`](../src/audio/wavEncoder.ts), [`src/audio/qualityPresets.ts`](../src/audio/qualityPresets.ts))**: Encode the final PCM timeline on Save via WebCodecs (`AudioEncoder`) + `mp4-muxer` (M4A AAC) or `webm-muxer` (WebM Opus), with automatic fallback to lossless 16/24/32-bit WAV. When `keepLocalMaster` is enabled, simultaneously serialize the raw un-resampled float32 timeline as a 32-bit IEEE Float WAV master (`formatTag = 3`) for local archival.
- **Pure-TS WAV decode & client-side re-encode ([`src/audio/audioExporter.ts`](../src/audio/audioExporter.ts))**: Parse 16-bit PCM, 24-bit PCM, and 32-bit IEEE Float RIFF/WAVE blobs directly in TypeScript (zero browser decoder loss/resampling) with `AudioContext.decodeAudioData` fallback for compressed inputs, then re-encode via `encodeAudio` for single/batch export and synchronized Web Audio dual-gain A/B comparison.

## System Invariants
1. **PCM capture stays off the main thread** in `public/audio/pcm-capture-worklet.js` with muted `GainNode(0)` → `ctx.destination` routing.
2. **All destructive timeline cuts** (`punchInFromPlayhead`, `trimToPlayhead`) apply a 15ms tail fade-out and store a 1-step undo snapshot.
3. **Synchronous gesture activation**: `AudioContext.resume()` is triggered inside user tap handlers so iOS standalone PWAs do not block capture or preview playback.
4. **Listener safety**: Async engine teardown/draft reloads must never detach active UI subscribers.
5. **Lossless master fidelity**: Local masters preserve exact captured sample rate, channel count, and 32-bit IEEE Float precision without resampling or lossy round-trips.

## Consequences & Trade-offs
- **Pros:** Sample-accurate scrub, click-free punch-in and Stop-here cuts, instant 1-step undo, lossless WAV and high-bitrate AAC/Opus from a single capture pipeline, and bit-exact offline bitrate comparison directly from the captured master.
- **Cons:** Long chapters consume linear RAM for float32 PCM during active recording (mitigated by chapter-length sessions and incremental draft persistence).
