# ledger init + setup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ledger-sync init` (machine setup) and `ledger-sync setup <platform>` (agent config) commands.

**Architecture:** `init` handles credentials + schema migrations. `setup` handles per-platform agent configuration (Claude Code, OpenClaw, ChatGPT). Both use existing `lib/` modules and `prompt.ts` for interactive input.

**Tech Stack:** TypeScript, Commander, Supabase JS, dotenv, readline (existing)

**Spec:** `docs/ledger-init-design.md`

---

## File Structure

```
src/
├── commands/
│   ├── init.ts           ← NEW: credential prompts, schema detection, migrations
│   └── setup.ts          ← NEW: platform-specific agent configuration
├── lib/
│   ├── config.ts         ← MODIFY: add ~/.ledger/.env loading, update ConfigFile interface
│   ├── prompt.ts         ← MODIFY: add masked input function
│   └── migrate.ts        ← NEW: migration runner
├── migrations/
│   ├── 000-tracking.sql  ← NEW
│   ├── 001-schema.sql    ← NEW
│   ├── 002-functions.sql ← NEW
│   └── 003-rls.sql       ← NEW
├── hooks/
│   ├── block-env.sh      ← NEW (bundled copy, installed by setup)
│   ├── post-write-ledger.sh ← NEW (bundled copy)
│   └── session-end-check.sh ← NEW (bundled copy)
├── cli.ts                ← MODIFY: add init and setup commands
└── mcp-server.ts         ← NO CHANGE
```

---

## Chunk 1: Foundations (migrations, prompt, config)

### Task 1: SQL Migration Files

**Files:**
- Create: `src/migrations/000-tracking.sql`
- Create: `src/migrations/001-schema.sql`
- Create: `src/migrations/002-functions.sql`
- Create: `src/migrations/003-rls.sql`

- [ ] **Step 1: Create 000-tracking.sql**

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz DEFAULT now()
);
```

- [ ] **Step 2: Create 001-schema.sql**

```sql
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS notes (
  id bigserial PRIMARY KEY,
  content text NOT NULL,
  metadata jsonb DEFAULT '{}',
  embedding vector(1536),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notes_updated_at ON notes;
CREATE TRIGGER notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS notes_embedding_idx
  ON notes USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 3: Create 002-functions.sql**

```sql
CREATE OR REPLACE FUNCTION match_notes(
  q_emb text,
  threshold double precision DEFAULT 0.5,
  max_results integer DEFAULT 10
)
RETURNS TABLE(id bigint, content text, metadata jsonb, similarity double precision)
LANGUAGE sql STABLE AS $$
  SELECT notes.id, notes.content, notes.metadata,
    1 - (notes.embedding <=> q_emb::vector) AS similarity
  FROM notes
  WHERE 1 - (notes.embedding <=> q_emb::vector) > threshold
  ORDER BY notes.embedding <=> q_emb::vector
  LIMIT least(max_results, 200)
$$;
```

- [ ] **Step 4: Create 003-rls.sql**

```sql
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON notes;
DROP POLICY IF EXISTS "anon_read_only" ON notes;
-- Service role bypasses RLS (Supabase built-in). No policies needed.
-- Anon key is locked out: RLS enabled + no matching policy = deny all.
```

- [ ] **Step 5: Commit**

```bash
git add src/migrations/
git commit -m "feat: add SQL migration files for ledger init"
```

---

### Task 2: Migration Runner

**Files:**
- Create: `src/lib/migrate.ts`
- Create: `tests/migrate.test.ts`

- [ ] **Step 1: Write test for migration file reading**

```typescript
// tests/migrate.test.ts
import { describe, it, expect } from 'vitest';
import { getMigrationFiles } from '../src/lib/migrate.js';

describe('getMigrationFiles', () => {
  it('returns migration files sorted by version', () => {
    const files = getMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files[0]).toContain('000-');
    expect(files[1]).toContain('001-');
  });

  it('all files end with .sql', () => {
    const files = getMigrationFiles();
    for (const f of files) {
      expect(f).toMatch(/\.sql$/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/migrate.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement migrate.ts**

```typescript
// src/lib/migrate.ts
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SupabaseClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../migrations');

export function getMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

export function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf-8');
}

