# StoryTape — Architectural Decision Records (ADRs)

This folder records the enduring architectural decisions and **system invariants** that StoryTape upholds.

- **ADRs (`adr/`)** document *how* the system is structured and *which technical invariants must hold* (storage contracts, audio pipeline, rendering performance, sync merge rules, OAuth scope, testing parity).
- **CUJs ([`cuj/`](../cuj/README.md))** document *what* users experience and verify end-to-end user-facing behavior.

See [`AGENTS.md`](../AGENTS.md) for guidance on when to write/update a CUJ vs. an ADR.

## ADR Registry

| ID | Decision | Status | Related CUJs |
| --- | --- | --- | --- |
| [ADR-01](./ADR-01-zero-backend-offline-first-pwa.md) | Zero-Backend Offline-First Subpath PWA & Install Experience | Accepted | [CUJ-01](../cuj/CUJ-01-book-management.md), [CUJ-06](../cuj/CUJ-06-library-browsing-themes.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md) |
| [ADR-02](./ADR-02-indexeddb-arraybuffer-storage-and-drafts.md) | IndexedDB `ArrayBuffer` Binary Storage & Crash-Safe Draft Persistence | Accepted | [CUJ-01](../cuj/CUJ-01-book-management.md), [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-04](../cuj/CUJ-04-chapter-management.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-10](../cuj/CUJ-10-local-master-export-compare.md) |
| [ADR-03](./ADR-03-off-main-thread-pcm-capture-and-timeline.md) | Off-Main-Thread `AudioWorklet` PCM Capture, Mutable Timeline & Post-Encode Pipeline | Accepted | [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-03](../cuj/CUJ-03-scrub-preview-punchin.md), [CUJ-07](../cuj/CUJ-07-quality-and-devices.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-10](../cuj/CUJ-10-local-master-export-compare.md) |
| [ADR-04](./ADR-04-decoupled-60fps-canvas-waveform.md) | Decoupled 60/120fps Canvas Waveform & Deterministic Scrub Momentum | Accepted | [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-03](../cuj/CUJ-03-scrub-preview-punchin.md) |
| [ADR-05](./ADR-05-client-side-drive-oauth-and-conflict-safe-sync.md) | Client-Side Google Drive Sync (`drive.file`), Pull-Before-Push Merge & Listener Protection | Accepted | [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md) |
| [ADR-06](./ADR-06-shared-folder-unlock-with-google-picker.md) | Multi-User Shared Folder Unlock via Google Picker & Hash Invite Links | Accepted | [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md) |
| [ADR-07](./ADR-07-vanilla-css-token-theming-and-mobile-ergonomics.md) | Vanilla CSS Semantic Tokens, Zero-Flash Theming & Mobile PWA Ergonomics | Accepted | [CUJ-05](../cuj/CUJ-05-audiobook-player.md), [CUJ-06](../cuj/CUJ-06-library-browsing-themes.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md) |
| [ADR-08](./ADR-08-persistent-player-and-media-session.md) | Persistent `PlayerContext`, On-Demand Cloud Caching & Media Session Integration | Accepted | [CUJ-05](../cuj/CUJ-05-audiobook-player.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md) |
| [ADR-09](./ADR-09-strict-local-to-ci-verification-parity.md) | Strict Local-to-CI E2E Parity, Network Fence, `4×` Slow-CPU Testing & Repo Invariants | Accepted | All CUJs ([`cuj/README.md`](../cuj/README.md)) |
| [ADR-10](./ADR-10-stateless-oauth-token-broker-cloud-run.md) | Stateless Google Cloud Run OAuth Token Broker & Resilient Zero-Infra Fallback | Accepted | [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md) |
| [ADR-11](./ADR-11-two-tier-formal-verification.md) | Two-Tier Formal Verification (Shared Specs, Explicit-State Model Checking & Z3 SMT Proofs) | Accepted | [CUJ-01](../cuj/CUJ-01-book-management.md), [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-03](../cuj/CUJ-03-scrub-preview-punchin.md), [CUJ-04](../cuj/CUJ-04-chapter-management.md), [CUJ-05](../cuj/CUJ-05-audiobook-player.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-09](../cuj/CUJ-09-multi-user-sharing.md) |
| [ADR-12](./ADR-12-history-backed-navigation-and-overlay-stack.md) | Unified Browser History Navigation, Overlay Stack & Non-Destructive Back Guard | Accepted | [CUJ-01](../cuj/CUJ-01-book-management.md), [CUJ-02](../cuj/CUJ-02-core-recording.md), [CUJ-05](../cuj/CUJ-05-audiobook-player.md), [CUJ-06](../cuj/CUJ-06-library-browsing-themes.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md), [CUJ-11](../cuj/CUJ-11-history-back-forward-navigation.md) |
