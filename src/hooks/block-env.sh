#!/bin/bash
# Block reading or writing sensitive files
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

FILENAME=$(basename "$FILE_PATH")

# Block .env files (all variants)
if [[ "$FILENAME" =~ ^\.env($|\.) ]]; then
  echo "BLOCKED: .env files must never be read or written. Check existence with 'test -f .env' or 'wc -l .env'." >&2
  exit 2
fi

# Block credential/secret files
case "$FILENAME" in
  credentials.json|service-account.json|token.json|secrets.json|auth.json)
    echo "BLOCKED: $FILENAME contains credentials. Do not read or write directly." >&2
    exit 2
    ;;
  .npmrc|.netrc)
    echo "BLOCKED: $FILENAME may contain auth tokens. Do not read or write directly." >&2
    exit 2
    ;;
  mcp.json)
    echo "BLOCKED: Do not edit mcp.json directly. Use 'claude mcp add -s user <name> -- <command>' instead." >&2
    exit 2
    ;;
esac

# Block by extension (keys, certs)
case "$FILENAME" in
  *.pem|*.key|*.p12|*.pfx)
    echo "BLOCKED: $FILENAME is a key/certificate file. Do not read or write." >&2
    exit 2
    ;;
esac

# Block SSH keys
if [[ "$FILE_PATH" =~ /.ssh/ ]] && [[ "$FILENAME" == id_* || "$FILENAME" == *.pub ]]; then
  echo "BLOCKED: SSH keys must never be read. Check existence with 'test -f'." >&2
  exit 2
fi

# Block AWS credentials
if [[ "$FILE_PATH" =~ /.aws/credentials ]]; then
  echo "BLOCKED: AWS credentials must never be read directly." >&2
  exit 2
fi

exit 0
