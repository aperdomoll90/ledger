---
name: feedback-breakpoints-use-px
description: "CSS @media breakpoints use px values, not rem; breakpoints are the only place px is allowed"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6597cf20-f764-4888-b844-78e2bda1d7aa
---

In CSS `@media` queries, write the breakpoint width in **px**, not rem. Media-query breakpoints are the ONE place px is acceptable; everything else (sizing, spacing) stays rem per [[feedback_no_px_for_sizing]].

Convert each rem breakpoint to its EXACT px equivalent (rem x 16). Do NOT homogenize different breakpoints to one value: a `48rem` breakpoint becomes `768px`, NOT `900px`. Preserve the actual breakpoint, change only the unit. Conversions: 48rem->768px, 56.25rem->900px, 80rem->1280px, 90rem->1440px.

Standard value (starbrite-shopify): the primary mobile->desktop switch is `@media (width >= 900px)` (default a new single-breakpoint section to 900px). But a section that genuinely needs a different breakpoint keeps it (e.g. news-common-map switches at 768px). Multi-tier responsive grids keep all their distinct tiers in px (card-list grid: 768 / 900 / 1280 / 1440px); never collapse genuine column-count tiers into one breakpoint.

**Why:** the dominant convention in the codebase is px breakpoints; rem breakpoints (`56.25rem`, `48rem`) are drift. px keeps breakpoints scannable. Forcing every breakpoint to 900px would change real responsive behavior, the goal is consistent UNITS, not one universal value.

**How to apply:** when writing or editing a component's `@media` block, use px. Convert any rem breakpoint you touch to its exact px equivalent; don't snap it to 900px unless 900px is its true equivalent (56.25rem).
