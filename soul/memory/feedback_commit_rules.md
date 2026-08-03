---
name: commit-rules
description: "Commit message rules. Short messages, no AI co-author lines. Hook enforces co-author; this memory enforces brevity."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b230ee6f-768b-4040-a74c-8e0bb59546d9
---

Commit rules:

1. **NEVER run `git commit` yourself. Ever.** Adrian does all commits, full stop (stated 2026-06-19, re-stated firmly 2026-06-29 after I violated this). Even when he approves the work ("looks good", "lets do it", "yes", "lets go", "do it"), that approves the *change or the next step*, NOT a commit. A skill (e.g. brainstorming/writing-plans) instructing me to "commit the doc" does NOT override this; Adrian's rule wins. Stage if helpful, write the message in chat for him to use, but do not execute the commit. This supersedes the older "no committing without approval" — it is now "no committing, period."
2. **Short messages.** One-line summary (under 72 chars). Optional body: 2-3 bullet points max. No multi-paragraph essays. The diff tells the story, the devlog has context.
3. **No AI co-author lines.** Never include `Co-Authored-By` with Claude/AI/bot attribution. Enforced by hook (`~/.claude/hooks/strip-ai-coauthor.sh`) but also a behavioral rule: don't even try.

**Why:** Commits are Adrian's to own. Long commits are noise. AI attribution is unprofessional in client-facing work.

**How to apply:** When work is done and verified, propose the commit message; let Adrian run the commit.
