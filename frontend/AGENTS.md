# Frontend Standards

## Purpose
Define how browser-rendered interaction is verified and how overlapping-element layout conflicts are resolved.

## Scope
Interaction affordances (pointer, keyboard, drag, hover-revealed controls), element overlap and stacking, and verification of UI components with more than one consumer. Color tokens stay in `theme/AGENTS.md`.

## Rules

### Always
- Verify every pointer- or keyboard-driven control by driving a real browser (Playwright or equivalent) and dispatching real events into a real rendering engine — jsdom has no layout, paint, or hit-testing, so it cannot observe whether a control is reachable at all.
- Treat live interaction testing as mandatory for drag handles, hover-revealed affordances, and absolutely/relatively positioned elements sitting near a sibling's boundary — these are exactly the cases where nothing in the DOM tree is wrong and only real geometry exposes the defect.
- Hit-test the pixel the user actually aims at (`document.elementFromPoint`) whenever a control overlaps or abuts another element — a passing render assertion proves the node exists, not that it receives the click.
- Resolve overlap conflicts by geometry: keep each element's hit zone fully inside its own box — eliminating the conflict holds across every CSS context, arbitrating it with `z-index` does not.
- Re-verify live on every existing consumer of a shared component after changing it, including consumers already shipped and already green — a geometry or stacking fix is evaluated inside each consumer's own CSS context and can land differently in each.
- When layering a manual override on top of an auto-computing system (auto-layout, auto-redistribution, autofit), test the override against every recompute path that system has and assert it still holds after each — the failure mode is the override being silently recomputed away, which no single-path test can see.
- Re-run the automated gates after the live pass and file any gate that stayed green through a reproduced bug as a defect in the gate — a suite that cannot fail on a real failure is under-specified.

### Never
- Resolve two elements competing for the same screen region by raising one's `z-index` — equal values tie-break on DOM order, so an unrelated sibling elevation silently defeats the fix.
- Assume a `z-index` that works in one markup context works in another — `position: sticky`/`fixed`, `transform`, `filter`, `opacity < 1`, `contain`, and `will-change` each open a stacking context that traps a descendant's elevation inside it.
- Treat a passing gate suite — unit tests, computed-style assertions, screenshot diffs, `axe-core` scans — as evidence that an interaction works; not one of them dispatches a real pointer event at a real hit-tested pixel.
- Ship an interactive control whose only verification was a simulated DOM event in jsdom — a control can be perfectly constructed and still unclickable.
- Verify only the consumer whose bug motivated a shared-component fix — the other consumers were re-rendered by that change too.
- Test a manual override only at the moment it is applied — that proves it was written, not that it survives.
- Fix an overflow-clipped affordance with `overflow: visible` on the scroll container — that trades a clipped control for a broken scroll region; move the geometry instead.

### Ask Before
- Re-baselining a visual-regression snapshot to accommodate a geometry change — confirm the new baseline is the intended appearance and not the bug being made permanent.

## Stacking Context Reference

`z-index` is only comparable *within* one stacking context. A descendant's `z-index: 10` never out-ranks anything outside its own context's root, no matter how large the number. Between two elements in the same context with equal `z-index`, the later one in DOM order paints on top — so "add `z-10` to the handle" silently does nothing when the element it must beat is also elevated for an unrelated reason.

| Trigger | Opens a stacking context |
|---|---|
| `position: relative`/`absolute` with `z-index` other than `auto` | Yes |
| `position: fixed` or `position: sticky` | Yes — even at `z-index: auto` |
| `transform`, `filter`, `backdrop-filter`, `perspective`, `mask`, `clip-path` (non-`none`) | Yes |
| `opacity < 1`, `mix-blend-mode` other than `normal`, `isolation: isolate` | Yes |
| `contain: layout` / `paint` / `strict` / `content` | Yes |
| `will-change` naming any property above | Yes |
| flex/grid child with `z-index` other than `auto` | Yes |

This is why the same component can work in one host and fail in another with identical markup of its own: header cells at `position: relative` leave their children in the shared parent context, where an elevation competes normally, while header cells at `position: sticky` each open a private context that the child's elevation cannot escape. Raising the number does not help; neither does elevating every cell equally, which only moves the tie back to DOM order.

Overflow clipping is a second, independent failure with the same visual signature — an element that straddles its container's edge (negative margin, absolute offset) is clipped by an ancestor's `overflow: auto`/`hidden` regardless of any `z-index`. Both failure modes disappear under one change: keep the affordance's hit zone inside its own element's box, so it never competes with a sibling and never crosses a clipping boundary.

Sources:
- MDN, "Stacking context" — https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_positioned_layout/Stacking_context — the full trigger list, and the rule that `z-index` compares only within one context.
- CSS Positioned Layout Module Level 3, § "Sticky positioning" — https://www.w3.org/TR/css-position-3/ — a sticky-positioned box establishes a stacking context.

## Live Verification Checklist

- [ ] Drove a real browser (not jsdom) and dispatched real pointer and keyboard events at the control.
- [ ] Hit-tested the control's own pixels with `elementFromPoint` — the node returned is the control, not a sibling or an ancestor.
- [ ] Checked the edge instances specifically: first and last item in the row/column/list, and the control's behavior at every scroll container it sits inside.
- [ ] Exercised the keyboard path end to end — reachable by Tab, operable by arrows/Enter/Escape — never ship a mouse-only control.
- [ ] Re-ran the same check on every existing consumer of the shared code, not only the one that surfaced the bug.
- [ ] Applied the manual override, re-triggered every automatic recompute, and confirmed the override still held afterward.
- [ ] Confirmed persistence across reload and navigation, where the state is meant to persist.
- [ ] Where no consumer had reachable data, used a clearly-marked throwaway scaffold and reverted it — see `testing/AGENTS.md`.
- [ ] Re-ran the automated gates after the live pass; any gate green throughout a reproduced bug is itself a defect to file.
