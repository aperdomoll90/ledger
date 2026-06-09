---
name: feedback_dashboard_is_board_not_journal
description: project-status-dashboard
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7f7b0c42-1c80-4c94-b8b9-39ea4b6947ed
---

`project-status-dashboard` (#29) is a glanceable status board with pointers to deep docs. Each project card has a metadata block + Current State (facts only) + Known Issues + Current Task + Next. **Session narrative does not live here.** Hard targets: each project card ~40 lines max; total doc under 15 KB; every line under 500 chars; `Last updated:` line under 280 chars.

**Why:** twice now (S59 cleanup 91 KB -> 9 KB; S110 cleanup 76 KB -> 9.7 KB) the dashboard has bloated to 5-10x its target by session-by-session narrative accretion. The Postgres statement-timeout caps writes around ~150-200 KB, so the bloat eventually makes the doc un-updatable (the same failure that killed `starbrite-shopify-devlog` #189 at 220 KB). A board with one-line pointers to per-project devlogs is the design intent. Narrative belongs in the repo's `docs/devlog.md`, the project's Ledger devlog mirror (`#28`, `#189`, `#195`), or per-project deep docs (overview, architecture, errorlog). The dashboard's role is to answer "what's happening across all projects right now" in under a minute of skim-reading.

**How to apply:** when updating #29 during a checkpoint, every contribution lands as a FACT, not a story. Three concrete rules. (1) `Last updated:` line is ONE sentence (~200-280 chars): what shipped this session + immediate next step. Replace the prior content wholesale; do not fold the prior `Last updated:` text into the card's `Current State` bullets. (2) `Current State` bullets are factual current state ("240 tests passing", "Phase 4 cutover shipped (S49, PR #17)", "preprod pipeline locked: dev->preprod->prod") not session-by-session diaries ("S109: rebuilt the heritage band with... reshaped... fixed..."). Each bullet 1-2 lines, under 200 chars. Drop bullets that are pure history once they're stable state. (3) Before pushing, run `wc -c` on the temp file. If over 15 KB or any card section exceeds 60 lines, ABORT and refactor narrative into the per-project devlog before continuing. This is procedural, not advisory — the session-checkpoint skill carries the explicit pre-push check.
