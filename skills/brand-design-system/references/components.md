# Components

Visual target is shadcn/ui defaults throughout — same variant/size API
whether the target is a Hugo partial, a plain HTML component, or a React
component.

## Button

Variants: `default | secondary | outline | ghost | destructive`.
Sizes: `sm | default | lg | icon` (fixed heights `h-9 / h-10 / h-11 / h-10
w-10`).

Base classes on every variant: `rounded-md transition-colors
focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
focus-visible:ring-offset-background`.

Default variant: `bg-primary text-primary-foreground shadow
hover:bg-primary/90`.

## Badge

Pill (`rounded-full`), `text-xs font-medium`. Variants: `secondary
(default, bg-secondary text-secondary-foreground) | primary | outline |
destructive`.

## Card

`rounded-lg border border-border bg-card text-card-foreground shadow-sm`,
`p-6`. Title `text-lg font-semibold tracking-tight`, body `text-sm
text-muted-foreground`. Optional footer gets a top divider (`border-t
border-border pt-4`). Interactive/linked cards add `hover:shadow-md` plus
the standard focus-visible ring.

Blog/list card variant: same base, image-first — 16:9 image
(`aspect-video`), `group-hover:scale-105` zoom on hover, category badge,
date/author meta line.

## Accordion

Pure `<details>`/`<summary>` — **zero JS**. Chevron rotates via
`group-open:rotate-180`. Prefer this over a JS-driven accordion whenever
the target doesn't already have a component framework in play.

## Tabs

`role="tablist"` / `role="tab"` / `role="tabpanel"` ARIA pattern. Active
tab: `border-primary text-foreground`; inactive: `border-transparent
text-muted-foreground`. Needs a small script to swap `aria-selected` /
panel visibility — guard it against double-binding if the target's build
might inline the partial more than once.

## Navigation

- Desktop: mega-menu opens on **hover and click** (click support is a
  deliberate accessibility fix — hover-only isn't keyboard/touch
  operable). Dropdown panel is a floating card (`rounded-lg border
  bg-popover shadow-md`) with icon + title + one-line description per
  child link, not a flat link list.
- Mobile: native `<details>` — no JS/framework required to open/close,
  full-width tap targets ≥ 44×44px.
- Header shell: sticky, translucent (`bg-background/95 backdrop-blur
  supports-[backdrop-filter]:bg-background/80`), thin bottom border,
  single row, same container width as everything else.

## Hero

Two accepted shapes:
1. Full-bleed photography with a scrim overlay (see `colors.md`
   `--hero-scrim-*`) and white text — for a homepage/landing banner.
2. Plain light background, two-column text/image grid
   (`grid md:grid-cols-2`) — for interior pages.

Both support an eyebrow label, a `ctas[]` list rendered through the Button
component, and an optional bouncing-chevron "scroll cue" button that
smooth-scrolls to the next section (walk to the actual next sibling
element rather than hardcoding an id/anchor, so it stays correct if
sections get reordered).

## CTA band

Full-width `bg-primary text-primary-foreground` block, centered text. Any
button inside it is forced to the `secondary` variant for contrast against
the brand-colored background — never `default` (primary-on-primary is
invisible).

## Stat block

Centered large number (`text-primary`, bold) + label underneath. Used in
2–4 column grids.

## Testimonial

Card-style figure/blockquote: avatar, name, role.

## Logo marquee

Pure-CSS infinite scroll — double the logo track, `translateX(-50%)` for a
seamless loop, edge-fade via `mask-image`, pause on hover/focus. JS only
needed to *normalize speed* across rows with different logo counts
(measure `scrollWidth`, rewrite `animation-duration`) — the marquee must
still work with a fixed speed if JS never runs, and must collapse to a
static wrapped grid under `prefers-reduced-motion`.

## Icons

Lucide (MIT) as the icon family, consistently, regardless of stack:
- Static/no-build target: self-hosted SVG sprite, referenced as
  `<svg class="lucide"><use href="#slug"/></svg>` through a single
  resolving partial/component — one integration point if the sprite needs
  to change later.
- React/app target: `lucide-react` package, same icon slugs.

Icon names are always lucide slugs used directly in data/content (e.g.
`server`, `rocket`, `headphones`, `shield`, `globe`, `chevron-down`,
`check`, `sun`, `moon`, `arrow-right`, `layout`) — never a different icon
set mixed in.

## Cross-cutting

Every interactive component: keyboard-operable, visible `focus-visible`
ring (see `accessibility-motion.md`), reads colors via tokens only (no
inline hex — see `colors.md`).
