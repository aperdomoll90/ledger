import { writeFileSync, readFileSync, copyFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { loadConfig, loadConfigFile, getLedgerDir, type HookConfig } from '../lib/config.js';
import { fetchPersonaNotes, getClaudeMdContent } from '../lib/notes.js';
import { ask } from '../lib/prompt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function verifyInit(): void {
  const envPath = resolve(getLedgerDir(), '.env');
  if (!existsSync(envPath)) {
    console.error('Ledger not initialized. Run `ledger init` first.');
    process.exit(1);
  }
}

// --- Platform detection ---

export type PlatformName = 'claude-code' | 'openclaw' | 'chatgpt';

export interface PlatformStatus {
  name: PlatformName;
  installed: boolean;
  detail?: string;
}

/** Detect whether a platform is currently installed/configured. */
export function detectPlatform(name: PlatformName): PlatformStatus {
  switch (name) {
    case 'claude-code': {
      try {
        const output = execFileSync('claude', ['mcp', 'list'], { stdio: 'pipe', encoding: 'utf-8' });
        const installed = output.toLowerCase().includes('ledger');
        return { name, installed, detail: installed ? 'MCP registered' : 'Claude Code found, Ledger not registered' };
      } catch {
        return { name, installed: false, detail: 'Claude Code CLI not found' };
      }
    }
    case 'openclaw': {
      // Check common locations for SOUL.md + USER.md
      const configFile = loadConfigFile();
      const openclawPath = (configFile as Record<string, unknown>).openclawPath as string | undefined;
      if (openclawPath && existsSync(resolve(openclawPath, 'SOUL.md')) && existsSync(resolve(openclawPath, 'USER.md'))) {
        return { name, installed: true, detail: openclawPath };
      }
      return { name, installed: false };
    }
    case 'chatgpt': {
      // ChatGPT has no persistent state — never detected as installed
      return { name, installed: false, detail: 'No persistent state' };
    }
  }
}

// --- Uninstall functions ---

/** Remove Ledger MCP registration, hooks, and settings entries for Claude Code. */
export function uninstallClaudeCode(): void {
  // 1. Remove MCP registration
  try {
    execFileSync('claude', ['mcp', 'remove', 'ledger', '-s', 'user'], { stdio: 'pipe' });
    console.error('  Removed MCP registration.');
  } catch {
    console.error('  MCP registration not found (already removed).');
  }

  // 2. Remove hook files
  const claudeHooksDir = resolve(homedir(), '.claude/hooks');
  const hookFiles = ['block-env.sh', 'post-write-ledger.sh', 'session-end-check.sh'];
  for (const file of hookFiles) {
    const hookPath = resolve(claudeHooksDir, file);
    if (existsSync(hookPath)) {
      unlinkSync(hookPath);
      console.error(`  Removed ${file}`);
    }
  }

  // 3. Remove Ledger hook entries from settings.json
  const settingsPath = resolve(homedir(), '.claude/settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      if (settings.hooks) {
        delete settings.hooks;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.error('  Removed hook entries from settings.json');
      }
    } catch {
      // Settings parse error — leave as-is
    }
  }
}

/** Remove SOUL.md and USER.md from OpenClaw workspace. */
export function uninstallOpenclaw(path?: string): void {
  const configFile = loadConfigFile();
  const targetPath = path || (configFile as Record<string, unknown>).openclawPath as string | undefined;
  if (!targetPath) {
    console.error('  No OpenClaw workspace path configured.');
    return;
  }

  const soulPath = resolve(targetPath, 'SOUL.md');
  const userPath = resolve(targetPath, 'USER.md');

  if (existsSync(soulPath)) {
    unlinkSync(soulPath);
    console.error('  Removed SOUL.md');
  }
  if (existsSync(userPath)) {
    unlinkSync(userPath);
    console.error('  Removed USER.md');
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
  } catch (err) {
    console.error(`  Pull failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error('  Run `ledger pull --force` manually to retry.');
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

  const notes = await fetchPersonaNotes(config.supabase);
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

  const notes = await fetchPersonaNotes(config.supabase);
  const claudeMd = getClaudeMdContent(notes);

  if (!claudeMd) {
    console.error('No claude-md note found in Ledger. Create one with type: claude-md first.');
    process.exit(1);
  }

  console.error('WARNING: This is a snapshot, not a live connection.');
  console.error('Run `ledger setup chatgpt` again to regenerate after changes.\n');
  console.error('Copy the text below into ChatGPT > Settings > Custom Instructions:\n');
  console.error('---\n');
  console.log(claudeMd);
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
