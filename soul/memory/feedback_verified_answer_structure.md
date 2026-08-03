---
name: feedback-verified-answer-structure
description: "Preferred full answer shape: facts block, table, verification section naming independent sources, usable deliverable, held-action close"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 286edb85-9bd4-4d81-9cf5-9ed2e5f22f1d
  modified: 2026-08-03T16:37:18.541Z
---

Adrian's preferred answer shape, confirmed 2026-08-03 on the Starbrite SB-2026-014 invoice prep. Five parts, in this order:

1. **Facts block.** Fixed-width, one label + value per line, no prose. Extends [[feedback-facts-first-then-detail]].
2. **Table** for anything countable (hours, dates, fields to check), with the total as its own row.
3. **Verification section.** Name each independent source and what it says, one line each, then an explicit verdict on whether they agree. Close it with the single thing the data cannot settle, stated as a question for him.
4. **Deliverable, usable as-is.** Copy-paste ready, matching the format of the artifact it goes into. Write it to a file too when it is long enough to be awkward to select out of chat.
5. **Held-action close.** State exactly what I will do next, and that I will not do it until he says. No action taken on inference.

**Why:** he acts directly on these answers (sends the invoice, signs it). The verification section is what makes the numbers trustworthy without him re-deriving them, and it only works when the sources are genuinely independent, so agreement is evidence rather than one record echoing another. The held-action close is what lets him read the whole thing without watching for side effects.

**How to apply:** use for anything he will act on directly: billing and invoices, status reports, audits, migration plans, reconciliations. Pick sources that were written independently (Ledger doc, repo devlog, git history, vendor portal), never two views of the same file. Say plainly when they disagree and which one wins. Never fold step 5 into a question he has to answer before he gets the deliverable. Related: [[feedback-invoices-are-billing-source-of-truth]], [[feedback-announce-before-editing]], [[feedback-short-bullet-explanations]].
