# ADR-05: Client-Side Google Drive Sync (`drive`), Pull-Before-Push Merge & Listener Protection

- **Status:** Accepted (Amended 2026-11-22: upgraded OAuth scope from `drive.file` to `drive`)
- **Date:** 2026-11-20
- **Related CUJs:** [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md)

## Context
Families want to back up audiobooks to their own Google Drive and co-narrate or listen across multiple devices without handing audio files to a third-party server. StoryTape originally attempted Google's narrow `drive.file` scope, but production testing proved that Google Drive enforces `drive.file` strictly **per-user and per-file (non-recursive on folders)**: even when Parent A shares a StoryTape folder with Parent B as Editor and Parent B selects the folder via Google Picker, Drive API v3 returns `children: []` for all book subfolders, `project.json` manifests, and audio files created by Parent A's account. In multi-user family books, two parents must be able to read and merge each other's chapters recursively inside shared folders, while read-only Listeners must remain unable to accidentally mutate or break a shared book.

## Decision
Implement direct client-side Google Drive REST API v3 sync in [`src/drive/`](../src/drive/):
- **Client-side OAuth with full `drive` scope, automatic scope migration & persistent session ([`src/drive/googleAuth.ts`](../src/drive/googleAuth.ts))**: Authenticate via Google Identity Services using `https://www.googleapis.com/auth/drive` so collaborators can recursively list, read, copy, and co-narrate books inside shared Drive folders without per-file Picker walls. Manage the OAuth Client ID via build-time defaults / `VITE_GOOGLE_CLIENT_ID` ([`src/storage/settings.ts`](../src/storage/settings.ts))—never expose Client ID inputs, API key inputs, or GCP setup guides in end-user UI. Persist the active OAuth access token, expiry, `grantedScope`, and remembered account metadata (`userEmail`, `userName`, `wasConnected`) in `localStorage` (`storytape.googleAuth.v1`, migrating any legacy `sessionStorage` entry). If a persisted session was minted under a legacy narrower scope (`drive.file` or missing `grantedScope`), automatically transition to `'expired'` with a one-time consent upgrade (`prompt: 'consent'`) so devices cleanly upgrade to `drive` without getting stuck refreshing an old narrow token. When a `drive`-scoped access token expires, retain `wasConnected: true` and pass explicit `{ prompt: '', login_hint: userEmail }` for 1-tap reconnect.
- **Resumable binary uploads & structured folder layout ([`src/drive/driveClient.ts`](../src/drive/driveClient.ts))**: Store each book in its own Drive folder containing `project.json` (manifest), `cover.jpg`, and numbered audio chapters (`01 - <Chapter>.ext`) uploaded via Drive resumable upload sessions.
- **Pull-before-push conflict-safe merge ([`src/drive/syncService.ts`](../src/drive/syncService.ts))**: Always fetch and merge the remote `project.json` before pushing local changes:
  - Union chapters by `recording.id` so concurrent co-narrators never overwrite each other's chapters.
  - Propagate deletions via `deletedRecordingIds` tombstones so deleted chapters do not resurrect on the other narrator's device.
  - Preserve per-chapter `recordedBy` narrator attribution.
- **Read-only Listener enforcement (`accessRole === 'reader'`)**: Inspect Drive folder `capabilities.canAddChildren` / `canEdit` on sync/join; hide or disable record, edit, reorder, and delete controls in UI and skip all Drive write/upload/rename calls for read-only books and libraries.
- **Resilient silent sync**: Do not gate background sync on `navigator.onLine` (which reports false negatives behind proxies/VPNs); attempt silent sync when an access token is valid and fail gracefully offline.

## System Invariants
1. **Clean OAuth credential boundary**: Request `https://www.googleapis.com/auth/drive` and never expose GCP/OAuth developer credentials in end-user UI; automatically upgrade persisted sessions minted under legacy `drive.file` scope.
2. **Synchronous OAuth trigger**: Call `googleAuth.requestSignIn()` synchronously inside click/tap handlers so iOS standalone PWAs do not block OAuth popups.
3. **PWA-update-safe auth persistence & fast reconnect**: Persist Drive auth sessions, `grantedScope`, and remembered account hints in `localStorage` (never ephemeral `sessionStorage`), pass explicit `prompt: ''` + `login_hint` on normal reconnects (using `prompt: 'consent'` only on scope upgrade), and clear persisted auth state only on explicit `signOut()`.
4. **Pull-before-push + tombstones**: Remote manifests are always merged by `recording.id` with `deletedRecordingIds` before any `project.json` write.
5. **Zero writes in Listener mode**: `accessRole === 'reader'` books/libraries must never issue Drive upload, rename, or manifest mutation requests.

## Consequences & Trade-offs
- **Pros:** Zero user-data server infrastructure, true recursive multi-user shared folder visibility (eliminating empty `children: []` folders between family members), instant link-based joining without mandatory per-file Picker prompts, seamless silent multi-day refresh when paired with the stateless Cloud Run OAuth broker ([ADR-10](./ADR-10-stateless-oauth-token-broker-cloud-run.md)), and automatic one-time scope upgrade for existing devices.
- **Cons:** `https://www.googleapis.com/auth/drive` is a Google restricted scope; for private family/friends deployments without paid CASA verification, first-time users accept Google's standard unverified-app consent prompt once. Without the optional Cloud Run OAuth broker ([ADR-10](./ADR-10-stateless-oauth-token-broker-cloud-run.md)), browser GIS tokens expire after ~1 hour and require a 1-tap reconnect.
