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
  const { data, error } = await supabase
    .from('schema_migrations')
    .select('version');

  if (error) {
    // Table doesn't exist yet — no migrations applied
    return new Set();
  }

  return new Set((data || []).map(r => r.version));
}
