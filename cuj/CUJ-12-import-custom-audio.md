# CUJ-12: Import Custom Audio Files into a Book

**Priority:** P1  
**E2E Spec:** [`e2e/cuj-12-import-custom-audio.spec.ts`](../e2e/cuj-12-import-custom-audio.spec.ts)  
**Related ADRs:** [ADR-02](../adr/ADR-02-indexeddb-arraybuffer-storage-and-drafts.md), [ADR-05](../adr/ADR-05-client-side-drive-oauth-and-conflict-safe-sync.md), [ADR-08](../adr/ADR-08-persistent-player-and-media-session.md), [ADR-12](../adr/ADR-12-history-backed-navigation-and-overlay-stack.md)

## Goal
A parent or narrator imports previously recorded audio files (such as Voice Memos, `.mp3`, `.m4a`/`.m4b`, `.wav`, `.webm`, `.ogg`, `.flac`, or `.aac` chapters) from their device directly into a StoryTape book—reviewing, naming, ordering, persisting, playing, and syncing them seamlessly alongside studio recordings.

## Preconditions
- An editable book project exists (not read-only Listener mode or an un-detached imported copy).
- One or more audio files are available on the user's device.

## User Steps & Acceptance Criteria

1. **Open History-Backed Import Audio Sheet**
   - Open an editable book and tap **Import Audio** (`#import-audio-btn`) in the Chapters section header.
   - **Expected:** Opens the **Import Audio** bottom sheet (`#import-audio-sheet`) pushed onto browser history (ADR-12). Tapping **Cancel**, close (`×`), or navigating browser Back dismisses the sheet cleanly while remaining on the book detail screen.

2. **Select, Inspect, Name & Order Multiple Audio Files**
   - Select multiple audio files via the file picker (`#import-audio-file-input`) or drag-and-drop.
   - **Expected:**
     - Newly selected batch files are sorted naturally (e.g. `Chapter 2.wav` before `Chapter 10.wav`).
     - StoryTape inspects each file locally in the browser, deriving a clean default chapter name (stripping extension and leading track numbers like `01 - `), computing duration, sample rate/channels/bitrate/bit depth, and waveform overview peaks without re-encoding or degrading the original audio bytes.
     - Users can edit each chapter's title inline, adjust optional narrator attribution, reorder queued files (**Move Up** / **Move Down**), remove individual files, or add more files before confirming.

3. **Graceful Rejection of Invalid or Unsupported Files**
   - Select an empty or non-audio file (e.g. `.txt` or corrupted bytes) either alone or alongside valid audio files.
   - **Expected:** Invalid items are flagged inline with a clear error message and excluded from import. When valid files are also queued, the user can still import the valid chapters; when no valid files are queued, the primary **Import** button remains disabled.

4. **Persist Locally, Play & Survive Reload**
   - Tap **Import Chapter** / **Import N Chapters** (`#confirm-import-audio-btn`).
   - **Expected:**
     - Original audio bytes are stored in IndexedDB using `{ buffer: ArrayBuffer, type: string }` envelopes (ADR-02) with canonical audio MIME types (ADR-08).
     - The sheet closes, a confirmation toast appears, and imported chapters appear immediately in the book's chapter list in the chosen order with accurate durations and format badges.
     - Tapping an imported chapter plays smoothly in the Audiobook Player with waveform display and downloads cleanly with `01 - <Chapter Name>.<ext>`.
     - Chapters, titles, order, and audio playback survive a full page reload.

5. **Google Drive Sync & Read-Only Listener Protection**
   - When Google Drive is connected, importing audio marks chapters for sync and uploads them to the book's Drive folder with their original extension and MIME type (`01 - <Chapter Name>.<ext>`), updating `project.json`.
   - On read-only shared books (`accessRole === 'reader'`) and read-only imported copies, **Import Audio** (`#import-audio-btn`) is hidden and cannot mutate the book.
