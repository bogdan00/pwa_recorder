# CUJ-08: Offline-First Crash-Safe Draft Recovery, Google Drive Two-Way Sync, PWA Install Prompt & Subpath Integrity

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-08-draft-recovery-drive-pwa.spec.ts`](../e2e/cuj-08-draft-recovery-drive-pwa.spec.ts)

## Goal
A parent never loses an in-progress recording if the mobile OS suspends/reloads the PWA, can connect Google Drive to push book folders (`project.json`, `cover.jpg`, and chapter audio via resumable upload) and pull remote `cloud_only` books on demand, can free cached local audio for synced chapters, gets a clear non-intrusive prompt to install StoryTape to their Home Screen (both native `beforeinstallprompt` on Android/Desktop Chromium and guided Add to Home Screen on iOS Safari), and gets a valid subpath PWA at `/pwa_recorder/`.

## Preconditions
- Production PWA served under GitHub Pages subpath `/pwa_recorder/`.

## User Steps & Acceptance Criteria

1. **Crash-Safe Draft Recovery**
   - Start a recording (> 2.2s so crash-safe draft chunks flush to IndexedDB), pause, leave via **Keep Draft & Leave** (or hard-reload the page mid-session).
   - Return to Library.
   - **Expected:** **Unfinished Recording Found** banner appears showing book name and duration; tapping **Resume** reopens Recording Studio in `PAUSED` state with the full recovered duration and waveform ready to continue or save!

2. **Google Drive Sign-In & Two-Way Sync**
   - Open Settings → **Google Drive Folder** (no manual Client ID or GCP setup guide shown), tap **Connect Google Drive** (with mocked GIS token callback & intercepted Drive v3 API routes), and verify automatic sync.
   - **Expected:**
     - Local book folder, `cover.jpg` (if present), `01 - <Chapter>.ext` (resumable upload), and `project.json` are pushed to Drive, flipping local book & chapter sync badges to `Synced`.
     - A remote book present in Drive is pulled into the Library with its chapter marked `cloud_only`.
     - Tapping Play on the `cloud_only` chapter downloads it on demand from Drive, caches it into IndexedDB, and opens playback.
     - *See also [CUJ-09](./CUJ-09-multi-user-sharing.md) for multi-user family sharing, Google Drive collaborator permissions, conflict-safe co-narration merge, and read-only Listener mode.*

3. **Free Synced Local Audio Cache**
   - In Settings → **Free Cached Audio for Synced Chapters**, tap the button.
   - **Expected:** Removes local audio blobs for already-synced chapters (flipping them to `cloud_only`) while preserving unsynced local recordings untouched.

4. **GitHub Pages Subpath PWA & OAuth Branding Pages**
   - Verify `/pwa_recorder/manifest.webmanifest` (`start_url`, `scope`, `id` = `/pwa_recorder/`, `display` = `standalone`, icons `192`/`512`/`maskable`).
   - Verify `/pwa_recorder/audio/pcm-capture-worklet.js`, `/pwa_recorder/icons/apple-touch-icon.png`, `/pwa_recorder/privacy.html`, and `/pwa_recorder/terms.html` all return HTTP `200`.

5. **In-App PWA Install Prompt (Chromium & iOS Safari)**
   - **Android / Desktop Chromium (`beforeinstallprompt`)**:
     - When the browser fires `beforeinstallprompt` outside standalone mode, the Library displays a warm **Install StoryTape** banner with **Install** and a dismiss (`×`) button.
     - Dismissing the banner hides it and persists dismissal across page reloads (`localStorage`), while **Install StoryTape** remains available anytime inside **Settings → Appearance & Defaults**.
     - Tapping **Install** triggers the native browser prompt (`event.prompt()`); accepting (or receiving `appinstalled`) hides the install banner, displays a confirmation toast, and updates Settings to show **Installed on this device**.
   - **iOS / iPadOS Safari**:
     - When opened on iPhone/iPad outside standalone mode (`navigator.standalone !== true`), the Library shows the **Install StoryTape** banner with **How to Install**.
     - Tapping **How to Install** (from the banner or Settings) opens a 2-step **Install on iPhone / iPad** guide explaining **Share** → **Add to Home Screen**.
   - **Already Installed (`standalone` mode)**:
     - Neither banner appears when running in standalone mode.
