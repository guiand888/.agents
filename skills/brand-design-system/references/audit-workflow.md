# Audit & Refactor Workflow

Use this when the target is an **existing** site/app being brought into
alignment, not a greenfield build.

## 1. Inventory current state

- `grep -rE '#[0-9a-fA-F]{3,6}|rgb\(|rgba\(|bg-black|text-white|gray-[0-9]|zinc-[0-9]|slate-[0-9]|neutral-[0-9]'` across component/template/CSS
  source (excluding vendored/third-party dirs) — every hit is a candidate
  to route through tokens instead.
- Identify the current font(s), icon set, maps provider, analytics
  provider, CSS/JS framework in use. Cross-check each against
  `tooling-stack.md`'s FOSS-only table — flag anything on the "avoid"
  list.
- Note whether the target already has a themed `:root`/`.dark` block. If
  it does, **re-derive it in place** by substituting the brand hue
  (`H_b=222 S_b=35% L_b=44%`) into the existing token names — don't
  rebuild the palette from scratch or rename tokens gratuitously.

## 2. Map existing styles onto tokens

- For each hardcoded color found in step 1, decide which semantic token it
  should become (`background`, `card`, `border`, `muted-foreground`,
  `primary`, `destructive`, etc.) — see `colors.md` for the full table and
  meanings.
- Replace hardcoded values with the token reference, not with a new
  one-off variable.

## 3. Typography, spacing, components

Work through `typography.md`, `spacing-layout.md`, and `components.md` in
order — each has concrete class/value references to apply. Prefer
adapting existing markup structure over a rewrite; the visual system
(borders → subtle, radius → consistent, shadows → soft) can usually be
layered onto an existing DOM without restructuring it.

## 4. Accessibility pass

Apply `accessibility-motion.md` — focus rings, tap targets, reduced-motion
guards, ARIA — as part of the same pass, not a separate follow-up.

## 5. Verify

- [ ] Re-run the grep from step 1 — only sanctioned exceptions
      (`bg-black/NN` scrims) should remain.
- [ ] Contrast checked in both themes: body ≥ 4.5:1, badges/small-bold
      ≥ 3:1, `warning`/`info` specifically.
- [ ] Visual check at 375/768/1024/1440px: nav, buttons, cards, focus
      rings, any severity/status badges.
- [ ] No new proprietary/CDN dependency introduced; any removed
      Google-Fonts-style dependency actually removed, not just unused.
- [ ] Build/lint green.

## Ask before

- The target's brand hue, **only if** this is explicitly a different
  brand from Guillaume's personal identity — otherwise `#4b6195` /
  `222 35% 44%` is the default, don't ask.
- Whether to keep an existing non-token design element that conflicts with
  a rule here (e.g. a client's existing dark-by-default requirement, a
  legal/compliance color requirement) — flag the conflict rather than
  silently overriding it.
