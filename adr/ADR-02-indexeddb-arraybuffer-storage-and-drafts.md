# ADR-02: IndexedDB `ArrayBuffer` Binary Storage & Crash-Safe Draft Persistence

- **Status:** Accepted
- **Date:** 2026-11-19
- **Related CUJs:** [CUJ-01](../cuj/CUJ-01-book-management.md), [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-04](../cuj/CUJ-04-chapter-management.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md)

## Context
StoryTape stores large binary media assets locally on mobile browsers: encoded audio chapters (tens of MBs), cover photos, and in-progress raw PCM recording chunks for crash recovery. `localStorage` is synchronous and capped at ~5 MB, whereas storing raw `Blob` objects directly in IndexedDB triggers known structured-clone failures and corruption across iOS Safari WebKit versions and `fake-indexeddb` in unit tests.

## Decision
Separate lightweight preferences from structured/binary media storage:
- **IndexedDB ([`src/storage/db.ts`](../src/storage/db.ts))**: Store projects, recordings metadata, binary audio blobs, cover images, playback progress, and crash-recovery PCM drafts in dedicated IndexedDB object stores using `idb`.
- **`ArrayBuffer` envelope invariant**: Convert every `Blob` to `{ buffer: ArrayBuffer, type: string }` via `blob.arrayBuffer()` before writing to IndexedDB, and reconstruct `new Blob([stored.buffer], { type: stored.type })` on read.
- **Incremental crash-safe draft chunks**: While recording, flush raw PCM chunks and peak metadata incrementally to the drafts store so an OS suspension, tab kill, or accidental reload preserves the in-progress take and surfaces a recovery banner in Library.
- **`localStorage` ([`src/storage/settings.ts`](../src/storage/settings.ts))**: Keep small synchronous settings (theme, audio quality, default narrator, Drive folder pointers, install dismissal timestamp) in `localStorage` so theme application can run synchronously before first paint.
- **Cache eviction for synced chapters**: Support freeing local audio blobs for chapters already synced to Google Drive (`clearSyncedAudioCache`), transitioning them to `cloud_only` without deleting metadata or unsynced recordings.

## System Invariants
1. **No raw `Blob` writes to IndexedDB**: All binary records stored in IndexedDB must use `{ buffer: ArrayBuffer, type: string }`.
2. **Draft durability**: In-progress recordings flush PCM chunks periodically and on pause/trim/undo so audio is recoverable after reload.
3. **Never evict unsynced audio**: Cache-freeing operations must only remove blobs whose `syncStatus === 'synced'` and `driveFileId` is present.

## Consequences & Trade-offs
- **Pros:** Eliminates iOS WebKit and `fake-indexeddb` `Blob` serialization bugs; resilient crash recovery; fast synchronous theme boot.
- **Cons:** Brief extra memory copy during `Blob ↔ ArrayBuffer` conversion on save/read.
