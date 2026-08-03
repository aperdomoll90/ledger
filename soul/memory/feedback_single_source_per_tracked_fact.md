---
name: feedback-single-source-per-tracked-fact
description: A tracked number or status lives in exactly one place per document; every other mention points at it instead of restating it
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 01975b25-cbc6-43e8-b60c-f707f35fdfa8
  modified: 2026-07-31T19:00:04.610Z
---

Any fact that changes over time (invoice number, running total, latest commit, branch state, week closed through) is written in exactly ONE place in a document. Every other place that needs it refers to that location rather than restating the value.

**Why:** on 2026-07-31 the project-status-dashboard carried the Starbrite billing state twice. The metadata block said "closed through 07-20, latest sent SB-2026-013, next is 014". A bullet 30 lines down said "closed through 07-13, sent SB-2026-012, next invoice is 013". One full invoice cycle apart, and neither was labeled as the copy, so there was no way to tell which was current without opening the invoice folder. Whoever updated the doc updated one copy and not the other. This is the same failure as [[feedback-invoices-are-billing-source-of-truth]] but inside a single document rather than across two systems.

**How to apply:** when adding a changing value to a doc, grep the doc for the value's neighbours first (invoice prefix, "running total", commit hash, branch name). If a copy exists, update it in place instead of adding a second one. When restructuring a doc, treat two statements of the same fact as a defect to resolve, not as content to preserve; resolve it against the actual source (invoice PDFs, `git log`, the file itself), never by picking whichever copy reads more confidently. Mark the surviving location `(canonical)` when the doc is long enough that a reader might look in two places. Related: [[feedback-dashboard-is-board-not-journal]], [[feedback-ledger-canonical-not-local-mirror]].
