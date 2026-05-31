---
name: svg-composited-layer-repaint
description: "When an SVG path's stroke-dashoffset is updated via JS inside a transformed/composited ancestor (e.g. a translateX'd scroll-jack track), Chrome's compositor can skip the repaint because the parent layer's bitmap is cached. Symptom: rope draws only when DevTools forces a paint. Two-part fix: setAttribute over style.X for SVG stroke properties, plus transform: translateZ(0) on the SVG to promote it to its own composited layer."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d5973165-c85b-4b7c-b505-05e20bbf19d9
---

Any SVG path whose stroke-dasharray / stroke-dashoffset is animated by JS while the SVG sits inside an ancestor that has been composited (most commonly via `transform`, `will-change`, or `filter`) is vulnerable to a Chrome compositor optimization that skips repaints. Symptom: the path renders in its initial state and never visually updates, even though the JS is correctly mutating the values. The most diagnostic tell is that the rope starts drawing the moment you search for the path element in DevTools (search forces a synchronous paint pass).

**Why:** the compositor caches the parent layer's bitmap and assumes that property changes on descendant SVG elements via CSSOM inline style (`element.style.X = Y`) don't dirty the layer if no layer-promoting property was touched. This heuristic is wrong for SVG stroke properties under some conditions. Affects scroll-driven SVG animations inside translateX'd tracks (the standard sticky-translate scroll-jack pattern), parallax SVG paths, any composited carousel.

**How to apply:** whenever you build a scroll-driven SVG animation where the path lives under a transformed parent, do BOTH of these:

1. **Set SVG stroke properties via `setAttribute('stroke-dashoffset', value)`** instead of `element.style.strokeDashoffset = value`. The SVG presentation-attribute pipeline marks the layer dirty more reliably than the CSSOM inline-style pipeline does for SVG stroke properties. Same for `stroke-dasharray` setup. Apply throughout setup + every scroll-driven update + edge-case fallbacks.
2. **Promote the SVG to its own composited layer via `transform: translateZ(0)` in CSS.** This separates the SVG's repaint invalidation from the parent layer's bitmap caching. Stroke-property changes now hit the SVG's own layer's dirty path. Cheap (no actual transform applied) and doesn't affect visual layout.

Either fix alone is often insufficient on Chrome; combine both. Other layer-promoters (`will-change: transform`, `opacity: 0.999`) work too but `translateZ(0)` is the cheapest and most explicit.

First surfaced in starbrite-shopify S21 (2026-05-28) on the About Us horizontal-scroll timeline, where the rope SVG sat inside the translateX'd `.c-about-h__track`. The DevTools-search-makes-it-work symptom was the diagnostic. Errorlog entry: `starbrite-shopify-errorlog` (#204) under `## 2026-05-28 (S21)`.

Related: [[feedback_css_first_over_js]] (broader principle that scroll-driven visual effects belong in CSS where possible; this memory documents the bailout for the JS path that's unavoidable in this pattern).
