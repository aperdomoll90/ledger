#!/bin/bash
set -e

echo "Running typecheck..."
npm run typecheck

echo "Running tests..."
npm test

echo ""
read -p "Commit message: " msg

if [ -z "$msg" ]; then
  echo "No message provided. Aborting."
  exit 1
fi

git add .
git commit -m "$msg"
git push
