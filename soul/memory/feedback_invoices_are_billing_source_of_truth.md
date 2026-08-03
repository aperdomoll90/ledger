---
name: feedback-invoices-are-billing-source-of-truth
description: "Reconcile billing totals from the invoice documents themselves, never from a hand-maintained running total inside the timecard"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d56d0c28-48e5-477e-8ccd-482baf118b6c
  modified: 2026-07-20T17:56:57.019Z
---

The `Running total` block inside a project timecard is hand-maintained and drifts silently. Reconcile billing from the invoice files (`~/Documents/Starbrite Working Docs/invoices` for Starbrite), which are the actual source of truth.

**Why:** discovered 2026-07-20. The starbrite-timecard running total read 6 weeks / 280 hrs / $12,600; the invoices showed 13 weeks / 534.5 hrs / $24,052.50. It had been ~7 weeks stale, understating billed work by $11,452.50. Two different readings could be inferred from the document alone (301.5 hrs vs 506.5 hrs) and BOTH were wrong. Only reading the invoice PDFs resolved it. The drift is structural: nothing cross-references invoice numbers to timecard weeks, so a gap or duplicate is invisible until someone reconciles by hand.

**How to apply:**
- Extract with `pdftotext -layout <invoice>.pdf` and grep `Invoice #`, `Issue Date`, `Billing Period`, `Total`, `Total Due`. Persist the extraction to a file under `~/.ledger/transient/` before reasoning over it.
- Check the invoice-number sequence for gaps AND duplicates. Gaps usually mean an invoice filed elsewhere; duplicates are real errors (SB-2026-004 and SB-2026-011 were each issued twice).
- Never write a running total inferred from arithmetic when the source documents are available. State the ambiguity and ask instead.
- Never mark a timecard week `(submitted)` or collapse its detail without an invoice proving it. Collapsing an unbilled week is how delivered work stops being billable.

Related: [[feedback-timecard-collapse-after-invoice-sent]], [[feedback-long-session-collapses-dates]]
