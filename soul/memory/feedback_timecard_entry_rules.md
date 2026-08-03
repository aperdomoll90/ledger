---
name: timecard-entry-format-rules
description: Timecard entry rules - one block per work-day (sleep-cycle boundary, not midnight), uniform bold header, hours always {{TODO}}, no clock times in headers
metadata:
  node_type: memory
  type: feedback
  originSessionId: 26b396dc-f723-40f2-a399-9667ff2b7e99
---

When writing or restructuring a project timecard (e.g. Starbrite #198), the in-progress week is organized as ONE entry per work-day, not per work-session:

- **One block per day.** Multiple Charlie sessions on the same day merge into that day's single block (one prose paragraph, or a short "continuing..." paragraph, plus one `- **Internal:**` file line). Never append per-session `(cont.)`, `(cont. 2)` blocks - that fragments the day and scrambles ordering.
- **Day boundary follows Adrian's sleep cycle, not calendar midnight.** A session that runs past midnight is still the SAME work-day until he sleeps; the next day begins after he sleeps. Late-night work (e.g. 2am) belongs under the date the session started, as a "continuing past midnight" note, NOT under the new calendar date.
- **Hours are always `{{TODO}}`.** Adrian fills the actual billable number when assembling the invoice. NEVER derive hours from start/finish clock times - the raw span includes breaks and is ~65% unreliable (this is also why clock times are not authoritative and do not belong in the entry).
- **No clock start/finish times in day headers.** Uniform header format only: `**{Day} {MonDD}: {N or {{TODO}}} hrs**`. Put devlog session-range cross-refs in the `- **Internal:**` line (`docs/devlog.md (Sessions X-Y)`) and any cross-midnight boundary note in the prose, never in the header.

**Why:** the timecard is Adrian's billing source. Per-session fragmentation, calendar-midnight day splits, and auto-derived hours all corrupt the per-day totals he bills from. (Established 2026-06-27 after consolidating the Starbrite week-of-06-22 from ~15 fragmented `(cont.)` blocks back to one-per-day, dropping a duplicate, and folding a past-midnight session back under its start date.)

**How to apply:** during the [[session-checkpoint]] timecard step, if the current work-day already has a block, MERGE into it; otherwise add one new uniform `**{Day} {MonDD}: {{TODO}} hrs**` block. See [[timecard-collapse-after-invoice-sent]] for the past-week pruning rule.
