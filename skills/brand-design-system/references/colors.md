# Colors

## Methodology lives elsewhere

`~/.agents/theme/AGENTS.md` is the authoritative, generic color-derivation
recipe: a parametric single-brand-hue HSL formula (Always/Never/Ask-Before
rules + a light/dark token-formula table), scoped to CSS-variable color
tokens only. Read it directly rather than re-deriving these rules here —
this file only adds what it deliberately leaves blank.

## Concrete brand parameter

```
H_b = 222   S_b = 35%   L_b = 44%   →  #4b6195
```

This is the answer to that file's "Ask Before: picking the brand hue if
unspecified" step. Use it as the default for any target under this
personal brand. Only ask the user for a different `H_b S_b L_b` if the
target is explicitly a different brand.

## Canonical token table (redlab-ng, `themes/redlab-ng/assets/css/tokens.css`)

HSL triplets, no `hsl()` wrapper — composed as `hsl(var(--x))`. This is the
most complete/recent implementation; treat it as the copy-paste reference
(also available pre-assembled in `../assets/tokens.css`).

| Token | Light | Dark |
|---|---|---|
| `--background` | `0 0% 100%` | `240 10% 3.9%` |
| `--foreground` | `240 10% 3.9%` | `0 0% 98%` |
| `--card` | `0 0% 100%` | `240 10% 5.9%` |
| `--card-foreground` | `240 10% 3.9%` | `0 0% 98%` |
| `--popover` | `0 0% 100%` | `240 10% 5.9%` |
| `--popover-foreground` | `240 10% 3.9%` | `0 0% 98%` |
| `--muted` | `240 4.8% 95.9%` | `240 3.7% 15.9%` |
| `--muted-foreground` | `240 3.8% 46.1%` | `240 5% 64.9%` |
| `--border` | `240 5.9% 90%` | `240 3.7% 15.9%` |
| `--input` | `240 5.9% 90%` | `240 3.7% 15.9%` |
| `--ring` | `222 35% 44%` | `222 60% 70%` |
| `--primary` | `222 35% 44%` (`#4b6195`) | `222 60% 70%` (lightened for AA on dark) |
| `--primary-foreground` | `0 0% 100%` | `240 10% 3.9%` |
| `--secondary` | `240 4.8% 95.9%` | `240 3.7% 15.9%` |
| `--secondary-foreground` | `240 5.9% 10%` | `0 0% 98%` |
| `--accent` | `240 4.8% 95.9%` | `240 3.7% 15.9%` |
| `--accent-foreground` | `240 5.9% 10%` | `0 0% 98%` |
| `--destructive` | `0 72% 51%` | `0 62% 45%` |
| `--radius` | `0.5rem` | same |

Neutral base is shadcn's "zinc" (`H 240`), with the brand navy (`H 222`)
swapped in only for `primary`/`ring` — a deliberate choice (D-2 in the
redlab-ng design docs): brand color used **sparingly** (primary buttons,
active nav, focus ring, key accents), neutral grays carry the rest of the
UI. This is a valid reading of the `~/.agents/theme/AGENTS.md` "derive
every neutral from H_b ± a few degrees" rule — 240 vs 222 is within a few
degrees, tuned for a cooler, more neutral gray than a strict single-hue
system would give. If a target wants the neutrals more visibly tinted
navy, use the audio-to-subs variant below instead.

### Non-themed exception: hero scrim

```css
--hero-scrim-from: 222 45% 8%;
--hero-scrim-to: 222 55% 6%;
```

Fixed, **not** redefined in `.dark` — a hero photo overlay must stay dark/
moody in both themes, unlike `--primary` which lightens in dark mode. Same
222 hue family as brand primary. Use as the pattern for any "must always
be dark regardless of theme" surface (e.g. a scrim, a badge that should
always read on a photo).

## Alternate re-derivation: audio-to-subs ("Ayu Tint")

`audio-to-subs/frontend/src/index.css` re-derives the same brand hue with
neutrals *more visibly tinted* navy (cool-tinted scale rather than zinc)
and a different dark-mode `primary` tuning. Both are legitimate per the
"re-derive in place, don't rebuild from scratch" rule — pick whichever
matches the target's desired neutral coolness. Not canonical; documented
here as a second reference point, and because it adds status-color tokens
(`log-debug/info/warning/error`) worth reusing for any target with
severity/log UI.

| Token | Light | Dark |
|---|---|---|
| `--background` | `218 28% 94%` | `222 26% 11%` |
| `--foreground` | `222 22% 20%` | `220 22% 89%` |
| `--card` | `210 35% 99%` | `222 24% 15%` |
| `--primary` | `222 35% 44%` | `222 48% 65%` |
| `--secondary`/`--muted` | `220 22% 89%` / `220 20% 90%` | `222 20% 19%` / `222 18% 18%` |
| `--muted-foreground` | `220 12% 42%` | `220 12% 62%` |
| `--accent` | `222 45% 93%` | `222 40% 24%` |
| `--border`/`--input` | `220 18% 82%` | `222 18% 21%` |
| `--destructive` | `4 62% 51%` | `4 58% 54%` |

## Status / severity colors

Kept off the brand hue except `info` (blue reads universally as "info," so
it may reuse the brand hue). Values as shipped in audio-to-subs — reuse
verbatim for any target with logs/status/severity UI:

| Token | Light | Dark |
|---|---|---|
| `debug` | `220 10% 48%` | `220 10% 58%` |
| `info` | `222 40% 55%` | `222 48% 65%` |
| `warning` | `36 82% 46%` | `36 78% 56%` |
| `warning-foreground` | `36 45% 14%` | `36 40% 12%` |
| `error` | `4 62% 51%` (= destructive) | `4 62% 58%` |

`warning` **must** pair with its own `-foreground` token — white-on-amber
fails WCAG. `error`/`destructive` are the one place red-ish hues belong;
never repurpose them as a decorative accent.

## Verification

- `grep -rE 'bg-black|text-white|gray-[0-9]|zinc-[0-9]|slate-[0-9]|neutral-[0-9]|#[0-9a-fA-F]{3,6}'` over component/template code — only sanctioned scrim exceptions (`bg-black/NN` on modal overlays) and files inside the token definitions themselves should hit.
- Contrast in both themes: body text ≥ 4.5:1, badge/small-bold text ≥ 3:1 — check `warning` and `info` specifically, they fail most often.
- No `0%` saturation anywhere in a themed surface token.
