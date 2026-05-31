#!/bin/bash
# Development install — links the local repo as a global command.
# For production use: npm install -g ledger-ai
set -e

cd "$(dirname "$0")"

echo "Building..."
npm run build

echo "Linking globally..."
npm link

echo ""
echo "Done. 'ledger' is now available globally."
echo ""
echo "Next steps:"
echo "  ledger init                Set up credentials, run migrations, connect Claude Code"
echo "  ledger check               Verify connectivity"
echo "  ledger --help              List all commands"
echo ""
echo "To install Charlie's persona + memory on this machine:"
echo "  ./soul/install.sh          Symlink CLAUDE.md, memory, settings, hooks"
