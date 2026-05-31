---
name: feedback_css_shorthand_resets_subproperties
description: "CSS shorthand properties (transition, background, font, border, flex) silently reset ALL sub-properties to their initial values, even ones not named in the shorthand declaration"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ab9cc0c1-4f1a-4176-8ad3-25f82704a95e
---

CSS shorthand properties set ALL of their sub-properties at once. Any sub-property not explicitly named in the shorthand is reset to its INITIAL value. This is silent — no warning, no lint error, just unexpected behavior at cascade resolution time.

**Why:** Diagnosed in starbrite-shopify search component. Per-section row rules used `transition: opacity 0.3s ease-in-out, transform 0.3s ease-in-out, color 0.15s ease-in-out` shorthand. That shorthand silently set `transition-delay: 0s, 0s, 0s` (initial value) for all three properties because it wasn't explicitly typed. The `[data-open="true"]` rule's `transition-delay: calc(var(--index, 0) * 0.5s)` longhand had the same specificity but loaded earlier in the cascade, so the per-section shorthand's implicit `0s` won. Stagger animation appeared dead. DevTools showed `transition-delay` struck through with no obvious cause — the shorthand wasn't visually setting `transition-delay`, so the override looked correct, but at parse time it was implicit.

**How to apply:** When composing CSS where one sub-property comes from one rule and a different sub-property comes from another rule on the same element, use LONGHANDS in BOTH rules. Examples:

- `transition` -> `transition-property` + `transition-duration` + `transition-timing-function` + `transition-delay`
- `background` -> `background-color` + `background-image` + `background-position` + `background-size` + `background-repeat` + `background-attachment` + `background-origin` + `background-clip`
- `font` -> `font-family` + `font-weight` + `font-style` + `font-size` + `line-height` + `font-variant` + `font-stretch`
- `border` -> `border-color` + `border-style` + `border-width`
- `flex` -> `flex-grow` + `flex-shrink` + `flex-basis`

Longhands only touch the sub-properties they name; everything else stays at whatever the cascade last assigned. Shorthand obliterates.

**Quick check before using shorthand:** "Could ANY other rule on this element need to control a sub-property I'm NOT naming here?" If yes, use longhand.

**Related:** [[feedback_no_font_shorthand]] (the project already banned `font:` shorthand for this exact reason); this rule generalizes to all shorthands.
