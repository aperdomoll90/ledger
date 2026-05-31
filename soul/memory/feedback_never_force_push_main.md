---
name: feedback_never_force_push_main
description: NEVER amend pushed commits or force-push to main. Ever. No exceptions.
type: feedback
---

Three absolute rules:

1. **NEVER commit directly to main.** Always create a feature branch. Even for one-line fixes.
2. **NEVER amend a pushed commit.** If it's been pushed, it's immutable. Make a new commit.
3. **NEVER force-push to main.** No `--force`, no `--force-with-lease`, no exceptions.

**Why:** In S38, I committed directly to main, then amended that pushed commit, which force-pushed to main. This rewrites remote history, breaks other branches, and can lose work. Three rules broken in one action.

**How to apply:** Every change goes through a branch and PR. If you realize you're on main, `git checkout -b` before committing. If `git push` rejects, STOP and ask Adrian. Never work around a push rejection.
