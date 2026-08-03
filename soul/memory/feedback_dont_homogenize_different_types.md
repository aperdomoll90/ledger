---
name: feedback-dont-homogenize-different-types
description: "Don't standardize structure across things that are genuinely different kinds; consistency is a means, not a goal in itself"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 01975b25-cbc6-43e8-b60c-f707f35fdfa8
  modified: 2026-07-31T19:04:38.666Z
---

When two things share a container but are different in kind, do not propose unifying their structure just to make them consistent. Structure should follow the work.

**Why:** on 2026-07-31 Charlie proposed applying one section-header schema to every card in the project-status-dashboard. Adrian declined: "they are different types." Ledger is a product, Starbrite is client delivery, Atelier is infrastructure, and each needs different sections (client work needs `Blocked` with an owner; a product needs `Current Task`). The uniformity argument was aesthetic, dressed up as making the cards "diffable against each other" - something nobody actually does. This is the same instinct behind [[feedback-breakpoints-use-px]], where converting distinct breakpoint values to one number was rejected as homogenizing away real differences.

**How to apply:** before proposing a standardization pass, ask what breaks today because of the inconsistency. If the answer is "nothing, it just looks uneven," don't propose it. Standardize only where divergence causes actual cost: a rename that leaves orphan references, a duplicated fact that drifts, a convention that a tool enforces. Naming and structure that differ because the underlying things differ are correct, not drift.
