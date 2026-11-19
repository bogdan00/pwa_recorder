# CUJ-04: Chapter Management — Rename, Reorder, Download Audio & Delete

**Priority:** P1  
**E2E Spec:** [`e2e/cuj-04-chapter-management.spec.ts`](../e2e/cuj-04-chapter-management.spec.ts)

## Goal
A parent organizes recorded chapters within a book: renaming chapters inline, reordering chapters into book order, downloading a local audio file copy to their device, and deleting unwanted recordings.

## Preconditions
- A book project contains at least two saved chapters.

## User Steps & Acceptance Criteria

1. **Inline Rename Chapter**
   - Open the `⋮` overflow menu on Chapter 1 and select **Rename**.
   - Type a new title and tap **Save**.
   - **Expected:** Chapter title updates immediately and persists across page reload.

2. **Reorder Chapters (Move Up / Move Down)**
   - Open `⋮` menu on Chapter 1 and tap **Move Down** (or Chapter 2 → **Move Up**).
   - **Expected:** Chapter order swaps immediately, track numbers `01`/`02` update, and new order persists after reload.

3. **Download Local Audio Copy**
   - Open `⋮` menu and tap **Download Audio**.
   - **Expected:** Triggers a browser file download named `01 - <Chapter Name>.<ext>` with non-zero audio bytes.

4. **Delete Chapter**
   - Open `⋮` menu and tap **Delete**.
   - **Expected:** Removes the recording and its audio blob from IndexedDB, updates chapter count summary, and persists after reload.
