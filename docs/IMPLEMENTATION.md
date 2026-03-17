# Ledger — Implementation Guide

How to set up Ledger from scratch or on a new machine.

## Prerequisites

- Node.js (v18+)
- Supabase account (free tier)
- OpenAI API key (for embeddings)

## 1. Supabase Project Setup

1. Go to supabase.com, create a new project
2. Set database password, pick closest region
3. Enable **Data API** and **Automatic RLS**
4. Wait for provisioning (~2 min)

## 2. Enable pgvector

1. Dashboard → Database → Extensions
2. Search "vector", enable the `vector` extension

## 3. Database Schema

Run in Supabase SQL Editor:

- Create `notes` table: `id` (serial), `content` (text), `metadata` (jsonb), `embedding` (vector 1536), `created_at`, `updated_at`
- Create vector similarity index for fast cosine search
- Create `match_notes` RPC function for semantic search
- Configure RLS policies for service_role access

_(See `docs/ARCHITECTURE.md` for full schema details)_

## 4. Project Setup

```bash
mkdir ledger && cd ledger
npm init -y
# Set "type": "module" in package.json for ES modules
```

## 5. Dependencies

```bash
npm install @supabase/supabase-js openai @modelcontextprotocol/sdk dotenv zod
npm install -D typescript @types/node tsx
```

| Package | Purpose |
|---------|---------|
| `@supabase/supabase-js` | Supabase client for database access |
| `openai` | OpenAI SDK for generating embeddings |
| `@modelcontextprotocol/sdk` | MCP server framework |
| `dotenv` | Loads `.env` variables |
| `zod` | Schema validation for MCP tool parameters |

## 6. Environment Variables

Create `.env` (gitignored):

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_ACCESS_TOKEN=your-cli-access-token
OPENAI_API_KEY=your-openai-key
```

- `SUPABASE_ANON_KEY` — public, safe in client code (used for capture endpoint auth)
- `SUPABASE_SERVICE_ROLE_KEY` — full access, server-side only, never expose
- `SUPABASE_ACCESS_TOKEN` — for Supabase CLI, no expiration

## 7. MCP Server

Main file: `src/mcp-server.ts`

Exposes 4 tools: `add_note`, `search_notes`, `list_notes`, `delete_note`. Uses `dotenv` to load credentials from `.env`.

## 8. Connect to Claude Code

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "ledger": {
      "command": "npx",
      "args": ["tsx", "/home/adrian/repos/ledger/src/mcp-server.ts"],
      "cwd": "/home/adrian/repos/ledger"
    }
  }
}
```

**For other machines (no repo clone needed):**
```json
{
  "mcpServers": {
    "ledger": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-server.ts"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your-secret-key",
        "OPENAI_API_KEY": "your-openai-key"
      }
    }
  }
}
```

## 9. Deploy Capture Edge Function

```bash
npx supabase functions deploy capture --no-verify-jwt
npx supabase secrets set OPENAI_API_KEY=your-key
```

Source: `supabase/functions/capture/index.ts`. CORS enabled. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-available in Edge Functions.

## Key Files

| File | Purpose |
|------|---------|
| `src/mcp-server.ts` | MCP server with all tools |
| `supabase/functions/capture/index.ts` | HTTP capture endpoint |
| `.env` | Credentials (gitignored) |
| `docs/ARCHITECTURE.md` | System design and decisions |
| `docs/setup-log.md` | Session-by-session work log |
