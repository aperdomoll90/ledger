---
name: feedback-long-session-collapses-dates
description: "A Claude session left open across calendar days collapses all its work to one date at write-up time, corrupting devlog, timecard, and invoice dates"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d56d0c28-48e5-477e-8ccd-482baf118b6c
  modified: 2026-07-20T17:56:24.499Z
---

A Claude session left open across multiple calendar days writes up all of its work under a SINGLE date (the date of the write-up), because the transcript file's mtime reflects only the last write. Every downstream artifact inherits that wrong date: repo devlog heading, Ledger timecard entry, and ultimately the client invoice.

**Why:** discovered 2026-07-20 on starbrite-shopify. One session opened Tue 07-14 evening and stayed open through 07-20; its Session 91 write-up carried a flat `2026-07-20` stamp, so the timecard filed 5 days of real work as "Mon Jul 20" and the week of 07-13 appeared to be 2 days / 15 hrs when it was actually 4 days / 21.5 hrs. This is the same rollup failure recorded back in May (Session 9, five days hidden by a single Mon-dated entry), so it recurs.

**How to apply:**
- Close sessions at end of day rather than resuming them. That makes the date correct by construction instead of by forensics.
- When a devlog or timecard date looks suspicious, recover the real span from the per-message timestamps inside the session JSONL (they survive intact), bucketed by Pacific day. Do NOT trust the file mtime.
- Cross-check the recovered span against repo file mtimes. Two independent sources agreeing is what makes it billable evidence.
- Write the real span into the devlog heading (`## Session N - 2026-07-15 to 2026-07-17`) plus an explicit `Days worked:` line, never a single flat date.

Related: [[feedback-timecard-entry-rules]], [[feedback-timezone-pacific-not-eastern]], [[feedback-invoices-are-billing-source-of-truth]]