export async function getAppliedMigrations(supabase: SupabaseClient): Promise<Set<string>> {
  // Table might not exist yet on first run
  const { data, error } = await supabase
    .from('schema_migrations')
    .select('version');

  if (error) {
    // Table doesn't exist — no migrations applied
    return new Set();
  }

  return new Set((data || []).map(r => r.version));
}

export async function runMigrations(supabase: SupabaseClient): Promise<string[]> {
  const files = getMigrationFiles();
  const applied = await getAppliedMigrations(supabase);
  const ran: string[] = [];

  for (const file of files) {
    const version = file.replace('.sql', '');

    if (applied.has(version)) {
      console.error(`  skip ${file} (already applied)`);
      continue;
    }

    const sql = readMigration(file);

    // Run migration via Supabase's rpc or raw query
    // Supabase JS doesn't have raw SQL — use rpc with a helper or the REST API
    // For now, use the postgres connection string approach
    const { error } = await supabase.rpc('exec_sql', { query: sql });

    if (error) {
      // Try direct approach — supabase might not have exec_sql
      // Fall back to splitting statements and running via .from()
      throw new Error(`Migration ${file} failed: ${error.message}\n\nRun manually in Supabase SQL Editor:\n${sql}`);
    }

    // Record migration
    await supabase
      .from('schema_migrations')
      .insert({ version });

    console.error(`  applied ${file}`);
    ran.push(file);
  }

  return ran;
}
```

**Note:** Supabase JS client doesn't support raw SQL. The migration runner needs one of:
- A custom `exec_sql` Postgres function (created by 000-tracking.sql)
- The Supabase Management API
- Prompting the user to run SQL manually in the dashboard

The simplest approach: `init` detects if it can run SQL automatically. If not, it prints the SQL and asks the user to run it in the Supabase SQL Editor. We'll handle this in the init command.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/migrate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/migrate.ts tests/migrate.test.ts
git commit -m "feat: add migration runner"
```

---

### Task 3: Prompt Enhancements (masked input)

**Files:**
- Modify: `src/lib/prompt.ts`
- Create: `tests/prompt.test.ts`

- [ ] **Step 1: Write test for askMasked**

```typescript
// tests/prompt.test.ts
import { describe, it, expect } from 'vitest';

// We can only test the export exists and the types
// Actual readline interaction can't be unit tested
describe('prompt module exports', () => {
  it('exports ask, confirm, choose, askMasked', async () => {
    const mod = await import('../src/lib/prompt.js');
    expect(typeof mod.ask).toBe('function');
    expect(typeof mod.confirm).toBe('function');
    expect(typeof mod.choose).toBe('function');
    expect(typeof mod.askMasked).toBe('function');
  });
});
```

- [ ] **Step 2: Add askMasked to prompt.ts**

Add after the existing `ask` function:

```typescript
export async function askMasked(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  // Suppress echo for password input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  return new Promise((resolve) => {
    process.stderr.write(question);
    let input = '';

    process.stdin.on('data', (char) => {
      const c = char.toString();
      if (c === '\n' || c === '\r') {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stderr.write('\n');
        rl.close();
        resolve(input);
      } else if (c === '\u007f' || c === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stderr.write('\b \b');
        }
      } else {
        input += c;
        process.stderr.write('*');
      }
    });
  });
}
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/lib/prompt.ts tests/prompt.test.ts
git commit -m "feat: add masked input for password prompts"
```

---

### Task 4: Update Config for ~/.ledger/.env

**Files:**
- Modify: `src/lib/config.ts`

- [ ] **Step 1: Update loadConfig to check ~/.ledger/.env**

Replace the dotenv loading section:

```typescript
// --- Defaults ---

const LEDGER_DIR = resolve(homedir(), '.ledger');
const LEDGER_DOTENV = resolve(LEDGER_DIR, '.env');
const REPO_DOTENV = resolve(homedir(), 'repos/ledger/.env');
const HOME_PROJECT_DIR = homedir().replace(/\//g, '-');
const DEFAULT_MEMORY_DIR = resolve(homedir(), `.claude/projects/${HOME_PROJECT_DIR}/memory`);
const DEFAULT_CLAUDE_MD_PATH = resolve(homedir(), 'CLAUDE.md');
const CONFIG_FILE = resolve(LEDGER_DIR, 'config.json');

// --- Config Interfaces ---

export interface HookConfig {
  envBlocking: boolean;
  mcpJsonBlocking: boolean;
  writeInterception: boolean;
  sessionEndCheck: boolean;
}

export interface LedgerConfig {
  memoryDir: string;
  claudeMdPath: string;
  supabase: SupabaseClient;
  openai: OpenAI;
}

interface ConfigFile {
  memoryDir?: string;
  claudeMdPath?: string;
  hooks?: Partial<HookConfig>;
}
```

