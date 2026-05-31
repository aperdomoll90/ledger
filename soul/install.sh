#!/usr/bin/env bash
#
# Soul install. Links Charlie's persona + memory + skill-adjacent config
# from this repo into the host machine's home directory.
#
# Idempotent. Re-runs are safe. Existing non-symlink files at target paths
# are backed up to <path>.pre-soul.<timestamp> before being replaced.
#
# Usage:
#   ./install.sh        Apply the links
#   ./install.sh --dry  Show what would happen, write nothing
#
set -euo pipefail

SOUL="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=0
if [[ "${1:-}" == "--dry" || "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

# pairs: <source path inside /soul>::<destination path on host>
LINKS=(
  "CLAUDE.md::$HOME/CLAUDE.md"
  "settings.json::$HOME/.claude/settings.json"
  "hookify.descriptive-variable-names.local.md::$HOME/.claude/hookify.descriptive-variable-names.local.md"
  "hooks::$HOME/.claude/hooks"
  "memory::$HOME/.claude/projects/-home-adrian/memory"
)

say() { printf '%s\n' "$*"; }
run() {
  if (( DRY_RUN )); then
    say "  DRY: $*"
  else
    eval "$@"
  fi
}

ensure_parent() {
  local dst="$1"
  local parent
  parent="$(dirname "$dst")"
  if [[ ! -d "$parent" ]]; then
    say "Creating parent directory: $parent"
    run "mkdir -p \"$parent\""
  fi
}

link_one() {
  local src="$SOUL/$1"
  local dst="$2"

  if [[ ! -e "$src" ]]; then
    say "SKIP missing source: $src"
    return
  fi

  ensure_parent "$dst"

  if [[ -L "$dst" ]]; then
    local current
    current="$(readlink "$dst")"
    if [[ "$current" == "$src" ]]; then
      say "OK already linked: $dst"
      return
    fi
    say "Replacing stale symlink: $dst (was -> $current)"
    run "rm \"$dst\""
  elif [[ -e "$dst" ]]; then
    local backup="$dst.pre-soul.$(date +%s)"
    say "Backing up existing $dst -> $backup"
    run "mv \"$dst\" \"$backup\""
  fi

  say "Linking $src -> $dst"
  run "ln -s \"$src\" \"$dst\""
}

say "Soul install"
say "Source: $SOUL"
(( DRY_RUN )) && say "Mode: dry-run (no changes)"
say

for entry in "${LINKS[@]}"; do
  src="${entry%%::*}"
  dst="${entry##*::}"
  link_one "$src" "$dst"
done

say
say "Done. What this script did NOT set up (machine-local, do these manually):"
say
say "  1. Claude Code auth"
say "     run: claude login"
say
say "  2. MCP server registrations (~/.claude/mcp.json)"
say "     run: claude mcp add -s user ledger -- npx -y @aperdomoll90/ledger-ai start"
say "     plus any other MCP servers you use"
say
say "  3. Machine-local permissions (~/.claude/settings.local.json)"
say "     accretes over time as Claude Code asks for tool approval."
say "     starts empty: echo '{}' > ~/.claude/settings.local.json"
say
say "  4. Ledger credentials (~/.ledger/.env)"
say "     run: ledger init"
say "     paste your existing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY"
say
say "  5. Ledger CLI install"
say "     run: npm install -g @aperdomoll90/ledger-ai"
say "     verify: ledger check"
say
say "  6. Other repos that complete the Charlie setup"
say "     - ~/repos/claude-skills (private GitHub)  symlinked into ~/.claude/skills/"
say "     - ~/repos/atelier       (private GitHub)  symlinked into ~/.claude/plugins/atelier"
say
