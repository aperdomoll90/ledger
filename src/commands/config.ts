import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getLedgerDir, type HookConfig, type NamingConfig } from '../lib/config.js';
import { confirm } from '../lib/prompt.js';

const CONFIG_PATH = resolve(getLedgerDir(), 'config.json');

interface FullConfig {
  memoryDir?: string;
  claudeMdPath?: string;
  hooks?: Partial<HookConfig>;
  naming?: Partial<NamingConfig>;
  device?: { alias: string };
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

const NAMING_DESCRIPTIONS: Record<string, string> = {
  'naming.enforce': 'Validate upsert_key format on note creation',
  'naming.interactive': 'Prompt for missing metadata when creating notes (default: true)',
};

const DEVICE_DESCRIPTIONS: Record<string, string> = {
  'device.alias': 'Name for this device',
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

  // Check naming settings
  if (key === 'naming.enforce') {
    console.log(`naming.enforce: ${config.naming?.enforce ?? false}`);
    return;
  }
  if (key === 'naming.interactive') {
    console.log(`naming.interactive: ${config.naming?.interactive ?? true} (default: true)`);
    return;
  }

  // Check device
  if (key === 'device.alias') {
    console.log(`device.alias: ${config.device?.alias || '(not set)'}`);
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

  const allKeys = [...Object.keys(DESCRIPTIONS), ...Object.keys(NAMING_DESCRIPTIONS), ...Object.keys(DEVICE_DESCRIPTIONS), 'memoryDir', 'claudeMdPath', 'all'];
  console.error(`Unknown config key: ${key}`);
  console.error(`Available: ${allKeys.join(', ')}`);
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

  // Handle naming settings
  const namingKeys = ['naming.enforce', 'naming.interactive'];
  if (namingKeys.includes(key)) {
    const boolValue = value === 'true';
    if (!config.naming) config.naming = {};
    const field = key.split('.')[1] as keyof NamingConfig;
    config.naming[field] = boolValue;
    saveConfig(config);
    console.error(`${key}: ${boolValue ? 'enabled' : 'disabled'}`);
    return;
  }

  // Handle device alias
  if (key === 'device.alias') {
    config.device = { alias: value };
    saveConfig(config);
    console.error(`device.alias: ${value}`);
    return;
  }

  // Handle path settings
  if (key === 'memoryDir' || key === 'claudeMdPath') {
    (config as Record<string, unknown>)[key] = value;
    saveConfig(config);
    console.error(`${key}: ${value}`);
    return;
  }

  const allKeys = [...hookKeys, ...namingKeys, 'device.alias', 'memoryDir', 'claudeMdPath'];
  console.error(`Unknown config key: ${key}`);
  console.error(`Available: ${allKeys.join(', ')}`);
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

  console.error('\nNaming settings:');
  for (const [key, desc] of Object.entries(NAMING_DESCRIPTIONS)) {
    const field = key.split('.')[1] as keyof NamingConfig;
    const defaultVal = field === 'interactive' ? true : false;
    const value = config.naming?.[field] ?? defaultVal;
    const state = value ? 'enabled' : 'DISABLED';
    console.error(`  ${key}: ${state} — ${desc}`);
  }

  console.error('\nDevice:');
  console.error(`  device.alias: ${config.device?.alias || '(not set)'}`);

  console.error('\nPaths:');
  console.error(`  memoryDir: ${config.memoryDir || '(default)'}`);
  console.error(`  claudeMdPath: ${config.claudeMdPath || '(default)'}`);

  console.error('\nConfig file: ' + CONFIG_PATH);
}
