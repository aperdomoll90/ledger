---
name: transient-spec-docs-stay-local
description: Pre-implementation research / spec / plan docs are transient and stay local (not Ledger). Used to drive implementation and to update durable architecture docs, then deleted with explicit permission.
type: feedback
originSessionId: a26d5284-835f-4a3c-9916-031a1a007742
---
Research, specs, and design plans that exist *only to drive an upcoming implementation* are transient. They:

- Stay in local files, **never get pushed to Ledger** (unless Adrian explicitly asks).
- Get used to drive the build and to update durable architecture / reference docs (which live in Ledger).
- Get deleted after the implementation lands and the durable docs are updated. **Never delete without explicit permission first.**

**Why:** Ledger is a knowledge base of durable, search-relevant knowledge. Implementation scratch work clutters it and creates stale references the moment the build deviates from the plan. The durable learnings extracted from a spec belong in architecture docs; the spec itself is scaffolding and should not survive past its usefulness.

**How to apply:**

- When asked to write a spec / plan / design doc for an upcoming implementation: write to a local file, do not push to Ledger.
- The `~/.ledger/drafts/` convention is for **new docs that will be pushed to Ledger** (in-progress Ledger doc creation). Transient implementation specs need a different local folder.
- If the user explicitly says "save this to Ledger" or "this is a permanent reference", that is the override.
- Post-implementation, ask before deleting the local spec. Confirm the durable learnings have already been folded into architecture docs.
- Distinguish *transient* (deletable) from *durable* (Ledger) at the moment you start writing, not after. Asking up front avoids wasted Ledger pushes that need to be torn down later.
