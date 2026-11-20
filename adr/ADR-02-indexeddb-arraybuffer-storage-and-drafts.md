# ADR-02: IndexedDB `ArrayBuffer` Binary Storage & Crash-Safe Draft Persistence

- **Status:** Accepted
- **Date:** 2026-11-19
- **Related CUJs:** [CUJ-01](../cuj/CUJ-01-book-management.md), [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-04](../cuj/CUJ-04-chapter-management.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-10](../cuj/CUJ-10-local-master-export-compare.md)

## Context
StoryTape stores large binary media assets locally on mobile browsers: encoded audio chapters (tens of MBs), optional uncompressed 32-bit Float WAV local masters, cover photos, and in-progress raw PCM recording chunks for crash recovery. `localStorage` is synchronous and capped at ~5 MB, whereas storing raw `Blob` objects directly in IndexedDB triggers known structured-clone failures and corruption across iOS Safari WebKit versions and `fake-indexeddb` in unit tests.

## Decision
Separate lightweight preferences from structured/binary media storage:
- **IndexedDB ([`src/storage/db.ts`](../src/storage/db.ts), schema v2)**: Store projects, recordings metadata, binary chapter audio blobs (`recordingBlobs`), optional device-local lossless masters (`recordingMasters`), cover images, playback progress, and crash-recovery PCM drafts in dedicated IndexedDB object stores using `idb`.
- **`ArrayBuffer` envelope invariant**: Convert every `Blob` to `{ buffer: ArrayBuffer, type: string }` via `blob.arrayBuffer()` before writing to IndexedDB, and reconstruct `new Blob([stored.buffer], { type: stored.type })` on read.
- **Local-only lossless masters (`recordingMasters`)**: When `keepLocalMaster` is enabled, store the raw 32-bit IEEE Float WAV master keyed by `recordingId` exclusively on-device (`recordingMasters`). Local masters are never uploaded to Google Drive or serialized into `project.json`, are preserved across Drive metadata pulls, cascade-delete with their parent recording/project, and are reclaimed via dedicated per-chapter or bulk deletion controls without affecting synced chapter audio.
- **Incremental crash-safe draft chunks**: While recording, flush raw PCM chunks and peak metadata incrementally to the drafts store so an OS suspension, tab kill, or accidental reload preserves the in-progress take and surfaces a recovery banner in Library.
- **`localStorage` ([`src/storage/settings.ts`](../src/storage/settings.ts))**: Keep small synchronous settings (theme, audio quality, `keepLocalMaster`, default narrator, Drive folder pointers, install dismissal timestamp) in `localStorage` so theme application can run synchronously before first paint.
- **Cache eviction for synced chapters**: Support freeing local audio blobs for chapters already synced to Google Drive (`clearSyncedAudioCache`), transitioning them to `cloud_only` without deleting metadata, unsynced recordings, or local lossless masters.

## System Invariants
1. **No raw `Blob` writes to IndexedDB**: All binary records stored in IndexedDB (`recordingBlobs`, `recordingMasters`, `projectCovers`) must use `{ buffer: ArrayBuffer, type: string }`.
2. **Draft durability**: In-progress recordings flush PCM chunks periodically and on pause/trim/undo so audio is recoverable after reload.
3. **Never evict unsynced audio**: Cache-freeing operations must only remove `recordingBlobs` whose `syncStatus === 'synced'` and `driveFileId` is present.
4. **Local master isolation & cleanup**: `recordingMasters` never sync to Google Drive, are preserved across remote metadata merges, and always cascade-delete when their chapter or book is deleted.

## Consequences & Trade-offs
- **Pros:** Eliminates iOS WebKit and `fake-indexeddb` `Blob` serialization bugs; resilient crash recovery; fast synchronous theme boot; allows lossless archival & quality benchmarking without bloating Drive quotas.
- **Cons:** Brief extra memory copy during `Blob ↔ ArrayBuffer` conversion on save/read; 32-bit Float WAV masters consume significant local storage until pruned.
