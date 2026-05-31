---
name: feedback_agent_state_not_project_docs
description: Agent-generated session handoff and continuity files are operational state, never project documentation; do not list, share, or store them alongside client deliverables
type: feedback
originSessionId: fae17486-bdf2-4e39-9662-9be76177d01c
---
Agent-generated session handoff, continuity, or "next session prompt" files (e.g., `*-session-handoff-*.md`, `*-next-session-*.md`) are agent operational state, not project documentation. They never belong alongside client-facing deliverables, base research, or working docs.

**Why:** Adrian flagged this when reviewing the Starbrite Working Docs inventory on 2026-05-04. The session-handoff file from S52 to S53 had drifted into the project folder, where it would have been mistakenly inventoried as deliverable material if shared with the client. It is not a project artifact: it has no value to anyone other than the next agent picking up the work, and it leaks internal process detail (session numbers, agent self-talk) into client-facing surfaces.

**How to apply:**
- When inventorying, organizing, or surveying any project folder, immediately flag any file matching agent-state patterns: session handoffs, "next session prompts", continuity notes, intake comments, scaffolding markers (`{{TODO: ...}}`, `{{PROPOSED: ...}}`) at the file level.
- Recommend Adrian delete or move them out of the project folder. Do not delete them yourself unless explicitly authorized.
- Never include them in deliverable inventories, attachment lists, or "what we have done" summaries to clients.
- The correct home for ongoing session continuity is the Ledger devlog or `docs/devlog.md`, not loose project folders.
- Applies universally across all client projects, not just Starbrite.
