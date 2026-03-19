import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { resolve } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { fatal, ExitCode } from './errors.js';

// --- Defaults ---

const LEDGER_DIR = resolve(homedir(), '.ledger');
const LEDGER_DOTENV = resolve(LEDGER_DIR, '.env');
// Claude Code encodes the working directory as folder name: /home/user → -home-user
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

export interface ConfigFile {
  memoryDir?: string;
  claudeMdPath?: string;
  hooks?: Partial<HookConfig>;
  device?: { alias: string };
}

// --- Helpers ---

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

// --- Load Config ---

export function loadConfig(): LedgerConfig {
  // Priority: env vars > DOTENV_CONFIG_PATH > ~/.ledger/.env
  const dotenvPath = process.env.DOTENV_CONFIG_PATH
    || (existsSync(LEDGER_DOTENV) ? LEDGER_DOTENV : undefined);
  if (dotenvPath) dotenv.config({ path: dotenvPath, quiet: true });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    fatal('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run `ledger init` or check your .env file.', ExitCode.GENERAL_ERROR);
  }

  if (!process.env.OPENAI_API_KEY) {
    fatal('Missing OPENAI_API_KEY. Run `ledger init` or check your .env file.', ExitCode.GENERAL_ERROR);
  }

  const fileConfig = loadConfigFile();

  return {
    memoryDir: process.env.LEDGER_MEMORY_DIR || fileConfig.memoryDir || DEFAULT_MEMORY_DIR,
    claudeMdPath: process.env.LEDGER_CLAUDE_MD_PATH || fileConfig.claudeMdPath || DEFAULT_CLAUDE_MD_PATH,
    supabase: createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    ),
    openai: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  };
}