Update `loadConfig`:

```typescript
export function loadConfig(): LedgerConfig {
  // Priority: env vars > DOTENV_CONFIG_PATH > ~/.ledger/.env > repo .env
  const dotenvPath = process.env.DOTENV_CONFIG_PATH
    || (existsSync(LEDGER_DOTENV) ? LEDGER_DOTENV : REPO_DOTENV);
  dotenv.config({ path: dotenvPath, quiet: true });

  // ... rest stays the same
}
```

Add helper for init to use before config exists:

```typescript
export function getLedgerDir(): string {
  return LEDGER_DIR;
}

export function loadConfigFile(): ConfigFile {
  if (existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as ConfigFile;
    } catch {
      return {};
    }
  }
  return {};
}

export function getDefaultConfig(): ConfigFile {
  return {
    memoryDir: DEFAULT_MEMORY_DIR,
    claudeMdPath: DEFAULT_CLAUDE_MD_PATH,
    hooks: {
      envBlocking: true,
      mcpJsonBlocking: true,
      writeInterception: true,
      sessionEndCheck: true,
    },
  };
}
```

- [ ] **Step 2: Run existing tests to verify nothing broke**

Run: `npm test`
Expected: All 26+ tests pass

- [ ] **Step 3: Commit**

```bash
git add src/lib/config.ts
git commit -m "feat: config loads from ~/.ledger/.env, add hooks config interface"
```

---

## Chunk 2: Init Command

### Task 5: Bundle Hook Scripts

**Files:**
- Create: `src/hooks/block-env.sh`
- Create: `src/hooks/post-write-ledger.sh`
- Create: `src/hooks/session-end-check.sh`

- [ ] **Step 1: Copy current hook scripts into repo**

Copy from `~/.claude/hooks/` into `src/hooks/`. These are the canonical versions that `setup` will install.

Update `post-write-ledger.sh` to use dynamic home path (already done) and verify all three scripts have no hardcoded user paths.

- [ ] **Step 2: Commit**

```bash
git add src/hooks/
git commit -m "feat: bundle hook scripts for setup installation"
```

---

### Task 6: Init Command

