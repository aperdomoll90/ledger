---
name: CSS transitions require identical positioning model in both states
description: A property animation between two states is only smooth if the positioning model (containing block, anchor side, position type) is identical in both states; otherwise the browser changes algorithms mid-animation and the transition jumps
type: feedback
originSessionId: be6a0f3b-3e62-4cfe-b652-df86dde897ea
---
For an animated transition between two states to be visually smooth (no jump), the *positioning model* must be identical in both endpoints:

- Same containing block (same positioned ancestor for `position: absolute` children).
- Same anchor side (`left + width` in BOTH states, NOT `right + width` closed -> `left + width` open).
- Same `position` value (don't switch `relative` -> `absolute` between states).
- Same percentage base (if one state uses `100%` of `.c-nav` and the other uses `100vw`, the transition has two coordinate systems).

If any of these change between states, the browser switches its positioning algorithm at the state boundary, and the form's `left` / `width` properties end up animating against a containing-block rectangle that has already snapped to a new place. Result: visible jump even though both endpoints render correctly individually.

**Why:** Encountered on the Starbrite header search component (S85, 2026-05-23). Adrian changed `.c-search__form` from `position: fixed` to `position: absolute` to dodge a stacking-context trap from a transformed ancestor on `/search`. The first fix attempt promoted `.c-search` to `position: absolute; inset-inline: 0` on the open state to span `.c-nav`'s width — which made horizontal positioning correct but introduced a jump because `position` is not a transitionable property. Final fix: leave `.c-search` in normal flex flow on mobile, remove `position: relative` from base, restore it inside the desktop `@media` block. Form's containing block (`.c-nav`) is now invariant across both states.

**How to apply:**
- Before animating a layout property change, audit both endpoints for identical positioning model.
- If a parent's position needs to change between states (e.g., flex -> absolute for spanning), find a different mechanism: change only the child's anchor values, use transforms, or use `display: contents` tricks.
- For drawer / overlay-style components that need to expand to a viewport-wide footprint: anchor the inner element to a viewport-wide positioned ancestor (`.c-nav`) directly, never to a flex-child intermediary whose width changes between states.
- Magic-number calc values that depend on sibling widths are a code smell (cross-component coupling). Publish CSS custom properties on the parent (`--c-nav-toggle-width`) so components can read them.
