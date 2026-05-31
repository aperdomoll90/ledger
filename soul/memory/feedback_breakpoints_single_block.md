---
name: Breakpoints live in a single block at the bottom
description: Adrian's CSS rule — all responsive overrides for a stylesheet collect into one @media (or @container) block at the bottom of the file, never nested inside individual BEM blocks
type: feedback
originSessionId: 0ae94323-e42c-4fed-aba1-851786f9fe39
---
All breakpoint overrides for a stylesheet must live in a SINGLE @media (or @container) block at the bottom of the file. Do NOT nest @media inside individual rules / per-component blocks.

**Why:** Established in claude-skills S72 work on the home reference mobile-first refactor. Single per-breakpoint block at the bottom keeps the mobile-first base styles uninterrupted, makes the breakpoint surface easy to scan in one place, and prevents per-component drift where one rule has a `(width >= 900px)` and another has `(min-width: 900px)`. Saved as `Adrian's rule, S72` in the starbrite-shopify-devlog.

**How to apply:** When writing any stylesheet (theme CSS, section-scoped CSS, design system CSS, mockup CSS):

```css
/* Base / mobile-first rules */
.c-block { /* base */ }
.c-block__element { /* base */ }
.c-block--modifier { /* base */ }

/* All breakpoint overrides at the bottom */
@media (width >= 900px) {
  .c-block { /* desktop */ }
  .c-block__element { /* desktop */ }
}
```

NOT:

```css
.c-block {
  /* base */
  @media (width >= 900px) { /* nested override */ }
}

.c-block__element {
  /* base */
  @media (width >= 900px) { /* nested override */ }
}
```

Native CSS nesting can technically place @media inside a rule. We don't use that capability. Breakpoints always collect at the bottom.
