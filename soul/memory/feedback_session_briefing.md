---
name: feedback_session_briefing
description: session-start skill triggers only on greeting phrases, not every session start
type: feedback
---

Only invoke the `session-start` skill when Adrian uses a session-opening phrase like "whats on for today", "lets get started", "briefing", or similar.

**Why:** Adrian changed this on 2026-04-09. The automatic briefing on every session was disruptive when he wanted to jump straight into a task. The SessionStart hook data still gets injected as background context, but the formatted briefing table should only appear when explicitly requested via a greeting.

**How to apply:** If the first message is a task request, skip the session-start skill entirely and work on the task. If the first message is a greeting or asks for status, invoke session-start and present the briefing table.
