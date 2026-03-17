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
echo "Usage:"
echo "  ledger init                Set up credentials and database"
echo "  ledger setup claude        Connect Claude Code"
echo "  ledger onboard             Create your persona"
echo "  ledger --help              All commands"
