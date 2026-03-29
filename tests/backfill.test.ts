import { describe, it, expect } from 'vitest';
import { backfillMetadata } from '../src/lib/backfill.js';

describe('backfillMetadata', () => {
  it('sets schema_version to 1', () => {
    const result = backfillMetadata({ type: 'event', delivery: 'project' });
    expect(result.schema_version).toBe(1);
  });

  it('sets embedding tracking fields', () => {
    const result = backfillMetadata({ type: 'event' });
    expect(result.embedding_model).toBe('openai/text-embedding-3-small');
    expect(result.embedding_dimensions).toBe(1536);
  });

  it('sets owner_type to user and owner_id to null', () => {
    const result = backfillMetadata({ type: 'event' });
    expect(result.owner_type).toBe('user');
    expect(result.owner_id).toBeNull();
  });

  it('migrates user-preference to persona/preference', () => {
    const result = backfillMetadata({ type: 'user-preference', delivery: 'persona' });
    expect(result.type).toBe('preference');
    expect(result.domain).toBe('persona');
  });

  it('migrates persona-rule to persona/behavioral-rule', () => {
    const result = backfillMetadata({ type: 'persona-rule', delivery: 'persona' });
    expect(result.type).toBe('behavioral-rule');
    expect(result.domain).toBe('persona');
  });

  it('migrates code-craft to persona/preference', () => {
    const result = backfillMetadata({ type: 'code-craft', delivery: 'persona' });
    expect(result.type).toBe('preference');
    expect(result.domain).toBe('persona');
  });

  it('migrates system-rule to system/sync-rule', () => {
    const result = backfillMetadata({ type: 'system-rule', delivery: 'persona' });
    expect(result.type).toBe('sync-rule');
    expect(result.domain).toBe('system');
  });

  it('migrates architecture-decision to project/architecture', () => {
    const result = backfillMetadata({ type: 'architecture-decision', delivery: 'project' });
    expect(result.type).toBe('architecture');
    expect(result.domain).toBe('project');
  });

  it('migrates skill-reference to persona/skill', () => {
    const result = backfillMetadata({ type: 'skill-reference', delivery: 'protected' });
    expect(result.type).toBe('skill');
    expect(result.domain).toBe('persona');
  });

  it('migrates knowledge-guide to project/knowledge', () => {
    const result = backfillMetadata({ type: 'knowledge-guide', delivery: 'knowledge' });
    expect(result.type).toBe('knowledge');
    expect(result.domain).toBe('project');
  });

  it('keeps event type, infers project domain', () => {
    const result = backfillMetadata({ type: 'event', delivery: 'project' });
    expect(result.type).toBe('event');
    expect(result.domain).toBe('project');
  });

  it('keeps error type, infers project domain', () => {
    const result = backfillMetadata({ type: 'error', delivery: 'project' });
    expect(result.type).toBe('error');
    expect(result.domain).toBe('project');
  });

  it('maps reference with delivery=knowledge to project/reference', () => {
    const result = backfillMetadata({ type: 'reference', delivery: 'knowledge' });
    expect(result.type).toBe('reference');
    expect(result.domain).toBe('project');
  });

  it('maps general with delivery=knowledge to project/knowledge', () => {
    const result = backfillMetadata({ type: 'general', delivery: 'knowledge' });
    expect(result.type).toBe('knowledge');
    expect(result.domain).toBe('project');
  });

  it('sets protection from type defaults', () => {
    const result = backfillMetadata({ type: 'persona-rule', delivery: 'persona' });
    expect(result.protection).toBe('protected');
  });

  it('sets auto_load from domain defaults', () => {
    const persona = backfillMetadata({ type: 'persona-rule', delivery: 'persona' });
    expect(persona.auto_load).toBe(true);

    const project = backfillMetadata({ type: 'event', delivery: 'project' });
    expect(project.auto_load).toBe(false);
  });

  it('is idempotent — skips notes that already have domain', () => {
    const alreadyMigrated = {
      type: 'preference',
      domain: 'persona',
      protection: 'guarded',
      auto_load: true,
      schema_version: 1,
    };
    const result = backfillMetadata(alreadyMigrated);
    expect(result).toEqual(alreadyMigrated);
  });

  it('preserves existing metadata fields', () => {
    const result = backfillMetadata({
      type: 'event',
      delivery: 'project',
      project: 'ledger',
      upsert_key: 'ledger-devlog',
      description: 'Dev timeline',
    });
    expect(result.project).toBe('ledger');
    expect(result.upsert_key).toBe('ledger-devlog');
    expect(result.description).toBe('Dev timeline');
  });

  it('derives file_path from local_file for persona notes', () => {
    const result = backfillMetadata({
      type: 'persona-rule',
      delivery: 'persona',
      local_file: 'feedback_communication_style.md',
    });
    expect(result.file_path).toContain('feedback_communication_style.md');
    expect(result.file_permissions).toBe('644');
  });
});
