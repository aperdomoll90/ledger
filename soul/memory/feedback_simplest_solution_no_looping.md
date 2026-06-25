---
name: simplest-solution-no-looping
description: "Prefer the minimal fix; on visual/CSS work don't over-engineer or loop, confirm the target instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 221aa6b6-c2a3-49b6-9edf-998aba0d0234
---

On styling/layout work, do the smallest change that satisfies the ask. Don't add secondary mechanisms (extra DOM wrappers, pseudo-element background layers, per-child transforms, JS, new states/animations) when a 1-2 line change works.

**Why:** In the Starbrite header/nav saga (2026-06-23) I repeatedly re-architected, pseudo background layers, content-slide transforms, `data-scrolled` navy bars, mobile whole-header transforms, when Adrian wanted a minimal tweak. He reverted several times and got frustrated ("you keep looping the same errors back and forth"). Every resolution was the simpler option (revert + one targeted fix).

**How to apply:** If a visual fix doesn't land after 1-2 attempts, STOP iterating and ask one precise question about the exact target behavior. When the user says "just do X and change Y," do exactly that, no extra layers. When asked to revert, revert ALL of it (across CSS + JS + liquid), not partially. Reach for [[feedback_css_first_over_js]] / [[feedback_pseudo_elements_for_decorative_overlays]] only when they ARE the minimal solution, not to gold-plate.
