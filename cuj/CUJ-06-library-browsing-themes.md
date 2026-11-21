# CUJ-06: Audiobook Library Browsing (Search & Sort) & Quick Theme Switcher

**Priority:** P1  
**E2E Spec:** [`e2e/cuj-06-library-browsing-themes.spec.ts`](../e2e/cuj-06-library-browsing-themes.spec.ts)  
**Related ADRs:** [ADR-01](../adr/ADR-01-zero-backend-offline-first-pwa.md), [ADR-07](../adr/ADR-07-vanilla-css-token-theming-and-mobile-ergonomics.md)

## Goal
A parent with multiple recorded audiobooks quickly finds the right story by searching across book titles, authors, notes, chapter names, or recording creators, sorts the shelf, and effortlessly switches between 10 handcrafted hardware, minimalist, and developer IDE color themes (defaulting to **Pitch OLED**) via a 1-tap Theme Switcher in the Library header or in Settings.

## Preconditions
- Library contains multiple book projects with distinct titles, authors, notes, and chapter names.

## User Steps & Acceptance Criteria

1. **Search Across Books, Notes & Chapter Names**
   - Type a chapter name, author name, book title, or note into the Library search input.
   - **Expected:** Book shelf filters live to matching books only.
   - Type a query with no matches → displays **No Matching Books** with a **Show All Books** reset button.

2. **Sort Order**
   - Switch sort dropdown between `Recent`, `A–Z`, and `Newest`.
   - **Expected:** Grid reorders deterministically (`A–Z` orders books alphabetically).

3. **Quick Theme Switcher, Settings Picker & Persistence**
   - Default theme on first load is **Pitch OLED** (`data-theme="pitch-oled"`, `<meta name="theme-color" content="#000000">`).
   - Tap the **Theme** (`Palette`) icon in the Library header → **Theme Switcher** bottom sheet opens displaying all 10 curated themes (`Pitch OLED`, `Braun / Rams`, `E-Ink Paper`, `Gruvbox Hard`, `Nord Polar`, `Tokyo Night`, `Kanagawa Ink`, `Everforest`, `Rosé Pine`, `Solarized Light`) with color swatches plus `System`.
   - Tap **Braun / Rams** → `document.documentElement[data-theme]` immediately updates to `braun-light`, `<meta name="theme-color">` updates to `#ECECE8`, and preference persists across a full page reload.
   - Open Settings → switch to **Nord Polar** → `data-theme="nord"` and `#242933` persist cleanly.

4. **Mobile Viewport Integrity (`360×740` & `390×844`)**
   - Verify across Library (including all 4 header actions), Theme Switcher sheet, Settings sheet, Book Detail, full-screen Audio Player, and Recording Studio that every header control and theme card fits strictly within the viewport with zero horizontal overflow (`scrollWidth <= clientWidth`), and Recording Studio / Audio Player fit cleanly without vertical page scroll.
