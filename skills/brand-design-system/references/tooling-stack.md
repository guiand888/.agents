# Tooling & Stack

## Tailwind v4, CSS-first config

No `tailwind.config.js`. Theme lives entirely in the entry CSS file via
`@import "tailwindcss";` + `@theme inline { ... }`, mapping the raw HSL
custom properties onto Tailwind color utilities:

```css
@import "tailwindcss";

@theme inline {
  --color-background: hsl(var(--background));
  --color-foreground: hsl(var(--foreground));
  --color-card: hsl(var(--card));
  --color-card-foreground: hsl(var(--card-foreground));
  --color-popover: hsl(var(--popover));
  --color-popover-foreground: hsl(var(--popover-foreground));
  --color-muted: hsl(var(--muted));
  --color-muted-foreground: hsl(var(--muted-foreground));
  --color-border: hsl(var(--border));
  --color-input: hsl(var(--input));
  --color-ring: hsl(var(--ring));
  --color-primary: hsl(var(--primary));
  --color-primary-foreground: hsl(var(--primary-foreground));
  --color-secondary: hsl(var(--secondary));
  --color-secondary-foreground: hsl(var(--secondary-foreground));
  --color-accent: hsl(var(--accent));
  --color-accent-foreground: hsl(var(--accent-foreground));
  --color-destructive: hsl(var(--destructive));

  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);

  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
}
```

`inline` matters: it makes utilities reference the var directly, so
`.dark` overrides propagate without a rebuild. **Never duplicate the
palette into a separate config object** — the CSS variables are the only
source of truth; Tailwind only consumes them.

If the target doesn't use Tailwind at all, the `:root`/`.dark` custom
property block still applies directly as plain CSS — see
`../assets/tokens.css`. The token architecture is the invariant; Tailwind
is just one consumer of it.

## Framework decision rule

- **Static content site** (marketing site, blog, docs) → no JS framework.
  Vanilla JS for progressive enhancement only (scroll-reveal, marquee
  speed-normalization, mobile nav toggle where `<details>` isn't enough).
  This was a deliberate choice in redlab-ng — replacing a jQuery/Bootstrap
  stack with ~90 lines of vanilla JS, tabs/accordion needing no JS at all.
- **Interactive app** (dashboard, tool, anything with real client state) →
  the established personal stack is **React + shadcn/ui + Radix
  primitives + Tailwind v4**, per audio-to-subs: `class-variance-
  authority` for variant APIs, `tailwind-merge`, `lucide-react` for icons,
  TanStack Router/Query for routing/data, Zustand for local state where
  needed. `components.json` base color `neutral`, `cssVariables: true` —
  then override the generated tokens with this brand's values (don't
  accept shadcn's default near-black primary).

Don't reach for a framework on a static site "for consistency" and don't
hand-roll app state management on a real app — match the tool to what the
target actually is.

## FOSS-only dependency policy (hard requirement)

| Need | Use | License | Avoid |
|---|---|---|---|
| CSS framework | Tailwind v4 | MIT | — |
| Typeface | Inter, self-hosted woff2 | OFL | Google Fonts CDN |
| Icons | Lucide (sprite or `lucide-react`) | MIT | Proprietary icon tiers (Font Awesome Pro, Themify, etc.) |
| Maps | Leaflet + OpenStreetMap | BSD / ODbL | Google Maps, Mapbox |
| Analytics | Umami, self-hosted | MIT/AGPL | Google Analytics, any non-self-hosted tracker |
| Diagrams | Mermaid (vendored, static) | MIT | — |

Everything is build-time or self-hosted — no runtime CDN dependency for
fonts, icons, or scripts. When auditing an existing target, any hit
against the "avoid" column is a finding to fix, not a style preference to
leave alone.
