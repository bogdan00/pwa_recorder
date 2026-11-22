# CUJ-09: Multi-User Family Sharing & Collaboration

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-09-multi-user-sharing.spec.ts`](../e2e/cuj-09-multi-user-sharing.spec.ts)  
**Related ADRs:** [ADR-05](../adr/ADR-05-client-side-drive-oauth-and-conflict-safe-sync.md), [ADR-06](../adr/ADR-06-shared-folder-unlock-with-google-picker.md), [ADR-08](../adr/ADR-08-persistent-player-and-media-session.md), [ADR-09](../adr/ADR-09-strict-local-to-ci-verification-parity.md)

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
   - **Expected:** New collaborator appears in the active collaborators list with their email and assigned role; revoking access prompts for confirmation before removing their Drive permission and updating the list immediately.
   - When pending Google Drive access requests (`accessproposals`) exist on the folder, review them in **Pending Access Requests** inside `ShareSheet` and approve (as **Listener** or **Co-Narrator**) or deny them.
   - **Expected:** Approving resolves the proposal via Drive API v3 (`ACCEPT`), removes it from the pending list, and refreshes **People with Access** with the new collaborator; denying resolves with `DENY` and removes it from the pending list.
   - Toggle **"Anyone with link can listen"** (read-only link access), copy or natively share (`navigator.share`) the 1-tap StoryTape join link (`#/join?folderId=...&name=...&scope=library|book&role=...`), and tap **Open in Google Drive**.
   - **Expected:** Link-sharing toggle creates/removes the Drive `anyone` (`reader`) permission, generated join link encodes the folder ID, display name, scope (`library` or `book`), and role (without exposing any OAuth Client ID), the invite link preview wraps cleanly across multiple lines without cropping or horizontal scrolling (so tapping, focusing, or swiping never scrolls the text out of view into an empty-looking input), copy/native share feedback confirms success, and the Drive folder link opens cleanly.

2. **Guided Collaborator Join Experience (`JoinShareModal` & Settings)**
   - Open a StoryTape join link (`#/join?folderId=...&name=...&scope=library|book&role=...`) as a second user.
   - **Expected:**
     - `JoinShareModal` opens automatically with zero manual credential/Client ID entry.
     - Guides the collaborator through connecting Google Drive (using the `drive` scope so joining a shared folder recursively sees all book subfolders, `project.json` manifests, covers, and chapters created by any collaborator, with automatic one-time reconnect prompt for devices upgrading from legacy `drive.file` tokens) and verifies access to the target folder.
     - If the recipient does not yet have Drive permission on the folder (or needs to browse Drive folders), presents both:
       1. A **Pick Shared Folder in Google Drive** (Google Picker) fallback, and
       2. An explicit **Request Access in Google Drive** action opening the folder URL directly in Google Drive (where Google's native *"Request access"* screen notifies the owner, since Drive API v3 does not allow programmatic access proposal creation) paired with a retry control once approved.
   - Complete joining for both scopes:
     - **Shared Library (`scope=library`):**
       - Links the shared Drive root folder, displays a dismissible **Shared Library** banner in the Library UI (whose **Manage** button opens **Studio Settings** directly to the **Drive** tab, and whose **Dismiss** (`×`) button hides the banner persistently across reloads until switching back to personal or joining another shared library), switches the Library header share button to an accented collaborators icon (`Users` instead of the default `Share2` icon) while shared/co-narrator mode is active, pulls all shared books recursively, and offers a confirmed control to return to the user's personal library.
       - When joining a writable (`writer`) shared library while already having unshared personal books on the device, explicitly asks whether to also share those previous books into the joined shared library (via a default-enabled opt-in checkbox in `JoinShareModal` or a confirmation dialog when joining from Settings).
       - If opted in, copies those existing books (cover, chapter audio, and `project.json`) into subfolders of the shared library root so all collaborators see them immediately while leaving any original private Drive folders untouched; if declined, keeps unshared personal books private and never silently uploads them during routine syncs.
       - When already connected to a writable shared library with remaining unshared personal books on the device, **Studio Settings → Drive** also exposes a confirmed 1-tap **Share Personal Book(s) to Library** action.
     - **Shared Book (`scope=book`):**
       - When joining a **Listener (`reader`)** book into a writable personal or family library, defaults to **Import Copy to My Library** (with a 2-option toggle to pick **Link Live (No Copy)** instead; automatically falls back to **Link Live** when the active library is read-only).
       - Importing copies the book's cover and chapters into a real subfolder of the user's Drive library (preserving narrator attribution and recording `importedFrom` source metadata), making the book automatically visible to everyone sharing the user's Family Library without requiring extra invites or Google Picker taps from family members.
       - Opening StoryTape or tapping **Check Updates** on an imported book mirrors newly added/updated chapters and upstream chapter deletions from the source folder into the user's library copy (and therefore to family co-narrators) while never writing to the source folder.
       - Non-importer family members syncing the shared Family Library silently skip upstream source checks and play the copied chapters directly.
       - If the upstream source folder is later revoked or deleted (`403`/`404`), sync succeeds gracefully, marks the source unavailable, and preserves the copied book and all chapters intact.
       - Imported books display an **Imported** badge and Listen-only controls until the user confirms **Make Editable (Detach)** (clearing `importedFrom` and unlocking recording/editing) or **Remove Copy** (removing the copy locally and trashing the copied Drive folder without touching the original creator's book).
       - When linking live (`Link Live`, default for **Co-Narrator (`writer`)** single-book invites), adds the shared book alongside the user's existing personal books without replacing or disturbing their personal library (unlinking prompts for confirmation).
   - Also test **Manual Join** in **Studio Settings → Drive** by pasting a StoryTape invite link, a Google Drive folder URL, or a raw Drive folder ID.
   - **Expected:** Parses all three input formats accurately, links or imports the shared library or book through the same verification flow (prompting to share existing personal books when joining a writable shared library), and renders the input at `>= 16px` (with `touch-action: manipulation`) so tapping or pasting on iPhone never triggers iOS Safari auto-zoom.

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

4. **Zero-Account Quick Chapter Share & Sync Diagnostics Export**
   - From Book Detail, open a chapter's action menu and tap **Share Audio** (quick chapter share).
   - **Expected:**
     - Shares the chapter audio file directly via Web Share API (`navigator.share` with `files`) when supported by the browser/device (requiring no Google account or StoryTape login for the recipient).
     - Falls back automatically to downloading the chapter audio file when `navigator.share` with files is unavailable or unsupported.
   - From Settings → **Debug** tab → **Sync & Sharing Diagnostics**, tap **Copy Debug JSON** or **Share / Save JSON**.
   - **Expected:**
     - Generates a redacted JSON report (zero OAuth tokens or API keys) containing app/auth metadata, Drive folder settings, local IndexedDB books/recordings, a live Google Drive visibility probe, and the persistent API/sync trace log.
