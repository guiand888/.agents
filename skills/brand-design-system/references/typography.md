# Typography

## Typeface

**Inter**, self-hosted, OFL license. Ship as `.woff2`, weights **400
(regular) and 500 (medium) only** — no separate 300/600/700/800 files in
either source project. `font-display: swap`; preload both weights with
`crossorigin` in `<head>`.

```css
@font-face {
  font-family: "Inter";
  src: url("/fonts/inter-latin-400-normal.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Inter";
  src: url("/fonts/inter-latin-500-normal.woff2") format("woff2");
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
```

**Known gap, not a pattern to copy:** neither source project ships a true
bold (600/700) face. `font-weight: 700` on `font-family: Inter` will
synthesize/faux-bold in most browsers rather than render a real bold
glyph. If a target needs genuine bold headings, add the 600 or 700 woff2
rather than relying on synthesis — this is a decision point, not
something to silently inherit. Also flag: `audio-to-subs` currently has
**no font customization at all** (falls back to browser/Tailwind default
sans) — that's brand drift to fix on that project, not a pattern to
replicate elsewhere.

Font stack (with system fallback):

```
--font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
```

## Type scale

Mirrors shadcn defaults:

| Class | Size |
|---|---|
| `xs` | `.75rem` |
| `sm` | `.875rem` |
| `base` | `1rem` / `1.5rem` line-height |
| `lg` | `1.125rem` |
| `xl` | `1.25rem` |
| `2xl` | `1.5rem` |
| `3xl` | `1.875rem` |
| `4xl` | `2.25rem` |
| `5xl` | `3rem` |

## Heading & display conventions

- `tracking-tight` on **every** heading level and the logo wordmark —
  defining "display type" trait, apply it consistently.
- No ALL-CAPS body text. Uppercase is reserved for the one deliberate use
  below (eyebrows).
- Hero H1: `text-3xl font-bold tracking-tight md:text-5xl`
- Article/post H1: `text-3xl font-bold tracking-tight md:text-4xl`
- Section H2: `text-2xl font-bold tracking-tight md:text-3xl`
- Card/feature H3: `text-lg font-semibold tracking-tight`
- Eyebrow/kicker (label above a heading): `text-sm font-medium uppercase
  tracking-widest text-primary`
- Stat numbers: `text-3xl font-bold tracking-tight text-primary
  md:text-4xl`
- Nav links / button labels: `text-sm font-medium`
- Body copy: default `base` size, `text-muted-foreground` for secondary
  text, `leading-relaxed` for prose blocks.
- Justified body text (`text-justify`) is a deliberate, non-default choice
  for hero subtitles, footer blurb, and mega-menu descriptions — not
  applied to article body copy. Use sparingly, only for short supporting
  copy blocks, not long-form reading text (justify hurts readability at
  paragraph length).

## Long-form / markdown content

Use `@tailwindcss/typography`'s `prose` class, but remap every
`--tw-prose-*` variable to the site's own tokens so markdown content
matches the design system instead of the plugin's default gray theme:

```css
.prose-tokens {
  --tw-prose-body: hsl(var(--foreground));
  --tw-prose-headings: hsl(var(--foreground));
  --tw-prose-lead: hsl(var(--muted-foreground));
  --tw-prose-links: hsl(var(--primary));
  --tw-prose-bold: hsl(var(--foreground));
  --tw-prose-counters: hsl(var(--muted-foreground));
  --tw-prose-bullets: hsl(var(--border));
  --tw-prose-hr: hsl(var(--border));
  --tw-prose-quotes: hsl(var(--muted-foreground));
  --tw-prose-quote-borders: hsl(var(--primary));
  --tw-prose-code: hsl(var(--foreground));
  --tw-prose-pre-code: hsl(var(--foreground));
  --tw-prose-pre-bg: hsl(var(--muted));
  --tw-prose-borders: hsl(var(--border));
  --tw-prose-th-borders: hsl(var(--border));
  --tw-prose-td-borders: hsl(var(--border));
  --tw-prose-captions: hsl(var(--muted-foreground));
}
```

Apply as `class="prose prose-tokens max-w-none leading-relaxed"`. Because
every value reads `hsl(var(--token))`, it follows `.dark` overrides
automatically — no separate dark prose theme needed. Reuse this pattern
for any target rendering markdown/CMS content (blog, docs, changelog).
