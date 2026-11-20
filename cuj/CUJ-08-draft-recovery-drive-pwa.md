# CUJ-08: Offline-First Crash-Safe Draft Recovery, Google Drive Two-Way Sync & Mobile PWA Subpath Integrity

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-08-draft-recovery-drive-pwa.spec.ts`](../e2e/cuj-08-draft-recovery-drive-pwa.spec.ts)

## Goal
A parent never loses an in-progress recording if the mobile OS suspends/reloads the PWA, can connect Google Drive to push book folders (`project.json`, `cover.jpg`, and chapter audio via resumable upload) and pull remote `cloud_only` books on demand, can free cached local audio for synced chapters, and gets a valid subpath PWA at `/pwa_recorder/`.

## Preconditions
- Production PWA served under GitHub Pages subpath `/pwa_recorder/`.

## User Steps & Acceptance Criteria

1. **Crash-Safe Draft Recovery**
   - Start a recording (> 2.2s so crash-safe draft chunks flush to IndexedDB), pause, leave via **Keep Draft & Leave** (or hard-reload the page mid-session).
   - Return to Library.
   - **Expected:** **Unfinished Recording Found** banner appears showing book name and duration; tapping **Resume** reopens Recording Studio in `PAUSED` state with the full recovered duration and waveform ready to continue or save!

2. **Google Drive OAuth Setup Guide & Two-Way Sync**
   - Open Settings → **Google Drive Folder**, expand **2-Minute Google Drive Setup Guide**, and verify the displayed Authorized JavaScript Origin matches `window.location.origin`.
   - Configure Client ID, connect Drive (with mocked GIS token callback & intercepted Drive v3 API routes), and tap **Sync All Now**.
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
