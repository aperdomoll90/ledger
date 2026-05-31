#!/bin/bash
# Block git commits that contain AI co-author attribution
# PreToolUse hook on Bash — intercepts before execution
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Only check git commit commands
if ! echo "$COMMAND" | grep -qE 'git\s+commit'; then
  exit 0
fi

# Check for Co-Authored-By with AI/Claude/bot patterns
if echo "$COMMAND" | grep -qiE 'Co-Authored-By:.*\b(Claude|Anthropic|AI|GPT|OpenAI|Copilot|bot)\b'; then
  echo "BLOCKED: Do not include AI Co-Authored-By lines in commits. Remove the Co-Authored-By line and retry." >&2
  exit 2
fi

exit 0
