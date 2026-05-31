#!/bin/bash
# Git Context Injection — runs at SessionStart
# Injects live git state so agents know where the project stands

# Only run in git repos
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  exit 0
fi

BRANCH=$(git branch --show-current 2>/dev/null)
REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")

echo "## Git Context (auto-injected)"
echo "Repo: $REPO | Branch: $BRANCH"
echo ""

# Last 5 commits
echo "### Recent commits"
git log --oneline -5 2>/dev/null || echo "No commits yet"
echo ""

# Modified/untracked files
STATUS=$(git status --short 2>/dev/null)
if [ -n "$STATUS" ]; then
  echo "### Modified files"
  echo "$STATUS"
  echo ""
fi

# Flush devlog buffer if it exists
BUFFER="$HOME/.claude/devlog-buffer.txt"
if [ -s "$BUFFER" ]; then
  echo "### Commits since last session (from buffer)"
  cat "$BUFFER"
  echo ""
  # Clear buffer after reading
  > "$BUFFER"
fi
