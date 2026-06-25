---
name: feedback-ledger-canonical-not-local-mirror
description: "Canonical tracked docs (timecard, dashboard, devlog) live IN Ledger; local ~/.ledger/ content files are stale orphans, never edit them as canonical"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c2c7469a-3073-4242-abd8-a5330db17613
---

For any document that has a home in Ledger (the timecard `starbrite-timecard` #198, `project-status-dashboard` #29, project devlogs/overviews, errorlogs), **Ledger is the single source of truth.** Do NOT read or edit a local copy under `~/.ledger/` (e.g. `~/.ledger/drafts/`, `~/.ledger/notes/`) as if it were canonical. The `~/.ledger/` local-mirror infrastructure was dismantled; leftover content files there are stale orphans that can look authoritative but are wrong.

**Why:** Asked to add a week to the Starbrite timecard, I edited the stale `~/.ledger/drafts/starbrite-timecard.md` (showed 40 hrs / 1 week, April-only) instead of canonical Ledger #198 (219 hrs / 5 weeks, current, with the week already populated). The local draft had even been flagged stale in a prior checkpoint. Editing the dead mirror means the real billing record never got updated, and nearly caused me to overwrite richer canonical data with my poorer reconstruction.

**How to apply:** When asked to update a timecard / dashboard / devlog / project doc, or anything that looks tracked:
1. Search Ledger by name FIRST (`search_documents` / `list_documents`). If it exists in Ledger, that is canonical, full stop.
2. Update it IN Ledger via the proper tools (`update_document` / CLI `ledger update <id>`), never a direct DB write (see [[feedback_never_bypass_rpc]]).
3. Treat `~/.ledger/` content files as stale unless explicitly told otherwise. Only live areas: `~/.ledger/transient/` (working specs/research per [[feedback_transient_spec_docs_local]]) and the preserved `.env` / `config.json` / `backups/`.
4. If a local file and the Ledger doc disagree, Ledger wins. Surface the discrepancy; never silently overwrite canonical billing/record data.
