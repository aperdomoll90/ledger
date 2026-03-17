import { writeFileSync, readFileSync, copyFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { loadConfig, loadConfigFile, getLedgerDir, type HookConfig } from '../lib/config.js';
import { fetchCachedNotes } from '../lib/notes.js';
import { generateClaudeMd } from '../lib/generators.js';
import { ask } from '../lib/prompt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function verifyInit(): void {
  const envPath = resolve(getLedgerDir(), '.env');
  if (!existsSync(envPath)) {
    console.error('Ledger not initialized. Run `ledger init` first.');
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
  const envPath = resolve(getLedgerDir(), '.env');

  console.error('Registering MCP server...');
  try {
    // Remove existing registration first (idempotent)
    try {
      execFileSync('claude', ['mcp', 'remove', 'ledger', '-s', 'user'], { stdio: 'pipe' });
    } catch {
      // Not registered yet — fine
    }
    execFileSync('claude', [
      'mcp', 'add', '-s', 'user',
      '-e', `DOTENV_CONFIG_PATH=${envPath}`,
      '--', 'ledger', 'node', mcpServerPath,
    ], { stdio: 'pipe' });
    console.error('  MCP server registered.\n');
  } catch {
    console.error('  Failed to register MCP. Is Claude Code installed?');
    console.error('  Install: npm install -g @anthropic-ai/claude-code');
    process.exit(1);
  }

  // 2. Install hooks
  const claudeHooksDir = resolve(homedir(), '.claude/hooks');
  mkdirSync(claudeHooksDir, { recursive: true });

  const hooksSourceDir = resolve(__dirname, '../hooks');
  const hookFiles: Array<{ src: string; enabled: boolean }> = [
    { src: 'block-env.sh', enabled: hooks.envBlocking !== false },
    { src: 'post-write-ledger.sh', enabled: hooks.writeInterception !== false },
    { src: 'session-end-check.sh', enabled: hooks.sessionEndCheck !== false },
  ];

  console.error('Installing hooks...');
  for (const hook of hookFiles) {
    if (!hook.enabled) {
      console.error(`  skip ${hook.src} (disabled in config)`);
      continue;
    }
    const dest = resolve(claudeHooksDir, hook.src);
    copyFileSync(resolve(hooksSourceDir, hook.src), dest);
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
  try {
    execFileSync('ledger', ['pull', '--force'], { stdio: 'inherit' });
  } catch {
    console.error('  Pull failed. You can run `ledger pull --force` manually.');
  }

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

  // Generate SOUL.md (communication/behavior rules)
  const soulContent = feedbackNotes.map(n => n.content).join('\n\n---\n\n');
  writeFileSync(resolve(targetPath, 'SOUL.md'), soulContent + '\n');
  console.error('  wrote SOUL.md');

  // Generate USER.md (user profile)
  const userContent = userNotes.map(n => n.content).join('\n\n---\n\n');
  writeFileSync(resolve(targetPath, 'USER.md'), userContent + '\n');
  console.error('  wrote USER.md');

  console.error(`\nOpenClaw persona written. Sync via \`ledger\` CLI.`);
}

export async function setupChatgpt(): Promise<void> {
  verifyInit();
  const config = loadConfig();

  const notes = await fetchCachedNotes(config.supabase);
  const feedbackNotes = notes.filter(n => (n.metadata.type as string) === 'feedback');

  const prompt = generateClaudeMd(feedbackNotes);

  console.error('WARNING: This is a snapshot, not a live connection.');
  console.error('Run `ledger setup chatgpt` again to regenerate after changes.\n');
  console.error('Copy the text below into ChatGPT > Settings > Custom Instructions:\n');
  console.error('---\n');
  console.log(prompt);
  console.error('---');
}

function buildHookSettings(hooks: Partial<HookConfig>): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {
    SessionStart: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'ledger pull --quiet' }],
      },
    ],
  };

  const preToolUse: unknown[] = [];
  const postToolUse: unknown[] = [];
  const stop: unknown[] = [];

  if (hooks.envBlocking !== false || hooks.mcpJsonBlocking !== false) {
    preToolUse.push(
      { matcher: 'Read', hooks: [{ type: 'command', command: '~/.claude/hooks/block-env.sh', timeout: 5 }] },
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '~/.claude/hooks/block-env.sh', timeout: 5 }] },
    );
  }

  if (hooks.writeInterception !== false) {
    postToolUse.push(
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '~/.claude/hooks/post-write-ledger.sh', timeout: 10 }] },
    );
  }

  if (hooks.sessionEndCheck !== false) {
    stop.push(
      { matcher: '', hooks: [{ type: 'command', command: '~/.claude/hooks/session-end-check.sh', timeout: 15 }] },
    );
  }

  if (preToolUse.length > 0) result.PreToolUse = preToolUse;
  if (postToolUse.length > 0) result.PostToolUse = postToolUse;
  if (stop.length > 0) result.Stop = stop;

  return result;
}
