# StoryTape — Customer User Journeys (CUJs)

This folder defines every end-to-end **Customer User Journey (CUJ)** built into StoryTape. Each CUJ maps 1-to-1 to an automated Playwright E2E specification in [`e2e/`](../e2e/) that runs in parallel against the production PWA bundle (`/pwa_recorder/`) at mobile phone viewport (`390×844`) before every push via the `.githooks/pre-push` gate and in GitHub Actions.

## CUJ Matrix

| ID | User Journey | Priority | E2E Specification |
| --- | --- | --- | --- |
| [CUJ-01](./CUJ-01-book-management.md) | Book Project Creation, Metadata, Cover Art, Editing & Deletion | P0 | [`e2e/cuj-01-book-management.spec.ts`](../e2e/cuj-01-book-management.spec.ts) |
| [CUJ-02](./CUJ-02-core-recording.md) | Core Audio Recording: Start, Live Waveform, Pause, Safe Resume & Stop Name Prompt | P0 | [`e2e/cuj-02-core-recording.spec.ts`](../e2e/cuj-02-core-recording.spec.ts) |
| [CUJ-03](./CUJ-03-scrub-preview-punchin.md) | Paused Waveform Drag-to-Scrub, Preview Playback, Punch-In Re-Recording & Undo | P0 | [`e2e/cuj-03-scrub-preview-punchin.spec.ts`](../e2e/cuj-03-scrub-preview-punchin.spec.ts) |
| [CUJ-04](./CUJ-04-chapter-management.md) | Chapter Management: Rename, Reorder, Download Audio & Delete | P1 | [`e2e/cuj-04-chapter-management.spec.ts`](../e2e/cuj-04-chapter-management.spec.ts) |
| [CUJ-05](./CUJ-05-audiobook-player.md) | Minimalistic Audiobook Player, Mini-Player, Speed, Sleep Timer & Continue Listening | P0 | [`e2e/cuj-05-audiobook-player.spec.ts`](../e2e/cuj-05-audiobook-player.spec.ts) |
| [CUJ-06](./CUJ-06-library-browsing-themes.md) | Audiobook Library Browsing (Search, Tags, Sort) & Warm Night / Warm Paper Themes | P1 | [`e2e/cuj-06-library-browsing-themes.spec.ts`](../e2e/cuj-06-library-browsing-themes.spec.ts) |
| [CUJ-07](./CUJ-07-quality-and-devices.md) | Studio Audio Quality (Presets, Bitrate, Sample Rate, WAV Export) & Microphone Selection | P0 | [`e2e/cuj-07-quality-and-devices.spec.ts`](../e2e/cuj-07-quality-and-devices.spec.ts) |
| [CUJ-08](./CUJ-08-draft-recovery-drive-pwa.md) | Crash-Safe Draft Recovery, Google Drive Two-Way Sync & Mobile PWA Subpath Integrity | P0 | [`e2e/cuj-08-draft-recovery-drive-pwa.spec.ts`](../e2e/cuj-08-draft-recovery-drive-pwa.spec.ts) |

## Running All CUJ E2E Tests

```bash
npm run build && npm run test:e2e
```

All CUJ specs execute in parallel across isolated browser contexts using real Web Audio (`AudioWorklet`), real IndexedDB persistence, real canvas pointer gestures, and intercepted Google Drive REST API v3 endpoints.
