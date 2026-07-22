# Accessibility & Motion

## Focus & keyboard

- Every interactive element gets a visible focus-visible ring:
  `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
  focus-visible:ring-offset-background`. `ring` is always the same value
  as `primary` (see `colors.md`) — never a separate hardcoded focus color.
- Every interactive element must be operable by keyboard alone — this is
  why the mega-menu opens on click as well as hover, and why mobile nav
  uses `<details>` instead of a hover-only reveal.
- Tap targets ≥ 44×44px, no exceptions for "it looks better smaller."
- A skip-to-content link (`sr-only focus:not-sr-only`) at the very top of
  `<body>`.
- ARIA where semantics don't cover it: `aria-current` on active nav links,
  `role="tablist"/"tab"/"tabpanel"` + `aria-selected` on tabs, `aria-*` on
  the theme/nav toggles.

## Motion

- Only `transition-colors` / `transition-transform` on interactive
  elements — no gratuitous animation.
- Every animated pattern (scroll-reveal, logo marquee, scroll-cue bounce)
  must degrade to a static, fully-legible state under
  `@media (prefers-reduced-motion: reduce)` — not just a shorter duration,
  fully off.
- No autoplaying carousels by default, no motion that blocks content from
  being visible/readable (progressive enhancement: content is correct and
  visible with zero JS, motion only adds polish on top).

## Contrast (from `~/.agents/theme/AGENTS.md`, restated because it's the
most commonly missed check)

- Body text ≥ 4.5:1 in both light and dark.
- Badge / small-bold text ≥ 3:1.
- Check `warning` and `info` status colors specifically — they fail most
  often because amber/blue tints sit closer to the passing threshold than
  the primary/foreground pair.
- Foreground text never at the lightness extremes (`L 0–5%` or `L
  95–100%`); page background never near-black (`L < 8%` dark) or stark
  white (`L > 98%` light — reserve that for elevated `card` surfaces
  only).

## Responsive test matrix

375px (mobile), 768px (tablet), 1024px (small desktop), 1440px (desktop).
At each: no horizontal scroll, no overlap, legible tap targets, check both
light and dark if the target supports theme switching.
