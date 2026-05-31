---
name: feedback-no-obvious-comments
description: "Don't pad CSS/JS/Liquid with comments that restate what the code already says. Only comment non-obvious WHY."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ab9cc0c1-4f1a-4176-8ad3-25f82704a95e
---

Don't add comments that describe what the code already shows. Especially in CSS: declarations like `position: fixed`, `transform: translateY(0)`, `display: grid` don't need a one-line summary above them. Same for JS/Liquid — well-named selectors, properties, and identifiers are self-documenting.

**Why:** Adrian called this out after I added long comment blocks above almost every CSS rule explaining what each property did. It clutters the file and makes scans slower. The code itself is the documentation; comments compete for attention.

**How to apply:**
- Default: write no comment.
- Only add one when the WHY is non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader who knows CSS/JS/Liquid.
- Strip "this rule does X" / "this sets Y so Z happens" lines. If the code reads cleanly, the comment is noise.
- Block comments at the top of a file/section (architecture, top-of-component intent) ARE still useful — those describe a concept the code can't show on its own. The ban is on per-rule narration.
- See also [[feedback-short-bullet-explanations]] for the conversation-side analog.
