---
name: container-type does not reliably contain position:fixed descendants
description: CSS pattern rule — for drawers/overlays inside a container-query wrapper, use `position: absolute` relative to a known canvas-root, not `position: fixed`. Browsers are inconsistent on the spec'd containment.
type: feedback
originSessionId: 0b65f9cd-6611-4412-8ec4-aeef1780c24b
---
When using container queries (`container-type: inline-size` on a wrapper to enable `@container` queries), DO NOT rely on `position: fixed` descendants being contained within that wrapper. Per CSS spec, `container-type` implies `contain: layout` which should establish a containing block for fixed-positioned descendants. In practice, browsers are inconsistent — fixed-positioned elements may escape the wrapper to cover the entire viewport.

**Why:** Surfaced 2026-05-09 (Starbrite home mobile-first refactor, S72) when the hamburger drawer (`position: fixed; top: 0; right: 0; bottom: 0`) rendered over the entire browser page instead of staying inside the `.c-viewport-frame` (which had `container-type: inline-size`). Adrian flagged it: "the drawer needs to be on the container is on the page". Fix required restructuring the drawer to `position: absolute` relative to a known canvas-root element.

**How to apply:**
- For drawers, overlays, backdrops, and similar canvas-bounded UI inside a container-query wrapper: use `position: absolute` relative to a positioned ancestor that defines the canvas (e.g., `.c-home` with `position: relative; overflow: hidden`).
- Make sure the canvas-root element has `position: relative` (so absolute children are positioned against it) AND `overflow: hidden` (so any overflow from the absolutely-positioned child is clipped to the canvas boundaries — important for "off-screen drawer that slides in" patterns).
- The drawer / overlay markup may need to be a direct child of the canvas-root rather than nested inside a sub-component, so that the position-absolute hierarchy is clean.
- This rule is browser-pragmatic, not spec-pure. If browser support for container-type fixed-positioning containment improves uniformly in the future, this can be reconsidered.
