---
name: image-sizing-height-only-aspect
description: "Size images by ONE dimension (height OR width) with the other auto; never both, and stop flex-item ancestors shrinking, or the aspect ratio deforms"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0f4d8ac6-cb48-41c4-8024-529f65e6d2b7
---

When sizing an `<img>`, constrain ONE dimension only (almost always `height: <value>`) and leave the other `auto`. Never set both `width` and `height` to fixed/relative values, and never let layout squeeze a dimension. The image's natural aspect ratio is preserved unless Adrian specifically asks to crop/reshape it.

**Why:** setting both dimensions (or letting one get squeezed) distorts the image. `object-fit: fill` is the default, so a forced box stretches the pixels. This bit us on `c-featured-pro__product-img`: it deformed up to ~20% horizontally at tight desktop widths.

**The flex gotcha (the actual root cause that time):** `width: auto` does NOT protect aspect ratio inside flexbox. The deforming pressure usually comes from a flex-item ANCESTOR, not the image. If the wrapper that holds the image is itself a flex item in a row, its default `flex-shrink: 1` lets a tight row squeeze it narrower than the image's aspect width; the image's `width: auto` then resolves to "fill the shrunken wrapper" while `height` holds, distorting it. Fixing `flex-shrink` on the image does nothing; the fix is `flex-shrink: 0` on the shrinking ancestor.

**How to apply:**
- Default image rule: `height: X; width: auto;` (or the inverse), nothing else dimensional.
- If the image lives in a flex container, walk EVERY flex-item ancestor between the image and the flex row; set `flex-shrink: 0` on whichever one shrinks below the image's aspect width. Verify by measuring rendered AR vs natural AR across narrow widths, not just the wide default.
- When debugging a deform, measure `clientWidth/clientHeight` vs `naturalWidth/naturalHeight` at a constrained width to prove it; AR drift = deformation.
- Keep `object-fit: contain` in reserve as a safeguard only when a fixed box is genuinely required.

Relates to [[feedback_no_px_for_sizing]] (use rem, but the dimension count is separate), [[feedback_css_shorthand_resets_subproperties]], and [[feedback_simplest_solution_no_looping]] (confirm the squeeze source before editing; the first fix here was wrong).
