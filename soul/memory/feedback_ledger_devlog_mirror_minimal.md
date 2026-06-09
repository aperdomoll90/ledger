---
name: feedback_ledger_devlog_mirror_minimal
description: "Per-project devlog mirrors in Ledger are one-line-per-session historical checkpoints. The repo's docs/devlog.md is canonical for extended narrative. Do NOT mirror full session bodies into Ledger."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7f7b0c42-1c80-4c94-b8b9-39ea4b6947ed
---

Per-project devlog mirrors in Ledger (e.g. `starbrite-shopify-devlog` #189, `ledger-devlog` #28, `claude-skills-devlog` #195) are minimal historical checkpoints — one line per session in the format `YYYY-MM-DD | project | Session N: brief summary`. They are for cross-project semantic search and chronological orientation, not for narrative.

The CANONICAL extended documentation lives in the repo's `docs/devlog.md`. Full session bodies (parts, decisions locked, files touched, for-next-session lists) go there and only there.

**Why:** the Ledger devlog mirror is a search index, not a narrative store. Two pragmatic reasons. (1) The Postgres statement-timeout caps writes around ~150-200 KB. Treating the mirror as a full session-body store (as `starbrite-shopify-devlog` #189 did, growing to 220 KB) makes it un-updatable; the write hits the timeout and aborts. (2) Duplicating narrative in two places creates drift — the repo devlog and the Ledger mirror diverge, and Adrian has to remember which is canonical. The one-line format makes it obvious the mirror is just a pointer.

**How to apply:** when writing to a per-project devlog mirror in Ledger, ALWAYS use the one-line-per-event format. Each line says when, what project, what session number, and a brief summary (one sentence, ideally under 200 chars). Group multiple events from the same session as separate lines under the same date. Never paste session bodies. If a session needs three lines of summary because three distinct things shipped, that's fine — three one-line entries. Push the full narrative to the repo `docs/devlog.md` instead. When auditing an existing mirror that's grown bloated, propose a rebuild that compresses each session to one line; do not attempt to amend the bloated version (it's likely un-updatable due to the statement-timeout).
