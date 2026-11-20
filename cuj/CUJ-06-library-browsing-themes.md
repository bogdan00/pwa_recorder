# CUJ-06: Audiobook Library Browsing (Search, Tags, Sort) & Warm Night / Warm Paper Themes

**Priority:** P1  
**E2E Spec:** [`e2e/cuj-06-library-browsing-themes.spec.ts`](../e2e/cuj-06-library-browsing-themes.spec.ts)  
**Related ADRs:** [ADR-01](../adr/ADR-01-zero-backend-offline-first-pwa.md), [ADR-07](../adr/ADR-07-vanilla-css-token-theming-and-mobile-ergonomics.md)

## Goal
A parent with multiple recorded audiobooks quickly finds the right story by searching across titles, authors, narrators, tags, or chapter names, filters by tag chips, sorts the shelf, and switches between low-glare Warm Night (bedtime) and Warm Paper (daytime) themes.

## Preconditions
- Library contains multiple book projects with distinct titles, authors, tags, and chapter names.

## User Steps & Acceptance Criteria

1. **Search Across Books & Chapter Names**
   - Type a chapter name, author name, or book title into the Library search input.
   - **Expected:** Book shelf filters live to matching books only.
   - Type a query with no matches → displays **No Matching Books** with a **Show All Books** reset button.

2. **Tag Filter Chips**
   - Tap a tag pill (e.g., `Bedtime`).
   - **Expected:** Only books carrying that tag remain visible; tapping **All Books** restores the full shelf.

3. **Sort Order**
   - Switch sort dropdown between `Recent`, `A–Z`, and `Newest`.
   - **Expected:** Grid reorders deterministically (`A–Z` orders books alphabetically).

4. **Warm Night / Warm Paper Theme Switching & Persistence**
   - Open Settings → select **Warm Paper**.
   - **Expected:** `document.documentElement[data-theme]` becomes `light`, `<meta name="theme-color">` updates to `#F8F3EC`, and preference persists across a full page reload.
   - Switch back to **Warm Night** → `data-theme="dark"` and `#161311`.
