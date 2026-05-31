---
name: pill-border-radius is circle-only (only valid on square elements)
description: Personal token rule — `--pill-border-radius: 50%` renders as ellipse on non-square elements. Use literal half-height value or a dedicated pill-shape token instead.
type: feedback
originSessionId: 0b65f9cd-6611-4412-8ec4-aeef1780c24b
---
`--pill-border-radius: 50%` only renders as a circle on SQUARE elements (width === height). On any non-square element (e.g., search bars with auto/flex width × fixed height), `border-radius: 50%` creates an ellipse, not a pill.

**Why:** Surfaced 2026-05-09 (Starbrite home mobile-first refactor, S72) when the nav search rendered as a stretched ellipse instead of the pill shape the SVG specified. The token name implies "pill" but the value (50%) only works on squares. The 6 other usages in home reference are all on square elements (badges, icons, lockup marks, head circles) and render correctly as circles.

**How to apply:**
- For square elements that should be CIRCLES: `border-radius: var(--pill-border-radius)` (= 50%) is correct.
- For non-square elements that should be PILLS (rounded rectangles with half-height corners): use a literal half-height rem value (e.g., `border-radius: 0.71875rem` for a 1.4375rem tall element) OR introduce a `--pill-shape-radius: 9999px` token that always renders as a pill regardless of dimensions.
- When auditing token usage in CSS, flag any `--pill-border-radius` usage where the element's width and height aren't equal.
- Long-term fix considered for Starbrite: rename `--pill-border-radius` to `--circle-radius` and add `--pill-shape-radius: 9999px` as a separate token. Queued in dashboard #29 Next list as of S72.
