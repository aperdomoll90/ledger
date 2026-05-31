---
name: commit-rules
description: Commit message rules. Short messages, no AI co-author lines. Hook enforces co-author; this memory enforces brevity.
type: feedback
---

Two commit rules:

1. **Short messages.** One-line summary (under 72 chars). Optional body: 2-3 bullet points max. No multi-paragraph essays. The diff tells the story, the devlog has context.
2. **No AI co-author lines.** Never include `Co-Authored-By` with Claude/AI/bot attribution. Enforced by hook (`~/.claude/hooks/strip-ai-coauthor.sh`) but also a behavioral rule: don't even try.
3. **No committing without approval.** Always present the proposed commit and wait for Adrian to say go.

**Why:** Long commits are noise. AI attribution is unprofessional in client-facing work. Unapproved commits break trust.

**How to apply:** Every commit, no exceptions.