**Files:**
- Create: `src/commands/init.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Create init.ts**

```typescript
// src/commands/init.ts
import { writeFileSync, mkdirSync, existsSync, chmodSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { ask, askMasked, confirm } from '../lib/prompt.js';
import { getLedgerDir, loadConfigFile, getDefaultConfig } from '../lib/config.js';
import { getMigrationFiles, readMigration } from '../lib/migrate.js';

export async function init(): Promise<void> {
  const ledgerDir = getLedgerDir();
  const envPath = resolve(ledgerDir, '.env');
  const configPath = resolve(ledgerDir, 'config.json');

  console.error('Welcome to Ledger.\n');

  // Step 1: Check existing config
  mkdirSync(ledgerDir, { recursive: true });

  let supabaseUrl = '';
  let supabaseKey = '';
  let openaiKey = '';

  if (existsSync(envPath)) {
    const overwrite = await confirm('Existing credentials found. Overwrite?');
    if (!overwrite) {
      console.error('Keeping existing credentials.\n');
      // Load existing creds for verification
      const envContent = readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const [key, ...val] = line.split('=');
        const value = val.join('=');
        if (key === 'SUPABASE_URL') supabaseUrl = value;
        if (key === 'SUPABASE_SERVICE_ROLE_KEY') supabaseKey = value;
        if (key === 'OPENAI_API_KEY') openaiKey = value;
      }
    }
  }

  // Step 2: Get credentials
  if (!supabaseUrl) {
    const hasProject = await confirm('Do you have a Supabase project?');

    if (!hasProject) {
      console.error(`
To create a Supabase project:
  1. Go to https://supabase.com and create a free account
  2. Create a new project (any name, any region)
  3. Enable the pgvector extension: Database → Extensions → search "vector" → Enable
  4. Go to Settings → API and copy:
     - Project URL (under "Project URL")
     - service_role key (under "Project API keys" → service_role)
  5. Get an OpenAI API key from https://platform.openai.com/api-keys
`);
      await ask('Press Enter when ready...');
    }

    supabaseUrl = await ask('Supabase URL: ');
    supabaseKey = await askMasked('Service Role Key: ');
    openaiKey = await askMasked('OpenAI API Key: ');

    // Write credentials
    const envContent = `SUPABASE_URL=${supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${supabaseKey}\nOPENAI_API_KEY=${openaiKey}\n`;
    writeFileSync(envPath, envContent, { mode: 0o600 });
    console.error('Credentials saved to ~/.ledger/.env\n');
  }

  // Step 3: Write/merge config.json
  const existing = loadConfigFile();
  const defaults = getDefaultConfig();
  const merged = {
    ...defaults,
    ...existing,
    hooks: { ...defaults.hooks, ...existing.hooks },
  };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  console.error('Config saved to ~/.ledger/config.json\n');

  // Step 4: Verify Supabase connection
  console.error('Connecting to Supabase...');
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { error: connError } = await supabase.from('schema_migrations').select('version').limit(1);

  // If schema_migrations doesn't exist, that's fine — means new database
  const isNew = connError?.code === '42P01'; // relation does not exist
  if (connError && !isNew) {
    // Some other error — credentials might be wrong
    console.error(`Connection error: ${connError.message}`);
    console.error('Check your Supabase URL and service role key.');
    process.exit(1);
  }

  // Step 5: Validate OpenAI key
  console.error('Validating OpenAI key...');
  try {
    const openai = new OpenAI({ apiKey: openaiKey });
    await openai.embeddings.create({ model: 'text-embedding-3-small', input: 'test' });
    console.error('OpenAI key valid.\n');
  } catch (e) {
    console.error(`OpenAI key invalid: ${(e as Error).message}`);
    console.error('Check your OpenAI API key.');
    process.exit(1);
  }

  // Step 6: Run migrations or confirm existing
  if (isNew) {
    console.error('New database detected. Running migrations...\n');
    const files = getMigrationFiles();

    for (const file of files) {
      const sql = readMigration(file);
      console.error(`  Applying ${file}...`);

      // Supabase JS doesn't support raw SQL — print for manual execution
      console.error(`\n--- Run this in Supabase SQL Editor (Dashboard → SQL Editor): ---\n`);
      console.error(sql);
      console.error(`\n--- End of ${file} ---\n`);
    }

    console.error('Run all SQL above in the Supabase SQL Editor, then press Enter.');
    await ask('Press Enter when done...');

    // Verify tables exist now
    const { error: verifyError } = await supabase.from('notes').select('id').limit(1);
    if (verifyError) {
      console.error(`Tables not found. Make sure you ran all migrations.`);
      process.exit(1);
    }

    console.error('Schema verified.\n');
  } else {
    const { count } = await supabase.from('notes').select('*', { count: 'exact', head: true });
    console.error(`Found existing Ledger with ${count ?? 0} notes.\n`);
  }

  console.error('Init complete. Run `ledger-sync setup <platform>` to connect an agent.');
  console.error('Platforms: claude-code, openclaw, chatgpt');
}
```

- [ ] **Step 2: Add init command to cli.ts**

Add after the ingest command block:

```typescript
import { init } from './commands/init.js';

program
  .command('init')
  .description('Set up Ledger on this machine (credentials, database schema)')
  .action(async () => {
    await init();
  });
```

- [ ] **Step 3: Build and test manually**

Run: `npm run build`
Run: `ledger-sync init` (cancel after welcome message to verify it starts)

- [ ] **Step 4: Commit**

```bash
git add src/commands/init.ts src/cli.ts
git commit -m "feat: add ledger-sync init command"
```

---

## Chunk 3: Setup Command

### Task 7: Setup Command

**Files:**
- Create: `src/commands/setup.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Create setup.ts**

