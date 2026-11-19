# CUJ-01: Book Project Creation, Metadata, Cover Art, Editing & Deletion

**Priority:** P0  
**E2E Spec:** [`e2e/cuj-01-book-management.spec.ts`](../e2e/cuj-01-book-management.spec.ts)

## Goal
A parent creates a dedicated audiobook project for a book they want to read to their daughter, attaches custom cover artwork and rich metadata (title, author, narrator, dedication, language, tags, notes), edits details later, and can delete a book when no longer needed.

## Preconditions
- Fresh or existing StoryTape PWA opened on a mobile viewport (`390×844`).

## User Steps & Acceptance Criteria

1. **Create First Book with Full Metadata & Cover Photo**
   - Tap **Create First Book** (or floating **+ New Book**).
   - Select a cover image via the Photo uploader (verified resized/persisted in IndexedDB `projectCovers`).
   - Fill **Book Title** (required), **Author**, **Read By (Narrator)**, **Recorded For**, **Language**, **Tags** (comma-separated), and **Notes / Dedication**.
   - Tap **Create Book**.
   - **Expected:** Navigates to `#/book/:id`, displays the uploaded cover `<img>`, title, author, narrator, dedication, language, tags, and description. Persists cleanly across a full page reload.

2. **Default Narrator Convenience**
   - Create a second book without re-typing narrator.
   - **Expected:** Previously entered narrator is pre-populated automatically from settings, and selecting a custom cloth cover color swatch renders a styled typographic cloth cover when no photo is uploaded.

3. **Edit Book Metadata & Remove Cover Photo**
   - From Book Detail, tap **Edit**.
   - Update the title, tags, and notes; tap **Remove** on the cover photo and choose a cloth cover swatch.
   - Tap **Save Changes**.
   - **Expected:** Book Detail updates immediately with the cloth cover and edited metadata, surviving reload.

4. **Delete Book with Confirmation**
   - Open **Edit**, tap **Delete Book**, then **Confirm Delete**.
   - **Expected:** Book and its local cover/recordings are removed from IndexedDB and the user returns to the Library without the deleted book.
