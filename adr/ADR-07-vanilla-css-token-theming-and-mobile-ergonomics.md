# ADR-07: Vanilla CSS Semantic Tokens, Zero-Flash Theming & Mobile PWA Ergonomics

- **Status:** Accepted
- **Date:** 2026-11-19
- **Related CUJs:** [CUJ-05](../cuj/CUJ-05-audiobook-player.md), [CUJ-06](../cuj/CUJ-06-library-browsing-themes.md), [CUJ-08](../cuj/CUJ-08-draft-recovery-drive-pwa.md)

## Context
StoryTape is designed for cozy nighttime recording and bedtime listening on phones (`390×844` mobile viewports, iOS standalone safe areas, and one-handed thumb controls). Adding a utility CSS framework or CSS-in-JS runtime introduces unnecessary build complexity, bundle overhead, and runtime style recalculation—especially undesirable alongside 60fps canvas rendering.

## Decision
Standardize on **co-located Vanilla CSS stylesheets backed by semantic CSS custom properties**:
- **Design token architecture**: Define all surface, ink, border, accent, spacing, radius, and shadow tokens in [`src/styles/tokens.css`](../src/styles/tokens.css) and shared layout/component primitives (`.sheet-backdrop`, `.sheet-panel`, `.btn`, `.icon-btn`) in [`src/styles/global.css`](../src/styles/global.css).
- **Warm Night (`dark`), Warm Paper (`light`), and `system` themes**: Toggle themes via `data-theme="dark" | "light"` on `document.documentElement`. Apply the saved theme synchronously in [`src/main.tsx`](../src/main.tsx) before React renders to prevent a flash of wrong theme on boot, and subscribe to OS `prefers-color-scheme` changes when set to `'system'`.
- **Canvas theme synchronization**: Non-DOM renderers (like [`WaveformCanvas`](../src/components/WaveformCanvas.tsx)) read tokens once and refresh via `MutationObserver` on `data-theme` ([ADR-04](./ADR-04-decoupled-60fps-canvas-waveform.md)).
- **Mobile PWA layout invariants**: Use `100dvh` viewport sizing, `env(safe-area-inset-*)` padding for notched iOS/Android screens, `>= 44px` touch targets, and thumb-zone primary controls in Recording Studio and Audio Player.

## System Invariants
1. **Vanilla CSS only**: No TailwindCSS or CSS-in-JS libraries; all colors must flow from semantic CSS custom properties so both Warm Night and Warm Paper themes stay legible and cohesive.
2. **Pre-first-paint theme application**: `applyThemeToDocument(loadSettings().theme)` runs before `ReactDOM.createRoot(...).render(...)`.
3. **Mobile viewport ergonomics**: Primary recording and playback screens must fit cleanly within `100dvh` with safe-area insets and no horizontal overflow at `390×844`.

## Consequences & Trade-offs
- **Pros:** Zero CSS runtime overhead, tiny stylesheet bundle, exact control over mobile touch ergonomics and safe areas, effortless Canvas/DOM theme parity.
- **Cons:** Requires manual discipline to reuse semantic tokens and avoid hardcoded colors across co-located `.css` files.
