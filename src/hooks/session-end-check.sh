#!/bin/bash
# Session end: run hash-based sync check + temp file alert

OUTPUT=$(ledger check 2>/dev/null)

# Only show output if there are issues (not "All synced.")
if ! echo "$OUTPUT" | grep -q "All synced"; then
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
