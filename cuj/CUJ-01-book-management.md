# CUJ-01: Book Project Creation, Metadata, Cover Art, Editing & Deletion

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-01-book-management.spec.ts`](../e2e/cuj-01-book-management.spec.ts)  
**Related ADRs:** [ADR-01](../adr/ADR-01-zero-backend-offline-first-pwa.md), [ADR-02](../adr/ADR-02-indexeddb-arraybuffer-storage-and-drafts.md)

## Goal
A parent quickly creates a dedicated audiobook project with just the essentials — custom cover artwork (photo or cloth swatch), **Book Title**, **Author**, and optional **Notes** (e.g., mentioning a cold or reading style) — without clutter from manual narrator, kid name/dedication, language, or tag fields. Book narrator credits are automatically derived from recording creators (`recordedBy`). Books can be edited later or deleted cleanly.

## Preconditions
- Fresh or existing StoryTape PWA opened on a mobile viewport (`390×844`).

## User Steps & Acceptance Criteria

1. **Create First Book with Simplified Metadata & Cover Photo**
   - Tap **Create First Book** (or floating **+ New Book**).
   - Verify the book editor shows only Cover Art, **Book Title** (required), **Author**, and optional **Notes** — with no manual Narrator, Recorded For / Kid Name, Language, or Tags inputs.
   - Select a cover image via the Photo uploader (verified resized/persisted in IndexedDB `projectCovers`).
   - Fill **Book Title** (required), **Author**, and optional **Notes**.
   - Tap **Create Book**.
   - **Expected:** Navigates to `#/book/:id`, displays the uploaded cover `<img>`, title, `by <author>`, and notes. Persists cleanly across a full page reload.

2. **Auto-Derived Narrator Credit from Recording Creators**
   - Set **Default Narrator Name** in Settings (or sign in to Google Drive) and record a chapter in the book.
   - **Expected:** Book Detail automatically displays `Read by <creator>` derived from the recorded chapters' creators without any manual book-level narrator field (and combines multiple co-narrators cleanly, e.g., `Read by Dad & Mom`).

3. **Create Second Book with Cloth Cover Swatch**
   - Create a second book with just **Book Title**, **Author**, and a custom cloth cover color swatch (no photo, no notes).
   - **Expected:** Renders the styled typographic cloth cover cleanly.

4. **Edit Book Metadata & Remove Cover Photo**
   - From Book Detail, tap **Edit**.
   - Update the title, author, and notes; tap **Remove** on the cover photo and choose a cloth cover swatch.
   - Tap **Save Changes**.
   - **Expected:** Book Detail updates immediately with the cloth cover and edited metadata, surviving reload.

5. **Delete Book with Confirmation**
   - Open **Edit**, tap **Delete Book**, then **Confirm Delete**.
   - **Expected:** Book and its local cover/recordings are removed from IndexedDB and the user returns to the Library without the deleted book.
