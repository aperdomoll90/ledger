#!/bin/bash
# Session welcome — greet and show recent work from Ledger + devlogs

echo "Hello Adrian."
echo ""

# Always show the master dashboard first
DASHBOARD=$(ledger get project-status-dashboard 2>&1)
if [ $? -eq 0 ] && [ -n "$DASHBOARD" ]; then
  echo "## Project status dashboard"
  echo "$DASHBOARD"
  echo ""
else
  echo "## WARNING: project-status-dashboard not found"
  echo "The master dashboard is missing or unreachable. Check Ledger."
  echo ""
fi

# Then show per-project status docs
STATUS=$(ledger list -n 3 -t project-status 2>/dev/null)
if [ -n "$STATUS" ]; then
  echo "## Per-project status"
  echo "$STATUS"
  echo ""
fi

# If inside a repo, show its devlog tail
if git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  DEVLOG="$REPO_ROOT/docs/devlog.md"
  if [ -f "$DEVLOG" ]; then
    echo "## Last devlog entry ($(basename "$REPO_ROOT"))"
    # Print from the last ## heading to end of file
    tail -40 "$DEVLOG" | tac | sed '/^## /q' | tac
    echo ""
  fi
fi
