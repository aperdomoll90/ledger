---
name: feedback-compression-must-not-drop-sole-copy
description: "Before deleting a line while condensing a doc, confirm its unique content exists elsewhere; sole-copy action items must survive or be raised"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 01975b25-cbc6-43e8-b60c-f707f35fdfa8
  modified: 2026-07-31T19:00:21.768Z
---

When condensing or restructuring a document, a line may only be deleted once you have confirmed every distinct fact in it appears somewhere else. Anything that exists in exactly one place either survives the rewrite or gets raised explicitly as "dropping this, confirm".

**Why:** on 2026-07-31, while rewriting the Starbrite dashboard card from 10.8 KB to 4.8 KB, Charlie deleted a bullet that contained both a stale duplicate of the billing state AND the only copy of an open todo ("add invoice numbers to timecard week headings") plus the only reference to the invoice PDF folder. The stale half justified deleting the line; the unique half was lost with it. Adrian caught it. Compression makes this failure likely because the deletion decision is driven by the redundant part of the line, and mixed-content lines are exactly what bloated docs are made of.

**How to apply:** long bullets usually pack several facts (status + diagnosis + fix + a caveat + a path). Before cutting one, split it mentally and check each fragment: is this restated elsewhere, is it a live todo, is it the only pointer to a file or folder? Grep the doc for distinctive tokens (a path, an ID, a filename) rather than trusting recall. Sole-copy action items move to the appropriate section; sole-copy paths get folded into the surviving line. State in the summary what was dropped and why, so the deletion is reviewable rather than silent. Related: [[feedback-single-source-per-tracked-fact]], [[feedback-dashboard-is-board-not-journal]], [[feedback-doc-changes-require-approval]].
