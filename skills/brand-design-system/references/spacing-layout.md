# Spacing & Layout

## Containers

- General container: `container mx-auto max-w-[1200px] px-4` — used
  identically for header, footer, sections, hero.
- Long-form content (article body, prose bands): narrower,
  `max-w-[760px]` — comfortable line-length, not the full section width.

## Vertical rhythm

- Standard section: `py-12 md:py-20`.
- Hero section: `py-16 md:py-24`.
- Footer: `py-12`.
- This "12/16 → 20/24" responsive pairing is the consistent rule — don't
  invent new padding scales per section; reuse these two pairs.

## Gaps

| Context | Gap |
|---|---|
| Card/feature grids | `gap-6` |
| Footer multi-column grid | `gap-8` |
| Hero image/text split | `gap-10` |
| Small inline groups (buttons, nav items) | `gap-3` / `gap-4` |

## Radius

Token-driven, never a bare Tailwind radius utility with a magic number:

```css
--radius: 0.5rem;
/* consumed as: */
--radius-lg: var(--radius);            /* rounded-lg — cards, hero images */
--radius-md: calc(var(--radius) - 2px); /* rounded-md — buttons, inputs */
--radius-sm: calc(var(--radius) - 4px); /* rounded-sm */
```

Badges use `rounded-full` (pill), not the radius scale.

## Shadows & borders

- Cards: `shadow-sm` default, `hover:shadow-md` if interactive/linked
  (float-on-hover, not a static heavy box).
- Mega-menu dropdown panel: `shadow-md`.
- Hero CTA buttons over photography: `shadow-lg` + `ring-1 ring-inset
  ring-white/30` (the one place a stronger shadow is intentional — text
  legibility over an image).
- Borders: always `border border-border` (the low-contrast token, `240
  5.9% 90%` light) — never a heavy/high-contrast hardcoded border. This
  directly replaces a dated "heavy visible borders, no elevation" look:
  subtle borders + soft elevation so cards float instead of being boxed
  in.

## Grid patterns

- Standard responsive collapse: `grid-cols-1 → sm:grid-cols-2 →
  lg:grid-cols-3/4`.
- **Column count that divides evenly**: pick columns so the last row is
  never a single orphaned card — e.g. 3 items → `grid-cols-1
  lg:grid-cols-3`; item count a multiple of 3 → `sm:grid-cols-2
  lg:grid-cols-3`; otherwise → `sm:grid-cols-2 lg:grid-cols-2`. Apply this
  logic (a small helper/function, or inline conditional) whenever a grid's
  item count is dynamic/CMS-driven.
- **Band alternation**: when stacking multiple full-width sections
  (marketing page, landing page), alternate `bg-background` ↔ `bg-muted`
  strictly by *what actually renders* (track a running flag, skip empty/
  optional sections) so two adjacent visible sections never share the same
  background band.

## Optional/advanced patterns (use only if the target calls for it)

- **Scroll-snap sections**: on desktop (`md:` and up), sections behave
  like slides (`scroll-snap-type: y proximity` on the scroll container,
  `scroll-snap-align: start` + `scroll-margin-top` per section); on mobile
  they flow normally. Opt in per page via a class on `<html>`, not
  globally — this is a landing-page/homepage pattern, not a default for
  every page type.
- **Scroll-reveal**: `[data-reveal]` opt-in per section,
  IntersectionObserver-driven `opacity:0 translateY(1rem) → opacity:1
  translateY(0)` over `0.6s ease-out`, gated behind a `html.js` class so
  no-JS visitors always see static fully-visible content, and always
  disabled under `prefers-reduced-motion`.

Both are progressive enhancements with a plain, fully-usable fallback —
never make content depend on JS or motion to be visible/readable.
