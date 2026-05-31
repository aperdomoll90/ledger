---
name: feedback-reference-html-wins
description: "When a project has a canonical reference HTML (per CLAUDE.md section 2 in starbrite-shopify, or analog), default to mirroring its structure and behavior instead of re-litigating architectural choices; concise concrete questions instead of verbose option-comparison"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8c389a53-bb8a-4634-a042-953d8aecb9fc
---

When the project has a canonical reference HTML / mockup designated as source of truth in CLAUDE.md or equivalent, default to mirroring its structure and behavior. Do not re-open architectural debates the reference has already resolved (overlay vs in-flow, modal vs in-page, etc.).

**Why:** Adrian got frustrated during the PDP specs drawer brainstorm when I framed an overlay-vs-in-flow question that the reference HTML had already answered (in-flow, no trigger). The starbrite CLAUDE.md section 2 explicitly names the reference HTMLs as canonical for component anatomy, layout, and behavior. Verbose multi-option comparisons of decisions that are already settled waste tokens and feel like I'm not reading the existing material.

**How to apply:**
- Before asking a design question, check CLAUDE.md for a canonical-reference clause and skim the relevant reference HTML.
- If the reference covers the question, present the decision as already made and move on. Only ask about gaps where the reference is silent or marked `data-status="proposed"`.
- Keep brainstorm questions short and concrete (one or two lines per option). Same short-bullet rule as [[feedback-short-bullet-explanations]].
- "Drawer", "panel", "modal" in component names are not architectural commitments by themselves; the reference markup is.
