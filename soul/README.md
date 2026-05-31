# /soul

Charlie's behavioral continuity for Adrian's machines. Persona, memory, behavioral rules, Claude Code settings, hooks. Everything that makes Charlie behave like Charlie on a fresh machine.

This folder is **outside the published npm package**. The package.json `files` whitelist publishes only `dist/**`, so `/soul/` ships to GitHub but never to the npm registry.

## What is here

| Path | What it is | Symlinks to |
|---|---|---|
| `CLAUDE.md` | Charlie's persona, operational discipline, project rules | `~/CLAUDE.md` |
| `memory/` | Auto-loaded behavioral feedback (50+ files), project notes, MEMORY.md index | `~/.claude/projects/-home-adrian/memory/` |
| `settings.json` | Global Claude Code settings (hooks, env-derived behavior) | `~/.claude/settings.json` |
| `hooks/` | Custom hook shell scripts (block-env, git-context, post-write-ledger, etc.) | `~/.claude/hooks/` |
| `hookify.descriptive-variable-names.local.md` | A hookify rule definition | `~/.claude/hookify.descriptive-variable-names.local.md` |
| `install.sh` | Idempotent install script that creates the symlinks | (this file) |

## What is NOT here, and why

The install script tells you about each of these too. Listed here for searchable reference.

| Missing | Why excluded | How to set up |
|---|---|---|
| `~/.claude/.credentials.json` | Claude Code auth tokens | `claude login` |
| `~/.claude/mcp.json` | MCP server tokens, hook-protected from writes | `claude mcp add -s user ledger -- npx -y @aperdomoll90/ledger-ai start` (+ others) |
| `~/.claude/settings.local.json` | Contains real Supabase service-role keys in the permission allowlist. Cannot go to git. | Start empty (`echo '{}' > ...`); it accretes as Claude Code prompts for approval. |
| `~/.ledger/.env` | Supabase URL + service role + OpenAI key | `ledger init` and paste them from your existing machine |
| Sessions, caches, history, telemetry, debug, todos, plans, paste-cache | Machine-local state, no continuity value | Skip |
| `~/repos/claude-skills` | Lives in its own private repo | `git clone git@github.com:aperdomoll90/claude-skills.git ~/repos/claude-skills` then re-symlink each into `~/.claude/skills/` |
| `~/repos/atelier` | Lives in its own private repo | `git clone git@github.com:aperdomoll90/Atelier.git ~/repos/atelier` then `ln -s ~/repos/atelier ~/.claude/plugins/atelier` |

## New machine bringup

Order matters.

```bash
# 1. Base tools (per Ledger doc #125)
sudo apt install zsh git gh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install --lts

# 2. Claude Code + Ledger CLI
npm install -g @anthropic-ai/claude-code
npm install -g @aperdomoll90/ledger-ai
claude login

# 3. Clone repos
mkdir -p ~/repos
cd ~/repos
git clone https://github.com/aperdomoll90/ledger.git
git clone git@github.com:aperdomoll90/claude-skills.git
git clone git@github.com:aperdomoll90/Atelier.git atelier

# 4. Apply soul (creates the symlinks)
cd ~/repos/ledger/soul
./install.sh

# 5. Skills + Atelier symlinks (not handled by soul/install.sh because they live in separate repos)
mkdir -p ~/.claude/skills ~/.claude/plugins
for skill in ~/repos/claude-skills/*/; do
  name=$(basename "$skill")
  [[ "$name" =~ ^docs|node_modules$ ]] && continue
  ln -s "$skill" ~/.claude/skills/"$name"
done
ln -s ~/repos/atelier ~/.claude/plugins/atelier

# 6. Credentials
ledger init   # paste Supabase URL, service-role key, OpenAI key
ledger check  # verify DB connectivity

# 7. MCP registration (one per server)
claude mcp add -s user ledger -- npx -y @aperdomoll90/ledger-ai start
# add other MCP servers as needed

# 8. Empty machine-local settings
echo '{}' > ~/.claude/settings.local.json

# 9. Restart Claude Code, confirm Ledger MCP tools appear
```

## Sync workflow (after bringup)

Both machines pull from the same GitHub repo. Edits propagate via git.

```bash
# After editing a memory file or CLAUDE.md on either machine:
cd ~/repos/ledger
git add soul/
git commit -m "soul: <what changed>"
git push

# On the other machine, before starting a session:
cd ~/repos/ledger
git pull
```

Symlinks resolve through git pulls. No re-install needed unless the file structure inside `/soul` changes.

## Safety

This folder is part of a **public** repo (`aperdomoll90/ledger`). Before pushing edits, scan for new secrets:

```bash
grep -rE 'sk-|sk_|sb_secret|service_role|password|API_KEY=' soul/
# should print nothing
```

If you ever paste credentials into a memory file by accident, `git rm` is not enough. Rotate the credential and rewrite history (or accept the leak). The `install.sh` script never touches secrets and the inclusion list above is deliberately conservative for this reason.