```typescript
// src/commands/setup.ts
import { writeFileSync, readFileSync, copyFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { loadConfig, loadConfigFile, getLedgerDir } from '../lib/config.js';
import { fetchCachedNotes } from '../lib/notes.js';
import { generateClaudeMd } from '../lib/generators.js';
import { ask } from '../lib/prompt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function verifyInit(): void {
  const envPath = resolve(getLedgerDir(), '.env');
  if (!existsSync(envPath)) {
    console.error('Ledger not initialized. Run `ledger-sync init` first.');
    process.exit(1);
  }
}

export async function setupClaudeCode(): Promise<void> {
  verifyInit();
  const config = loadConfig();
  const configFile = loadConfigFile();
  const hooks = configFile.hooks || {};

  console.error('Setting up Claude Code...\n');

  // 1. Register MCP server
  const mcpServerPath = resolve(__dirname, '../mcp-server.js');
  const ledgerDir = getLedgerDir();
  const envPath = resolve(ledgerDir, '.env');

  console.error('Registering MCP server...');
  try {
    execFileSync('claude', [
      'mcp', 'add', '-s', 'user',
      '-e', `DOTENV_CONFIG_PATH=${envPath}`,
      '--', 'ledger', 'node', mcpServerPath,
    ], { stdio: 'pipe' });
    console.error('  MCP server registered.\n');
  } catch (e) {
    console.error(`  Failed to register MCP. Is Claude Code installed?`);
    console.error(`  Install: npm install -g @anthropic-ai/claude-code`);
    process.exit(1);
  }

  // 2. Install hooks
  const claudeHooksDir = resolve(homedir(), '.claude/hooks');
  mkdirSync(claudeHooksDir, { recursive: true });

  const hooksDir = resolve(__dirname, '../hooks');
  const hookFiles = [
    { src: 'block-env.sh', enabled: hooks.envBlocking !== false && hooks.mcpJsonBlocking !== false },
    { src: 'post-write-ledger.sh', enabled: hooks.writeInterception !== false },
    { src: 'session-end-check.sh', enabled: hooks.sessionEndCheck !== false },
  ];

  for (const hook of hookFiles) {
    if (!hook.enabled) {
      console.error(`  skip ${hook.src} (disabled in config)`);
      continue;
    }
    const dest = resolve(claudeHooksDir, hook.src);
    copyFileSync(resolve(hooksDir, hook.src), dest);
    chmodSync(dest, 0o755);
    console.error(`  installed ${hook.src}`);
  }

  // 3. Update settings.json
  const settingsPath = resolve(homedir(), '.claude/settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  settings.hooks = buildHookSettings(hooks);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.error('  Updated ~/.claude/settings.json\n');

  // 4. Pull
  console.error('Pulling notes from Ledger...');
  execFileSync('ledger-sync', ['pull', '--force'], { stdio: 'inherit' });

  console.error('\nClaude Code is ready. Start a new session.');
}

export async function setupOpenclaw(path?: string): Promise<void> {
  verifyInit();
  const config = loadConfig();

  let targetPath = path;
  if (!targetPath) {
    targetPath = await ask('Where is your OpenClaw workspace? ');
  }
  targetPath = resolve(targetPath);

  if (!existsSync(targetPath)) {
    console.error(`Directory not found: ${targetPath}`);
    process.exit(1);
  }

  console.error(`Setting up OpenClaw at ${targetPath}...\n`);

  const notes = await fetchCachedNotes(config.supabase);
  const userNotes = notes.filter(n => (n.metadata.type as string) === 'user-preference');
  const feedbackNotes = notes.filter(n => (n.metadata.type as string) === 'feedback');

  // Generate SOUL.md (communication rules)
  const soulContent = feedbackNotes.map(n => n.content).join('\n\n---\n\n');
  writeFileSync(resolve(targetPath, 'SOUL.md'), soulContent + '\n');
  console.error('  wrote SOUL.md');

  // Generate USER.md (profile)
  const userContent = userNotes.map(n => n.content).join('\n\n---\n\n');
  writeFileSync(resolve(targetPath, 'USER.md'), userContent + '\n');
  console.error('  wrote USER.md');

  console.error(`\nOpenClaw persona written. Sync via \`ledger-sync\` CLI.`);
}

