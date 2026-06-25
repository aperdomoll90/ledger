---
name: feedback-pointer-events-parent-not-child
description: "when an invisible-but-still-present overlay blocks clicks, fix pointer-events on the PARENT, not its children"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9f9ef73a-af32-445d-9ab8-0c4bc05ba20a
---

When a `position: fixed` or `position: absolute` parent stays in the layout (full-size or partial) but its children are faded/translated/hidden, click-blocking has to be fixed on the PARENT itself. Disabling `pointer-events` on the children does nothing because the parent's bounding box still intercepts clicks before they ever reach children.

**Why:** discovered on Starbrite header (2026-06-17 S52). `.c-header` is `position: fixed; top: 0; height: 5rem; z-index: 100`. Scroll-driven animations translate the logo + search up and fade opacity to 0 between 10svh and 30svh. Past 30svh the header looked empty but the FILTER button on the PLP sort bar (z-20, sticky at top: 0) couldn't be clicked. Added `pointer-events: none` to the child keyframe — no change. The header itself was the blocker.

**How to apply:**

When fixing click-through for a faded overlay:
1. Identify the highest-z-index element whose bounding box intersects the click target. That's the blocker.
2. Apply `pointer-events: none` to THAT element, not its children.
3. If using a CSS keyframe animation to fade out, include `pointer-events` in the keyframe applied to the parent.

Discrete-property gotcha: `pointer-events` is discrete (steps, not interpolated), so in a keyframe animation it would flip at 50% of the timeline by default. To make it flip at the END of the fade-out (so the element is still clickable during the fade), use a 99% checkpoint:

```css
@keyframes my-fade {
  0% { pointer-events: auto; opacity: 1; }
  99% { pointer-events: auto; }
  100% { pointer-events: none; opacity: 0; }
}
```

Same pattern applies for `visibility: hidden` if you need that too.
