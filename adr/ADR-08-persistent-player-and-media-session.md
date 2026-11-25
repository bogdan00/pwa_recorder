# ADR-08: Persistent `PlayerContext`, On-Demand Cloud Caching & Media Session Integration

- **Status:** Accepted
- **Date:** 2026-11-19
- **Related CUJs:** [CUJ-05](../cuj/CUJ-05-audiobook-player.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md), [CUJ-12](../cuj/CUJ-12-import-custom-audio.md)

## Context
Listening to a bedtime audiobook requires uninterrupted playback while browsing the Library or Book Detail screens, remembering the exact chapter and timestamp across sessions ("Continue Listening"), gradually fading out audio when a sleep timer expires, seamlessly downloading `cloud_only` chapters on tap, and pausing immediately if the parent opens Recording Studio to record a new chapter.

## Decision
Centralize playback in a top-level React context ([`src/player/PlayerContext.tsx`](../src/player/PlayerContext.tsx)) mounted above screen routes in [`src/App.tsx`](../src/App.tsx):
- **Route-independent audio lifecycle**: Maintain a single managed `HTMLAudioElement` inside `PlayerContext`, exposing persistent [`MiniPlayerBar`](../src/components/MiniPlayerBar.tsx) (hidden inside Recording Studio) and full-screen [`AudioPlayerSheet`](../src/components/AudioPlayerSheet.tsx).
- **Recording-capture mutual exclusion**: Expose `player.pauseForRecording()` invoked whenever navigating into Recording Studio so playback audio never bleeds into microphone capture.
- **Persistent per-book resume progress**: Periodically and on pause/chapter-change persist `{ projectId, recordingId, positionSec, updatedAt }` to IndexedDB (`playbackProgress` store) to power the Library's **Continue Listening** card; automatically clear saved progress when the final chapter of a book finishes playing or when the user dismisses the Continue Listening card.
- **On-demand cloud download & cache**: When playing a `cloud_only` chapter (synced remote book or freed local cache), download the chapter via `downloadCloudRecording`, normalize its MIME type from recording metadata (`rec.mimeType` / `rec.extension`) before storing it in IndexedDB ([ADR-02](./ADR-02-indexeddb-arraybuffer-storage-and-drafts.md)), and begin playback transparently.
- **Cross-browser Safari/iOS playback resilience & self-healing ([`src/player/playbackBlob.ts`](../src/player/playbackBlob.ts), [`src/audio/aacEsds.ts`](../src/audio/aacEsds.ts))**: Before assigning `URL.createObjectURL(blob)` to `HTMLAudioElement`, normalize missing or generic `application/octet-stream` MIME types from `Recording` metadata (iOS Safari rejects extensionless `blob:` URLs lacking an audio MIME type), proactively detect and repair legacy double-wrapped `esds` boxes in `.m4a` files produced by iOS 26 Safari WebKit Bug #302253 (preserving exact `moov` byte length via a trailing `free` box so `stco`/`co64` chunk offsets remain untouched, and persisting the repaired blob back to IndexedDB), and fall back in-memory to 16-bit PCM WAV if `<audio>` throws `NotSupportedError` on a 32-bit IEEE Float WAV (`formatTag = 3`).
- **Sleep timer & Media Session API**: Support configurable sleep timers (including "End of chapter") with smooth volume fade-out, variable playback speed (`0.75×`–`2×`), and lock-screen metadata/controls via `navigator.mediaSession`.

## System Invariants
1. **Single playback owner**: Only `PlayerContext` manages audiobook playback `<audio>` state and object URL revocation (preventing blob URL memory leaks).
2. **Never play during mic recording**: Entering Recording Studio or starting capture pauses active audiobook playback.
3. **Resume accuracy**: Switching books or reloading restores the last played chapter and position from IndexedDB.
4. **iOS Safari blob & container resilience**: Every playback `blob:` URL carries an explicit audio MIME type derived from recording metadata, legacy double-wrapped AAC `esds` MP4 blobs are repaired transparently in-place without corrupting `mdat`/`stco` offsets, and 32-bit Float WAV chapters degrade cleanly to in-memory 16-bit PCM WAV if the browser rejects `formatTag = 3`.

## Consequences & Trade-offs
- **Pros:** Native audiobook-app feel with uninterrupted background/lock-screen playback, self-healing compatibility for existing iOS 26 `.m4a` chapters without re-recording, and clean separation between playback UI and audio orchestration.
- **Cons:** Object URL lifecycle must be carefully revoked on track switch/unmount to avoid memory growth on iOS Safari.
