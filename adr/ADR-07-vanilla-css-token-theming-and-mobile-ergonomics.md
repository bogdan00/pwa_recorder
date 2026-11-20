# ADR-07: Vanilla CSS Semantic Tokens, Zero-Flash Theming & Mobile PWA Ergonomics

- **Status:** Accepted
- **Date:** 2026-11-19
- **Related CUJs:** [CUJ-05](../cuj/CUJ-05-audiobook-player.md), [CUJ-06](../cuj/CUJ-06-library-browsing-themes.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md)

## Context
StoryTape is designed for cozy nighttime recording and bedtime listening on phones (`390×844` mobile viewports, iOS standalone safe areas, and one-handed thumb controls). Adding a utility CSS framework or CSS-in-JS runtime introduces unnecessary build complexity, bundle overhead, and runtime style recalculation—especially undesirable alongside 60fps canvas rendering.

## Decision
Standardize on **co-located Vanilla CSS stylesheets backed by semantic CSS custom properties** and a canonical registry of **10 curated non-AI-slop themes** ([`src/styles/themes.ts`](../src/styles/themes.ts)):
- **One-file-per-theme design token architecture**: Keep theme-independent structural tokens (typography, radii, spacing, safe areas, motion) in [`src/styles/tokens.css`](../src/styles/tokens.css), and isolate each color palette in its own dedicated stylesheet under `src/styles/themes/<id>.css` (`@import`ed by `tokens.css`, verified 1-to-1 by [`src/__tests__/repoInvariants.test.ts`](../src/__tests__/repoInvariants.test.ts)). Shared layout/component primitives (`.sheet-backdrop`, `.sheet-panel`, `.btn`, `.icon-btn`) live in [`src/styles/global.css`](../src/styles/global.css). Keep ambient radial background glows disabled (`transparent`) so surfaces stay crisp and intentional.
- **10 handcrafted themes (defaulting to `pitch-oled`)**:
  - *Ultra-Dark & Hardware Minimalist*: `pitch-oled` (default), `braun-light`, `eink-mono`
  - *Developer IDE Dark*: `gruvbox-dark`, `nord`, `tokyo-night`, `kanagawa`, `everforest-dark`, `rose-pine`
  - *Developer IDE Light*: `solarized-light`
  - Plus `system` (resolves OS dark → `pitch-oled`, OS light → `braun-light`) and automatic backward-compatible migration of legacy saved `'dark'` → `'pitch-oled'` and `'light'` → `'braun-light'`.
- **Zero-flash boot & 1-tap switching**: Apply the saved theme synchronously in [`src/main.tsx`](../src/main.tsx) before React renders (matching `:root` = `pitch-oled` and `<meta name="theme-color" content="#000000">` in [`index.html`](../index.html)), and expose a 1-tap **Theme Switcher** sheet ([`src/components/ThemeSwitcherSheet.tsx`](../src/components/ThemeSwitcherSheet.tsx)) from the Library header in addition to Settings.
- **Canvas theme synchronization**: Non-DOM renderers (like [`WaveformCanvas`](../src/components/WaveformCanvas.tsx)) read tokens once and refresh via `MutationObserver` on `data-theme` ([ADR-04](./ADR-04-decoupled-60fps-canvas-waveform.md)).
- **Mobile PWA layout invariants**: Use `100dvh` viewport sizing, `env(safe-area-inset-*)` padding for notched iOS/Android screens, `>= 44px` touch targets, and thumb-zone primary controls in Recording Studio and Audio Player.

## System Invariants
1. **Vanilla CSS only**: No TailwindCSS or CSS-in-JS libraries; all colors and accent borders must flow from semantic CSS custom properties (no hardcoded palette `hsla(...)` leaks across view stylesheets).
2. **Pre-first-paint theme application**: `:root` defaults to `pitch-oled` (`#000000`) and `applyThemeToDocument(loadSettings().theme)` runs before `ReactDOM.createRoot(...).render(...)`.
3. **Graceful legacy migration**: Saved legacy `'dark'` / `'light'` values in `localStorage` automatically resolve to `'pitch-oled'` / `'braun-light'` without breaking existing installations.
4. **Mobile viewport ergonomics**: Primary recording and playback screens must fit cleanly within `100dvh` with safe-area insets and no horizontal overflow at `390×844`.

## Consequences & Trade-offs
- **Pros:** Zero CSS runtime overhead, authentic hardware & IDE aesthetics without muddy gradients, instant live switching across 10 curated palettes, effortless Canvas/DOM theme parity.
- **Cons:** Maintaining 10 palettes requires disciplined adherence to semantic tokens whenever adding new UI states.
