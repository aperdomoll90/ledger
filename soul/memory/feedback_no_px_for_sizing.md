---
name: No px for sizing
description: Use rem (and svh/dvw for viewport) instead of px in CSS sizing values
type: feedback
originSessionId: 705c6049-c5bd-4612-aa74-509b63a3105e
---
Use responsive units instead of px in CSS sizing values.

**Why:** Adrian's house rule, enforced by Stylelint via `ledger lint --personal`. Px values don't scale with user font preferences and break responsive design.

**How to apply:**
- Use `rem` for widths, heights, paddings, margins, gaps, font-sizes, border-radius, flex-basis
- Use `svh` (small viewport height) and `dvw` (dynamic viewport width) for viewport-relative sizing
- Never use `px`, `vh`, `vw`, or `dvh` for sizing
- 1px borders are still acceptable (`border:1px solid ...`) since stylelint convention often allows them
- Convert: 16px = 1rem, 22px = 1.375rem, 4px = 0.25rem, etc. (assuming root 16px)
- Apply this rule to **any line I touch** going forward; don't blanket-rewrite existing legacy px in mockup files unless asked.

**Note for mockup wireframes** (`star-brite-*-reference.html`): These files use CSS `zoom: 2.4` and are full of px values for pixel-perfect zoomed rendering. Retrofitting them all to rem is out of scope for ad-hoc edits but may be a separate migration task.
