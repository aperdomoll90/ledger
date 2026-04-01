import { describe, it, expect } from 'vitest';
import { getMigrationFiles, readMigration } from '../src/lib/migrate.js';

describe('getMigrationFiles', () => {
  it('returns migration files sorted by version', () => {
    const files = getMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files[0]).toContain('000-');
    expect(files[1]).toContain('001-');
    expect(files[2]).toContain('002-');
    expect(files[3]).toContain('003-');
  });

  it('all files end with .sql', () => {
    const files = getMigrationFiles();
    for (const f of files) {
      expect(f).toMatch(/\.sql$/);
    }
  });
});

describe('readMigration', () => {
  it('reads migration content', () => {
    const content = readMigration('000-tracking.sql');
    expect(content).toContain('schema_migrations');
  });

  it('001 creates notes table', () => {
    const content = readMigration('001-schema.sql');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS notes');
    expect(content).toContain('vector(1536)');
    expect(content).toContain('hnsw');
  });

  it('002 creates match_notes function', () => {
    const content = readMigration('002-functions.sql');
    expect(content).toContain('match_notes');
    expect(content).toContain('q_emb text');
  });

  it('003 enables RLS', () => {
    const content = readMigration('003-rls.sql');
    expect(content).toContain('ROW LEVEL SECURITY');
    expect(content).toContain('DROP POLICY IF EXISTS');
  });
});
