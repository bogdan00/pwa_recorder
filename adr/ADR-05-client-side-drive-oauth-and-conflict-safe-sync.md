# ADR-05: Client-Side Google Drive Sync (`drive.file`), Pull-Before-Push Merge & Listener Protection

- **Status:** Accepted
- **Date:** 2026-11-20
- **Related CUJs:** [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md)

## Context
Families want to back up audiobooks to their own Google Drive and co-narrate or listen across multiple devices without handing audio files to a third-party server. Requesting broad Drive scopes (`drive`) triggers invasive Google OAuth verification and over-exposes users' private files. In multi-user family books, two parents may record chapters on different phones offline and sync later, while grandparents/kids with read-only access should be unable to accidentally mutate or break a shared book.

## Decision
Implement direct client-side Google Drive REST API v3 sync in [`src/drive/`](../src/drive/):
- **Published OAuth with narrow `drive.file` scope ([`src/drive/googleAuth.ts`](../src/drive/googleAuth.ts))**: Authenticate via Google Identity Services (`drive.file` scope only). Manage the OAuth Client ID via build-time defaults / `VITE_GOOGLE_CLIENT_ID` ([`src/storage/settings.ts`](../src/storage/settings.ts))—never expose Client ID inputs, API key inputs, or GCP setup guides in end-user UI.
- **Resumable binary uploads & structured folder layout ([`src/drive/driveClient.ts`](../src/drive/driveClient.ts))**: Store each book in its own Drive folder containing `project.json` (manifest), `cover.jpg`, and numbered audio chapters (`01 - <Chapter>.ext`) uploaded via Drive resumable upload sessions.
- **Pull-before-push conflict-safe merge ([`src/drive/syncService.ts`](../src/drive/syncService.ts))**: Always fetch and merge the remote `project.json` before pushing local changes:
  - Union chapters by `recording.id` so concurrent co-narrators never overwrite each other's chapters.
  - Propagate deletions via `deletedRecordingIds` tombstones so deleted chapters do not resurrect on the other narrator's device.
  - Preserve per-chapter `recordedBy` narrator attribution.
- **Read-only Listener enforcement (`accessRole === 'reader'`)**: Inspect Drive folder `capabilities.canAddChildren` / `canEdit` on sync/join; hide or disable record, edit, reorder, and delete controls in UI and skip all Drive write/upload/rename calls for read-only books and libraries.
- **Resilient silent sync**: Do not gate background sync on `navigator.onLine` (which reports false negatives behind proxies/VPNs); attempt silent sync when an access token is valid and fail gracefully offline.

## System Invariants
1. **Least-privilege OAuth**: Only request the `drive.file` scope; never expose GCP/OAuth developer credentials in end-user UI.
2. **Synchronous OAuth trigger**: Call `googleAuth.requestSignIn()` synchronously inside click/tap handlers so iOS standalone PWAs do not block OAuth popups.
3. **Pull-before-push + tombstones**: Remote manifests are always merged by `recording.id` with `deletedRecordingIds` before any `project.json` write.
4. **Zero writes in Listener mode**: `accessRole === 'reader'` books/libraries must never issue Drive upload, rename, or manifest mutation requests.

## Consequences & Trade-offs
- **Pros:** Zero server infrastructure, strong user privacy, safe multi-device co-narration without overwrites, clean published OAuth UX.
- **Cons:** Under `drive.file`, folders shared *by another user* cannot be accessed by raw folder ID alone until opened through Google Picker (addressed in [ADR-06](./ADR-06-shared-folder-unlock-with-google-picker.md)).
