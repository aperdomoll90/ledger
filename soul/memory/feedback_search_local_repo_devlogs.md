---
name: Search local repo devlogs alongside Ledger
description: When investigating historical setup work or "did we already document this", search `~/repos/*/docs/devlog.md` AND `~/Documents/*/docs/` files in addition to Ledger. Local devlogs are often the canonical source; Ledger-side summaries lag behind.
type: feedback
originSessionId: 939a8e43-d003-485e-b6ee-a5ad90c1ce52
---
When the user asks whether something is documented, or you are reconstructing how a system was set up, **search local repo devlogs in addition to Ledger**:

- `~/repos/<project>/docs/devlog.md`
- `~/repos/<project>/docs/architecture-*.md`
- `~/repos/<project>/docs/setup-*.md`
- Local working-doc folders like `~/Documents/<client>/.../docs/`

**Why:** the dashboard's `Devlog:` field for several projects is `{{TODO}}` or marked stale (e.g. ledger-devlog #28 "S39-S58 narrative gap"). The canonical session-by-session record lives in the local repo's `docs/devlog.md`, not in Ledger. Searching only Ledger and concluding "no documentation exists" is wrong and creates work the user has to push back on.

Concrete example (2026-05-04, perdomostudio email infra session): the email setup was logged in `~/repos/atelier/docs/devlog.md` under "Session 3 — 2026-04-12, Set up Perdomo Studio business email and design Reed email triage agent." Ledger searches alone returned only `user-profile` (#7) listing infrastructure as a skill but no setup details. The user had to ask "are u sure there are no references of this in our logs or docs?" twice before I searched the right place.

**How to apply:**

1. When user asks "is this documented" or "what did we do for X", run BOTH:
   - Ledger search (`mcp__ledger__search_documents` + `search_by_keyword`)
   - Local file grep across `~/repos/*/docs/` and any `*-devlog.md` / `*-architecture.md` files
2. If the project has a known canonical devlog file (e.g., `~/repos/atelier/docs/devlog.md`, `~/repos/ledger/docs/devlog.md`, `~/repos/claude-skills/docs/devlog.md`), grep that file specifically for the topic.
3. When summarizing what's documented, cite both sources: "Ledger doc X (#id) and local file Y line Z." If only one source has the info, say so explicitly.
4. Never claim "no documentation exists" until both Ledger and local repo devlogs have been searched.
