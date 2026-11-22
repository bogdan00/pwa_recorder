# CUJ-10: Local Lossless Master Archival, Multi-Bitrate Export & Quality Lab (Blind A/B Threshold Finder)

**Priority:** P1  
**E2E Spec:** [`e2e/cuj-10-local-master-export-compare.spec.ts`](../e2e/cuj-10-local-master-export-compare.spec.ts)  
**Related ADRs:** [ADR-02](../adr/ADR-02-indexeddb-arraybuffer-storage-and-drafts.md), [ADR-03](../adr/ADR-03-off-main-thread-pcm-capture-and-timeline.md)

## Goal
A parent can opt in to saving an uncompressed, full-detail local lossless master (32-bit IEEE Float WAV at raw capture sample rate) alongside each chapter without bloating Google Drive sync, then open the dedicated **Quality Lab** screen to run a guided **blind A/B quality threshold test**, compare Master vs. compressed audio side-by-side with exact file sizes, apply their discovered sweet-spot bitrate directly to Studio Settings, export single or batch comparison audio files at distinct bitrates/formats, and delete local masters later to reclaim device storage.

## Preconditions
- StoryTape PWA opened; user has created a book project.

## User Steps & Acceptance Criteria

1. **Opt-In Local Lossless Master Recording (Settings + Save Sheet)**
   - Open **Studio Settings → Recording → Recording Quality** and enable **Save Local Lossless Master**.
   - Close settings, open Recording Studio, record a chapter, tap **Stop**, and verify the Save sheet shows the **Keep local lossless master (32-bit Float WAV)** option enabled.
   - Save the chapter.
   - **Expected:** The chapter card displays its normal compressed spec (for playback & Drive sync) PLUS a `Master` badge, and IndexedDB stores both the regular chapter blob (`recordingBlobs`) and the uncompressed 32-bit IEEE Float WAV (`formatTag === 3`, `bitDepth === 32`) in `recordingMasters`.

2. **Quality Lab — Guided Blind A/B Threshold Finder**
   - Open the chapter menu (`⋮`) → **Export & Quality Lab** (navigates to `#/book/:projectId/compare/:recordingId`).
   - Verify the **Find Threshold** tab loads the lossless master summary, bitrate ladder (`32k`–`320k`), blind **Sample A** / **Sample B** toggle buttons, and a playback progress bar (without a separate redundant play/pause button).
   - Tap **Sample A** to start playback from `00:00` (its button switches to **Pause**), tap it again to pause and resume in place, and tap **Sample B** while Sample A is playing (or paused) to stop Sample A and play Sample B from `00:00` (Sample A returns to **Play** while Sample B switches to **Pause**).
   - Run a blind comparison at a low bitrate and at a higher bitrate, recording verdicts (**Sample A sounds better**, **Sample B sounds better**, or **Can't tell / Same**).
   - **Expected:** Each verdict reveals which sample was Master vs. Compressed, updates the threshold ladder with exact encoded file size and `% smaller` savings, and once a transparent bitrate is reached, displays a **Recommended Sweet Spot** card with a 1-tap **Apply to Recording Settings** button that updates Studio Settings.

3. **Quality Lab — Open Side-by-Side A/B & Single / Batch Export**
   - Switch to **Side-by-Side A/B**, pick a target format/bitrate/sample rate, verify exact encoded size & compression ratio against the Master, and toggle **Master** / **Export** playback (each sample button turns into **Pause** while playing, and tapping the other sample stops the active one and replays the newly selected sample from the start).
   - Switch to **Export Files**, encode a single custom bitrate or select multiple bitrates in **Batch Comparison Set** and run **Encode Comparison Set**.
   - **Expected:** Every selected tier encodes from the lossless master, reports exact bytes and `% smaller`, and provides labeled file downloads (e.g. `01_Chapter_1_64kbps_48kHz.m4a` / `.webm` / `.wav`).

4. **Local Master Storage Reclamation (with Confirmation)**
   - Tap **Free Master** in Quality Lab, **Delete Local Master** in the chapter menu, or **Delete Local Masters** in **Studio Settings → App → Storage & App**, and confirm in the dialog.
   - **Expected:** Prompts for confirmation first (Cancel keeps the master intact); on confirm, deletes the `recordingMasters` entry and removes the `Master` badge while the regular chapter recording remains intact and playable.

5. **Settings Test Mic → Quality Lab (Standalone Mic Benchmark)**
   - Open **Studio Settings → Recording → Recording Device**, select a microphone, tap **Test Mic** to capture a brief test sample, tap **Stop Test**, and tap **Open in A/B Lab** (navigates to `#/quality-lab/mic-test`).
   - **Expected:** Quality Lab opens directly with the uncompressed 32-bit IEEE Float WAV mic test clip pre-loaded (without creating any book or chapter), supports recording new test clips directly inside Quality Lab using the selected Settings microphone, and runs the full **Threshold** blind A/B finder, **A/B Listen**, and **Export** flows with 1-tap **Apply to Recording Settings**.
