import { describe, it, expect } from 'vitest';
import type {
  Domain,
  Protection,
  OwnerType,
  DocumentStatus,
  SourceType,
  ChunkStrategy,
  ChunkContentType,
  IDocumentProps,
  ICreateDocumentProps,
  IUpdateDocumentProps,
  IUpdateFieldsProps,
  IListDocumentsProps,
  IClientsProps,
} from '../src/lib/document-classification.js';

describe('document-classification types', () => {
  it('IDocumentProps has all document table columns', () => {
    // This test verifies the interface matches the database at compile time.
    // If a column is missing, this won't compile.
    const doc: IDocumentProps = {
      id: 1,
      name: 'test-doc',
      domain: 'general',
      document_type: 'knowledge',
      project: null,
      protection: 'open',
      owner_type: 'user',
      owner_id: null,
      is_auto_load: false,
      content: 'Test content',
      description: null,
      content_hash: null,
      file_path: null,
      file_permissions: null,
      source_type: 'text',
      source_url: null,
      agent: null,
      status: null,
      skill_ref: null,
      embedding_model_id: null,
      schema_version: 1,
      content_length: 12,
      chunk_count: 1,
      retrieval_count: 0,
      deleted_at: null,
      created_at: '2026-03-30T00:00:00Z',
      updated_at: '2026-03-30T00:00:00Z',
    };
    expect(doc.id).toBe(1);
    expect(doc.name).toBe('test-doc');
    expect(doc.domain).toBe('general');
  });

  it('ICreateDocumentProps requires only 4 fields', () => {
    const create: ICreateDocumentProps = {
      name: 'test',
      domain: 'general',
      document_type: 'knowledge',
      content: 'Hello',
    };
    expect(create.name).toBe('test');
    // Optional fields should be undefined
    expect(create.description).toBeUndefined();
    expect(create.project).toBeUndefined();
  });

  it('Domain type only accepts valid domains', () => {
    const validDomains: Domain[] = ['system', 'persona', 'workspace', 'project', 'general'];
    expect(validDomains).toHaveLength(5);
  });

  it('Protection type only accepts valid levels', () => {
    const validProtections: Protection[] = ['open', 'guarded', 'protected', 'immutable'];
    expect(validProtections).toHaveLength(4);
  });

  it('SourceType includes all ingestion formats', () => {
    const validSources: SourceType[] = [
      'text', 'pdf', 'docx', 'spreadsheet', 'code',
      'image', 'audio', 'video', 'web', 'email', 'slides', 'handwriting',
    ];
    expect(validSources).toHaveLength(12);
  });

  it('IUpdateDocumentProps requires only id and content', () => {
    const update: IUpdateDocumentProps = {
      id: 42,
      content: 'New content',
    };
    expect(update.id).toBe(42);
    expect(update.agent).toBeUndefined();
  });

  it('IUpdateFieldsProps requires only id', () => {
    const update: IUpdateFieldsProps = {
      id: 42,
    };
    expect(update.id).toBe(42);
    expect(update.domain).toBeUndefined();
  });

  it('IListDocumentsProps is fully optional', () => {
    const list: IListDocumentsProps = {};
    expect(list.domain).toBeUndefined();
    expect(list.limit).toBeUndefined();
  });
});
