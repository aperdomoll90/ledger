---
name: feedback_dashboard_non_negotiable
description: project-status-dashboard must be updated at every checkpoint — never skip it, never treat it as optional
type: feedback
---

The global `project-status-dashboard` (Ledger #29) must be updated at every single checkpoint, no exceptions. It is not optional. It is not "update if something changed." It is updated alongside the devlog every time.

**Why:** Session 33 updated the devlog but not the dashboard, causing Session 34 to start with stale data (showing Session 32 state). The dashboard is the primary source of truth for session start briefings — if it drifts from the devlog, future sessions lose context on what was actually done.

**How to apply:** At every checkpoint, update both the devlog AND the dashboard. If you're unsure whether the dashboard needs changes, read it and verify — don't assume it's current. The checkpoint checklist order is: devlog → project-status-dashboard → per-project dashboards → architecture notes → git status.
