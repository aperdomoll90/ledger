---
name: timecard-collapse-after-invoice-sent
description: Timecard pruning rule - collapse a week to total-only ONLY after its invoice is confirmed sent; keep current + unsent weeks fully detailed
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 26b396dc-f723-40f2-a399-9667ff2b7e99
---

When restructuring a project timecard (e.g. Starbrite #198) to keep it under the Ledger Postgres write-timeout (~150 KB+ fails to write), collapse a past week down to just its heading + total hours + billed amount ONLY after Adrian has confirmed that week's invoice was sent. Keep the full day-by-day breakdown for the current in-progress week AND for any finished week whose invoice has not yet been confirmed sent.

**Why:** the per-day breakdown is the source data Adrian uses to assemble each weekly invoice. Collapsing a week before its invoice goes out destroys the detail he needs to bill it. The detail is only safe to drop once billing for that week is locked. (Established 2026-06-26 after the S72 restructure collapsed three already-sent weeks; Adrian flagged that next week's data must not disappear before its invoice is sent.)

**How to apply:** during the [[session-checkpoint]] timecard step, only collapse weeks explicitly marked submitted/sent. If a finished week is not yet confirmed-sent, leave its full detail in place even though that keeps the doc larger. The current week always stays detailed.
