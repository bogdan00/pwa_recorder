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
   - Open **Studio Settings → Recording Quality** and enable **Save Local Lossless Master**.
   - Close settings, open Recording Studio, record a chapter, tap **Stop**, and verify the Save sheet shows the **Keep local lossless master (32-bit Float WAV)** option enabled.
   - Save the chapter.
   - **Expected:** The chapter card displays its normal compressed spec (for playback & Drive sync) PLUS a `Master` badge, and IndexedDB stores both the regular chapter blob (`recordingBlobs`) and the uncompressed 32-bit IEEE Float WAV (`formatTag === 3`, `bitDepth === 32`) in `recordingMasters`.

2. **Quality Lab — Guided Blind A/B Threshold Finder**
   - Open the chapter menu (`⋮`) → **Export & Quality Lab** (navigates to `#/book/:projectId/compare/:recordingId`).
   - Verify the **Find Threshold** tab loads the lossless master summary, bitrate ladder (`32k`–`320k`), and blind **Sample A** / **Sample B** playback buttons.
   - Run a blind comparison at a low bitrate and at a higher bitrate, recording verdicts (**Sample A sounds better**, **Sample B sounds better**, or **Can't tell / Same**).
   - **Expected:** Each verdict reveals which sample was Master vs. Compressed, updates the threshold ladder with exact encoded file size and `% smaller` savings, and once a transparent bitrate is reached, displays a **Recommended Sweet Spot** card with a 1-tap **Apply to Recording Settings** button that updates Studio Settings.

3. **Quality Lab — Open Side-by-Side A/B & Single / Batch Export**
   - Switch to **Side-by-Side A/B**, pick a target format/bitrate/sample rate, verify exact encoded size & compression ratio against the Master, and toggle synchronized **Master ↔ Export** playback.
   - Switch to **Export Files**, encode a single custom bitrate or select multiple bitrates in **Batch Comparison Set** and run **Encode Comparison Set**.
   - **Expected:** Every selected tier encodes from the lossless master, reports exact bytes and `% smaller`, and provides labeled file downloads (e.g. `01_Chapter_1_64kbps_48kHz.m4a` / `.webm` / `.wav`).

4. **Local Master Storage Reclamation**
   - Delete a chapter's local master from Quality Lab (or **Studio Settings → Delete Local Masters**).
   - **Expected:** The `recordingMasters` entry is deleted and the `Master` badge disappears while the regular chapter recording remains intact and playable.
