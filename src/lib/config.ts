import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { observeOpenAI } from '@langfuse/openai';
import { resolve } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fatal, ExitCode } from './errors.js';
import { openaiLimiter, updateLimitsFromHeaders } from './rate-limiter.js';
import { initObservability } from './observability.js';

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

export interface NamingConfig {
  enforce: boolean;
  interactive: boolean;
}

export interface LedgerConfig {
  memoryDir: string;
  claudeMdPath: string;
  supabase: SupabaseClient;
  openai: OpenAI;
  cohereApiKey?: string;
  // Observability (Phase 2): mirror IClientsProps so loadConfig output is
  // directly passable to search functions.
  sessionId?: string;
  observabilityEnvironment?: string;
}

export interface ILoadConfigOptionsProps {
  sessionId?: string;
  observabilityEnvironment?: string;
}

export interface ConfigFile {
  memoryDir?: string;
  claudeMdPath?: string;
  hooks?: Partial<HookConfig>;
  naming?: Partial<NamingConfig>;
  device?: { alias: string };
  types?: Record<string, 'persona' | 'project' | 'knowledge' | 'protected'>;
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

export function saveConfigFile(config: ConfigFile): void {
  const configPath = resolve(getLedgerDir(), 'config.json');
  mkdirSync(getLedgerDir(), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
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

// --- Custom fetch for rate limit header interception ---

// Wraps the global fetch to read OpenAI's rate limit headers on every response.
// This works below both the OpenAI SDK and the Langfuse wrapper, so header
// reading survives regardless of how the client is wrapped.
const openaiHeaderFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  await updateLimitsFromHeaders(openaiLimiter, response.headers);
  return response;
};

// --- Load Config ---

export function loadConfig(options?: ILoadConfigOptionsProps): LedgerConfig {
  // Priority: env vars > DOTENV_CONFIG_PATH > ~/.ledger/.env
  const dotenvPath = process.env.DOTENV_CONFIG_PATH
    || (existsSync(LEDGER_DOTENV) ? LEDGER_DOTENV : undefined);
  if (dotenvPath) dotenv.config({ path: dotenvPath, quiet: true });

  // Init observability after dotenv loads (Langfuse env vars are now available)
  initObservability();

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
    openai: observeOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 5, fetch: openaiHeaderFetch })),
    cohereApiKey: process.env.COHERE_API_KEY || undefined,
    sessionId: options?.sessionId,
    observabilityEnvironment: options?.observabilityEnvironment,
  };
}
