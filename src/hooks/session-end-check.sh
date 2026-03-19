#!/bin/bash
# Session end: run hash-based sync check + temp file alert

OUTPUT=$(ledger sync --dry-run 2>&1)

# Only show output if there are changes to sync
if ! echo "$OUTPUT" | grep -q "nothing to do"; then
  echo "$OUTPUT"
fi

# Check for leftover temp view files
VIEW_DIR="/tmp/ledger-view"
if [[ -d "$VIEW_DIR" ]]; then
  COUNT=$(find "$VIEW_DIR" -name "*.md" 2>/dev/null | wc -l)
  if [[ "$COUNT" -gt 0 ]]; then
    echo "TEMP_VIEW_FILES:$COUNT files in /tmp/ledger-view/"
    ls "$VIEW_DIR"/*.md 2>/dev/null | while read f; do
      echo "  $(basename "$f")"
    done
  fi
fi

exit 0
