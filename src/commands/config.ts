import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getLedgerDir, type HookConfig } from '../lib/config.js';
import { confirm } from '../lib/prompt.js';

const CONFIG_PATH = resolve(getLedgerDir(), 'config.json');

interface FullConfig {
  memoryDir?: string;
  claudeMdPath?: string;
  hooks?: Partial<HookConfig>;
}

function loadFullConfig(): FullConfig {
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveConfig(config: FullConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

const SECURITY_WARNINGS: Record<string, string> = {
  envBlocking: 'This disables .env file protection.\nYour API keys and credentials will be readable by the AI agent.',
  mcpJsonBlocking: 'This allows direct editing of mcp.json.\nMCP servers should be registered via `claude mcp add`, not by editing config files.',
};

const DESCRIPTIONS: Record<string, string> = {
  envBlocking: 'Block reading/writing .env and credential files',
  mcpJsonBlocking: 'Block direct editing of mcp.json',
  writeInterception: 'Auto-ingest files written to memory directory into Ledger',
  sessionEndCheck: 'Check for unsynced files at session end',
};

export async function configGet(key: string): Promise<void> {
  const config = loadFullConfig();

  if (key === 'all') {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  // Check hooks
  const hookKey = key as keyof HookConfig;
  if (hookKey in (config.hooks || {})) {
    console.log(`${key}: ${config.hooks?.[hookKey]}`);
    return;
  }

  // Check top-level
  if (key in config) {
    console.log(`${key}: ${(config as Record<string, unknown>)[key]}`);
    return;
  }

  // Show default
  const defaults: Record<string, unknown> = {
    envBlocking: true,
    mcpJsonBlocking: true,
    writeInterception: true,
    sessionEndCheck: true,
  };

  if (key in defaults) {
    console.log(`${key}: ${defaults[key]} (default)`);
    return;
  }

  console.error(`Unknown config key: ${key}`);
  console.error(`Available: ${Object.keys(DESCRIPTIONS).join(', ')}, memoryDir, claudeMdPath, all`);
  process.exit(1);
}

export async function configSet(key: string, value: string): Promise<void> {
  const config = loadFullConfig();

  // Handle hook settings
  const hookKeys = ['envBlocking', 'mcpJsonBlocking', 'writeInterception', 'sessionEndCheck'];

  if (hookKeys.includes(key)) {
    const boolValue = value === 'true';

    // Disabling a security feature — warn and double confirm
    if (!boolValue && key in SECURITY_WARNINGS) {
      console.error(`\nWARNING: ${SECURITY_WARNINGS[key]}\n`);
      const first = await confirm('Are you sure?');
      if (!first) {
        console.error('Cancelled.');
        return;
      }
      const second = await confirm(`Confirm: disable ${key}?`);
      if (!second) {
        console.error('Cancelled.');
        return;
      }
    }

    if (!config.hooks) config.hooks = {};
    config.hooks[key as keyof HookConfig] = boolValue;
    saveConfig(config);

    const state = boolValue ? 'enabled' : 'disabled';
    console.error(`${key}: ${state}`);
    console.error('Run `ledger setup claude-code` to apply hook changes.');
    return;
  }

  // Handle path settings
  if (key === 'memoryDir' || key === 'claudeMdPath') {
    (config as Record<string, unknown>)[key] = value;
    saveConfig(config);
    console.error(`${key}: ${value}`);
    return;
  }

  console.error(`Unknown config key: ${key}`);
  console.error(`Available: ${hookKeys.join(', ')}, memoryDir, claudeMdPath`);
  process.exit(1);
}

export async function configList(): Promise<void> {
  const config = loadFullConfig();
  const hooks = config.hooks || {};

  console.error('Hook settings:');
  for (const [key, desc] of Object.entries(DESCRIPTIONS)) {
    const value = hooks[key as keyof HookConfig] ?? true;
    const state = value ? 'enabled' : 'DISABLED';
    console.error(`  ${key}: ${state} — ${desc}`);
  }

  console.error('\nPaths:');
  console.error(`  memoryDir: ${config.memoryDir || '(default)'}`);
  console.error(`  claudeMdPath: ${config.claudeMdPath || '(default)'}`);

  console.error('\nConfig file: ' + CONFIG_PATH);
}
