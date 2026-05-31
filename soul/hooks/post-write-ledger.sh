#!/bin/bash
# PostToolUse hook for Write/Edit
# If a .md file is written to the memory directory, auto-ingest it to Ledger.
HOME_PROJECT=$(echo "$HOME" | sed 's|/|-|g')
MEMORY_DIR="$HOME/.claude/projects/$HOME_PROJECT/memory"
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Check if it's a ledger-view temp file — auto-push back to Ledger
VIEW_DIR="/tmp/ledger-view"
if [[ "$FILE_PATH" == "$VIEW_DIR/"* ]]; then
  ledger push "$FILE_PATH" 2>&1
  exit 0
fi

# Only intercept writes to memory directory
if [[ "$FILE_PATH" != "$MEMORY_DIR/"* ]]; then
  exit 0
fi

FILENAME=$(basename "$FILE_PATH")

# Skip generated files
if [[ "$FILENAME" == "MEMORY.md" ]]; then
  exit 0
fi

# Only .md files
if [[ "$FILENAME" != *.md ]]; then
  exit 0
fi

# Auto-ingest: send to Ledger, delete local
ledger ingest "$FILE_PATH" --auto 2>&1

exit 0