export async function setupChatgpt(): Promise<void> {
  verifyInit();
  const config = loadConfig();

  const notes = await fetchCachedNotes(config.supabase);
  const feedbackNotes = notes.filter(n => (n.metadata.type as string) === 'feedback');
  const userNotes = notes.filter(n => (n.metadata.type as string) === 'user-preference');

  const prompt = generateClaudeMd([...feedbackNotes, ...userNotes]);

  console.error('WARNING: This is a snapshot, not a live connection.');
  console.error('Run `ledger-sync setup chatgpt` again to regenerate after changes.\n');
  console.error('Copy the text below into ChatGPT → Settings → Custom Instructions:\n');
  console.error('---\n');
  console.log(prompt);
  console.error('---');
}

function buildHookSettings(hooks: Record<string, unknown>): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {
    SessionStart: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'ledger-sync pull --quiet' }],
      },
    ],
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  };

  if (hooks.envBlocking !== false || hooks.mcpJsonBlocking !== false) {
    (result.PreToolUse as unknown[]).push(
      { matcher: 'Read', hooks: [{ type: 'command', command: '~/.claude/hooks/block-env.sh', timeout: 5 }] },
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '~/.claude/hooks/block-env.sh', timeout: 5 }] },
    );
  }

  if (hooks.writeInterception !== false) {
    (result.PostToolUse as unknown[]).push(
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '~/.claude/hooks/post-write-ledger.sh', timeout: 10 }] },
    );
  }

  if (hooks.sessionEndCheck !== false) {
    (result.Stop as unknown[]).push(
      { matcher: '', hooks: [{ type: 'command', command: '~/.claude/hooks/session-end-check.sh', timeout: 15 }] },
    );
  }

  // Clean up empty arrays
  for (const [key, val] of Object.entries(result)) {
    if (Array.isArray(val) && val.length === 0) {
      delete result[key];
    }
  }

  return result;
}
```

- [ ] **Step 2: Add setup commands to cli.ts**

```typescript
import { setupClaudeCode, setupOpenclaw, setupChatgpt } from './commands/setup.js';

const setupCmd = program
  .command('setup')
  .description('Configure an agent platform to use Ledger');

setupCmd
  .command('claude-code')
  .description('Register MCP, install hooks, pull cache (live sync)')
  .action(async () => {
    await setupClaudeCode();
  });

setupCmd
  .command('openclaw [path]')
  .description('Generate persona files for OpenClaw (live sync via CLI)')
  .action(async (path?: string) => {
    await setupOpenclaw(path);
  });

setupCmd
  .command('chatgpt')
  .description('Generate system prompt for ChatGPT (static snapshot)')
  .action(async () => {
    await setupChatgpt();
  });
```

- [ ] **Step 3: Build and test**

Run: `npm run build`
Run: `ledger-sync setup --help` (verify subcommands show)
Run: `ledger-sync init --help` (verify help text)

- [ ] **Step 4: Commit**

```bash
git add src/commands/setup.ts src/cli.ts
git commit -m "feat: add ledger-sync setup command (claude-code, openclaw, chatgpt)"
```

---

## Chunk 4: Integration Test

### Task 8: End-to-End Verification

- [ ] **Step 1: Build**

Run: `npm run build`

- [ ] **Step 2: Run unit tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Test init help**

Run: `ledger-sync init --help`
Expected: Shows description

- [ ] **Step 4: Test setup help**

Run: `ledger-sync setup --help`
Expected: Shows claude-code, openclaw, chatgpt subcommands

- [ ] **Step 5: Test setup claude-code (on current machine)**

Run: `ledger-sync setup claude-code`
Expected: Registers MCP, installs hooks, pulls notes

- [ ] **Step 6: Verify hooks installed**

Run: `ls -la ~/.claude/hooks/`
Expected: block-env.sh, post-write-ledger.sh, session-end-check.sh (all executable)

- [ ] **Step 7: Verify settings.json updated**

Run: `cat ~/.claude/settings.json | jq '.hooks'`
Expected: SessionStart, PreToolUse, PostToolUse, Stop configured

- [ ] **Step 8: Verify pull worked**

Run: `ledger-sync check`
Expected: All clean

- [ ] **Step 9: Final commit**

```bash
git add -A
git commit -m "feat: ledger-sync init + setup complete"
```
