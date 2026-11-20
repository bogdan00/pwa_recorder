# ADR-06: Multi-User Shared Folder Unlock via Google Picker & Hash Invite Links

- **Status:** Accepted
- **Date:** 2026-11-20
- **Related CUJs:** [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md)

## Context
Under Google Drive's narrow `drive.file` OAuth scope ([ADR-05](./ADR-05-client-side-drive-oauth-and-conflict-safe-sync.md)), an app can only access files and folders that *the app itself created for the signed-in user* or that *the user explicitly selects via Google Picker*. When Parent A shares a StoryTape book or family library folder with Parent B or a grandparent, Parent B's StoryTape instance receives a `404` from Drive REST API v3 if it queries the shared folder ID directly—even when Parent B already has Google Drive permission on that folder.

## Decision
Keep the narrow `drive.file` scope (avoiding sensitive full-Drive verification) and build an end-to-end guided sharing & unlock flow without a backend:
- **In-app Drive Permissions management ([`src/components/ShareSheet.tsx`](../src/components/ShareSheet.tsx), [`src/drive/driveClient.ts`](../src/drive/driveClient.ts))**: Allow hosts to invite collaborators by email (`writer` for Co-Narrators, `reader` for Listeners), toggle "Anyone with the link" read-only sharing, and revoke permissions directly via Drive Permissions API v3.
- **Stateless hash invite links ([`src/drive/shareUtils.ts`](../src/drive/shareUtils.ts))**: Encode share metadata (`folder`, `scope` = `book` | `library`, `title`, `role`) into `#/join?...` hash URLs compatible with static GitHub Pages subpath hosting, copyable to clipboard or shareable via the Web Share API.
- **Lazy-loaded Google Picker unlock ([`src/drive/googlePicker.ts`](../src/drive/googlePicker.ts), [`src/components/JoinShareModal.tsx`](../src/components/JoinShareModal.tsx))**: When joining a shared folder returns `404` under `drive.file`, guide the recipient through a 1-tap Google Picker ("Shared with me" / folders view) which grants StoryTape `drive.file` access to that exact folder tree, then immediately re-inspects folder capabilities and syncs.
- **Quick single-chapter sharing**: Support native Web Share API (`navigator.share({ files })` with download fallback) so families can also send individual chapters directly over messaging apps without requiring Google Drive sign-in.

## System Invariants
1. **Never escalate beyond `drive.file` scope** to make shared folders work; rely on Google Picker folder selection for explicit user consent.
2. **Invite links remain stateless and subpath-safe** (`#/join?...`), and automatically clear `#/join` from the URL hash after joining or dismissing so reloads do not re-trigger the join modal.
3. **Graceful non-Picker fallback**: Direct folder URL/ID paste in Settings remains supported when permissions are already unlocked.

## Consequences & Trade-offs
- **Pros:** Preserves least-privilege OAuth posture, zero backend invite broker, works for both single shared books and whole shared family libraries.
- **Cons:** First-time recipients of a shared Drive folder perform one extra tap in Google Picker to unlock `drive.file` access for that folder.
