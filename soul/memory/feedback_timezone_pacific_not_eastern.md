---
name: feedback_timezone_pacific_not_eastern
description: "Adrian is in California (Pacific); the machine/injected clock is Eastern and runs ahead, so interpret dates in Pacific"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e321129f-2dd4-453b-91b2-9c31b4069e0c
---

Adrian is in **California (Pacific time)**. The machine clock and the harness-injected "Today's date" are **Eastern (EDT/EST)**, which runs ~3 hours ahead. So after ~9 PM Pacific the injected date is already the NEXT calendar day, and "today" per the system is wrong for Adrian.

**Why:** on 2026-07-13 the injected date read 2026-07-14 (Eastern) while it was still Monday ~11 PM in California. This mislabeled timecard day-blocks and devlog session dates (a billing-sensitive error, since work billed to the wrong day).

**How to apply:** before stamping any date on a devlog entry, timecard day-block, dashboard `Last updated:` line, or billing record, resolve the real Pacific date with `TZ=America/Los_Angeles date`. Do not trust the injected "Today's date" or bare `date` for day boundaries. Timecard work-days follow Adrian's Pacific sleep cycle. When the injected date and Pacific disagree, use Pacific and flag it. Related: [[feedback_timecard_entry_rules]], [[feedback_timecard_collapse_after_invoice_sent]].
