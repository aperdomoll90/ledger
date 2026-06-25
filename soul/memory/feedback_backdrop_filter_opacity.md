---
name: feedback-backdrop-filter-opacity
description: "backdrop-filter renders invisible when the element's own opacity is below 1; use background-color alpha for dim instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9f9ef73a-af32-445d-9ab8-0c4bc05ba20a
---

When animating a `backdrop-filter: blur(...)` overlay between hidden and visible states, NEVER animate the element's own `opacity`. Browsers composite `backdrop-filter` into the element's painted output, then multiply that whole output by `opacity`. At any opacity below 1 the blur fades along with the element and becomes visually indistinguishable from no blur.

**Why:** discovered on Starbrite PLP backdrop (2026-06-17 S52). Added `backdrop-filter: blur(1rem)` to a backdrop element that already had `opacity: 0 -> 0.55` show/hide. Visual result: zero perceptible blur despite the property applying per DevTools.

**How to apply:** for any blurred-backdrop show/hide:
- Keep element `opacity: 1` throughout.
- Animate `background-color` from `transparent` to `color-mix(in srgb, var(--color-token) 55%, transparent)` (or rgba literal) for the dim.
- Animate `backdrop-filter` from `blur(0)` to `blur(Xrem)` for the blur.
- Animate `visibility` for the show/hide if needed.

If a backdrop needs to fade out smoothly, also fades the dim and blur via the same transition. No element-level opacity, ever.
