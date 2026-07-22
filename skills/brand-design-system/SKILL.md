---
name: brand-design-system
description: Guillaume's personal brand design system — a navy shadcn-style token architecture, self-hosted Inter + Lucide, restrained shadcn-flavored components, FOSS-only dependencies. Use whenever redesigning, refactoring, or auditing a website, HTML page, or app frontend (Hugo or otherwise, static or app) to align it with this personal brand across personal sites, blog, apps, and the company site.
license: Personal use.
---

# Brand Design System

Codifies the design language proven consistent across two independently-built
properties — the `redlab-ng` Hugo theme (`fwdsys_prod` branch) and the
`audio-to-subs` React/shadcn app — into rules an agent can apply to any new
or existing target: Hugo or not, static HTML or an app frontend.

## Brand identity, in one paragraph

Navy brand hue `#4b6195` (HSL `222 35% 44%`) driving a shadcn-style
CSS-custom-property token system (`background/foreground/card/popover/
muted/border/input/ring/primary/secondary/accent/destructive`, `.dark`
variant, Tailwind v4 `@theme inline` mapping where Tailwind is present).
Self-hosted Inter (400/500) for type, self-hosted Lucide for icons.
Shadcn-flavored components: subtle borders + soft elevation over heavy
borders, generous rounding, restrained motion, visible focus rings
everywhere, mobile-first. FOSS-only dependencies — no proprietary fonts,
CDNs, icon sets, maps, or analytics when a self-hosted FOSS alternative
exists.

## Non-negotiables

- **One brand hue.** Every themed neutral (background/foreground/card/
  border/muted) carries the brand hue (`H≈222`) at varying S/L — never a
  desaturated 0%-saturation gray. Full derivation rules live in
  `~/.agents/theme/AGENTS.md` — read it, don't re-derive from scratch.
- **`#4b6195` / `222 35% 44%` is the concrete brand parameter** for this
  identity (`~/.agents/theme/AGENTS.md` is deliberately generic and asks
  for this value — this skill is where it's answered). Only ask the user
  for a different hue if they explicitly say this is a *different* brand.
- **No hardcoded colors downstream.** No inline hex, no `bg-black`/
  `text-white`/`gray-*`/`zinc-*`/`slate-*`/`neutral-*` utility classes in
  component code. Modal scrims (`bg-black/80`) are the one sanctioned
  pure-black exception. Route everything through the tokens.
- **Self-hosted, FOSS-only dependencies.** No Google Fonts CDN, no Google
  Maps/Mapbox (use Leaflet+OSM), no proprietary icon tiers (use Lucide,
  MIT), no non-self-hosted analytics (Umami-style). See
  `references/tooling-stack.md` for the full policy and stack-specific
  wiring.
- **Every interactive element is keyboard-operable** with a visible
  `focus-visible` ring (`ring-ring`), and motion respects
  `prefers-reduced-motion`. See `references/accessibility-motion.md`.

## Workflow

1. **Audit** the target (new build vs. existing site/app to refactor) —
   `references/audit-workflow.md` has the concrete checklist and grep
   patterns for an existing codebase.
2. **Establish or port the color tokens** — `references/colors.md` has
   the full realized light/dark token table, ready to copy from
   `assets/tokens.css`.
3. **Typography** — `references/typography.md` (font, scale, heading
   conventions).
4. **Spacing & layout** — `references/spacing-layout.md` (containers,
   rhythm, radius, shadows, grid patterns).
5. **Components** — `references/components.md` (button/card/badge/nav/
   accordion/tabs/CTA API conventions).
6. **Accessibility & motion pass** — `references/accessibility-motion.md`.
7. **Verify** — contrast in both themes, visual check at 375/768/1024/
   1440px, grep for leftover hardcoded colors. Checklist in
   `references/audit-workflow.md`.

Not every target needs every layer applied identically — e.g. a small
static HTML page doesn't need the React/shadcn component API conventions,
and an app frontend doesn't need Hugo's scroll-snap section pattern. Use
judgment: the tokens and non-negotiables above apply everywhere; the
reference files flag which parts are stack-specific.

## Reference index

| File | Read it for |
|---|---|
| `references/colors.md` | Full token table (light/dark), brand parameter, status colors, reconciliation between the two source projects |
| `references/typography.md` | Font, type scale, heading/eyebrow/stat conventions, prose remap pattern |
| `references/spacing-layout.md` | Containers, section rhythm, radius/shadow scale, grid & band-alternation patterns |
| `references/components.md` | Button/card/badge/nav/accordion/tabs/CTA/marquee patterns and shadcn variant/size API |
| `references/tooling-stack.md` | Tailwind v4 wiring, FOSS-only dependency policy, framework decision rule |
| `references/accessibility-motion.md` | Focus rings, tap targets, ARIA, reduced-motion rules, contrast thresholds |
| `references/audit-workflow.md` | Step-by-step checklist for refactoring an existing site/app; ask-before list |
| `assets/tokens.css` | Drop-in `:root`/`.dark` token file, framework-agnostic |

## Relationship to other rule sources

- `~/.agents/theme/AGENTS.md` governs the **generic color-derivation
  methodology** (parametric HSL recipe, Always/Never/Ask-Before rules).
  This skill supplies the **concrete brand parameters and everything
  outside color** (typography, spacing, components, tooling) that file
  intentionally omits. Don't restate its rules here — read it directly.
- Source projects for provenance/examples: `redlab-ng` theme
  (`themes/redlab-ng` on branch `fwdsys_prod`, the most complete/recent
  implementation — canonical reference) and `audio-to-subs`
  (`frontend/src/index.css` — a valid but slightly divergent
  "Ayu Tint" re-derivation, useful as a second data point, not canonical).
