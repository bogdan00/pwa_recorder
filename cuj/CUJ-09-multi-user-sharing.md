# CUJ-09: Multi-User Family Sharing & Collaboration

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-09-multi-user-sharing.spec.ts`](../e2e/cuj-09-multi-user-sharing.spec.ts)

## Goal
Family members can share either their entire StoryTape Family Library or an individual audiobook directly from the app via Google Drive, invite co-narrators or read-only listeners with a 1-tap guided join link, record chapters concurrently into the same shared book without losing anyone's recordings, see who narrated each chapter, and quickly share individual chapter audio files even with relatives who do not have a StoryTape or Google Drive setup.

## Preconditions
- Production PWA served under `/pwa_recorder/` with Google Drive sync configured (or mocked GIS OAuth + intercepted Drive v3 Permissions/Files API routes in E2E).
- At least one book project exists (with or without prior Drive upload).

## User Steps & Acceptance Criteria

1. **In-App Library & Book Sharing (`ShareSheet`)**
   - Open the **Share** sheet from the Library header (entire Family Library: `StoryTape Audiobooks`), Book Detail header (**Share** for a single book), or Settings.
   - If the target book or library has not been uploaded to Google Drive yet, trigger sharing.
   - **Expected:** Automatically runs a pre-sync so the Google Drive folder exists before inviting collaborators or generating a share link, without manual extra steps.
   - Invite a collaborator by Google email via the Drive Permissions API as either **Co-Narrator** (`writer`) or **Listener** (`reader`).
   - **Expected:** New collaborator appears in the active collaborators list with their email and assigned role; revoking access removes their Drive permission and updates the list immediately.
   - Toggle **"Anyone with link can listen"** (read-only link access), copy or natively share (`navigator.share`) the 1-tap StoryTape join link (`#/join?folderId=...&name=...&scope=library|book&role=...`), and tap **Open in Google Drive**.
   - **Expected:** Link-sharing toggle creates/removes the Drive `anyone` (`reader`) permission, generated join link encodes the folder ID, display name, scope (`library` or `book`), and role (without exposing any OAuth Client ID), copy/native share feedback confirms success, and the Drive folder link opens cleanly.

2. **Guided Collaborator Join Experience (`JoinShareModal` & Settings)**
   - Open a StoryTape join link (`#/join?folderId=...&name=...&scope=library|book&role=...`) as a second user.
   - **Expected:**
     - `JoinShareModal` opens automatically with zero manual credential/Client ID entry.
     - Guides the collaborator through connecting Google Drive and verifies access to the target folder.
     - When Google's `drive.file` scope requires explicit folder authorization, presents a guided Google Picker / Drive link unlock flow so access succeeds cleanly.
   - Complete joining for both scopes:
     - **Shared Library (`scope=library`):** Links the shared Drive root folder, displays a clear **Shared Library** indicator in the Library UI, pulls shared books, and offers a 1-tap control to return to the user's personal library.
     - **Shared Book (`scope=book`):** Adds the shared book alongside the user's existing personal books without replacing or disturbing their personal library.
   - Also test **Manual Join** in Settings by pasting a StoryTape invite link, a Google Drive folder URL, or a raw Drive folder ID.
   - **Expected:** Parses all three input formats accurately and links the shared library or book through the same verification flow.

3. **Conflict-Safe Multi-Narrator Sync & Attribution**
   - Two family members (e.g., Mom and Dad) record different chapters into the same shared book concurrently and sync to Google Drive.
   - **Expected:**
     - Pull-and-merge runs automatically before pushing `project.json`: chapter lists perform a chapter-level union merge by chapter ID so neither narrator's chapter is overwritten.
     - Deleted chapters record deletion tombstones (`deletedChapterIds` / tombstone metadata) so a stale device syncing later does not resurrect deleted chapters ("no zombie chapters").
     - Each chapter stores and displays per-chapter narrator attribution (`recordedBy`, e.g., `Read by Mom` / `Read by Dad`) on its chapter card in Book Detail.
   - Open a shared library or book as a collaborator with **Listener (`reader`)** access.
   - **Expected:**
     - Displays a clear **Listener** (read-only) badge on the shared book/library.
     - Listener can stream, download, and play all chapters normally.
     - Record, Edit, Reorder, and Delete controls are gracefully disabled or hidden, and sync never triggers failing write/upload requests to Google Drive.

4. **Zero-Account Quick Chapter Share**
   - From Book Detail, open a chapter's action menu and tap **Share Audio** (quick chapter share).
   - **Expected:**
     - Shares the chapter audio file directly via Web Share API (`navigator.share` with `files`) when supported by the browser/device (requiring no Google account or StoryTape login for the recipient).
     - Falls back automatically to downloading the chapter audio file when `navigator.share` with files is unavailable or unsupported.
