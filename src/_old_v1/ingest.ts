import { readFileSync, unlinkSync, readdirSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import type { LedgerConfig } from '../lib/config.js';
import { fetchPersonaNotes, findNoteByFile, searchNotes, inferDomain, type NoteRow } from '../lib/notes.js';
import type { Domain } from '../lib/domains.js';
import { contentHash } from '../lib/hash.js';
import { confirm, choose } from '../lib/prompt.js';

interface IngestOptions {
  file?: string;
  auto?: boolean;
}

export async function ingest(config: LedgerConfig, options: IngestOptions): Promise<void> {
  const existingNotes = await fetchPersonaNotes(config.supabase);

  if (options.file) {
    if (options.auto) {
      await autoIngestFile(config, resolve(options.file), existingNotes);
    } else {
      await ingestFile(config, resolve(options.file), existingNotes);
    }
    return;
  }

  // Scan memory dir for unknown files
  if (!existsSync(config.memoryDir)) {
    console.error('Memory directory not found.');
    return;
  }

  const knownFiles = new Set(
    existingNotes
      .map(n => n.metadata.file_path as string | undefined)
      .filter(Boolean),
  );

  const localFiles = readdirSync(config.memoryDir)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md' && !knownFiles.has(f));

  if (localFiles.length === 0) {
    console.error('No unknown files found.');
    return;
  }

  console.error(`Found ${localFiles.length} unknown file(s):\n`);

  for (const file of localFiles) {
    const filePath = resolve(config.memoryDir, file);
    await ingestFile(config, filePath, existingNotes);
    console.error('');
  }
}

async function ingestFile(config: LedgerConfig, filePath: string, existingNotes: NoteRow[]): Promise<void> {
  const filename = basename(filePath);
  const content = readFileSync(filePath, 'utf-8').trim();
  const hash = contentHash(content);

  console.error(`--- ${filename} ---`);

  // Step 1: Check for exact duplicates by hash
  const exactMatch = existingNotes.find(n => (n.metadata as Record<string, unknown>).content_hash === hash);

  if (exactMatch) {
    const key = (exactMatch.metadata.upsert_key as string) || `note-${exactMatch.id}`;
    console.error(`This file is identical to "${key}" in Ledger.`);
    console.error(`\nExisting note content:\n${exactMatch.content.slice(0, 500)}${exactMatch.content.length > 500 ? '\n...' : ''}\n`);

    const skip = await confirm('Skip ingestion?');
    if (skip) {
      console.error(`Skipped ${filename}.`);
      return;
    }
  }

  // Step 2: Check for similar notes by embedding
  if (!exactMatch) {
    const similar = await searchNotes(config.supabase, config.openai, content, 0.5, 3);

    if (similar.length > 0) {
      const topMatch = similar[0];
      const key = (topMatch.metadata.upsert_key as string) || `note-${topMatch.id}`;
      console.error(`Similar note found: "${key}" (similarity: ${topMatch.similarity.toFixed(3)})`);
      console.error(`\nExisting:\n${topMatch.content.slice(0, 500)}${topMatch.content.length > 500 ? '\n...' : ''}`);
      console.error(`\nNew:\n${content.slice(0, 500)}${content.length > 500 ? '\n...' : ''}\n`);

      const action = await choose('What would you like to do?', [
        'Merge into existing',
        'Replace existing',
        'Add as new note',
        'Skip',
      ]);

      switch (action) {
        case 'Merge into existing': {
          const merged = `${topMatch.content}\n\n---\n\n${content}`;
          await updateAndHash(config, topMatch.id, merged);
          console.error(`Merged into "${key}".`);
          await askDeleteLocal(filePath, filename);
          return;
        }
        case 'Replace existing': {
          await updateAndHash(config, topMatch.id, content);
          console.error(`Replaced "${key}".`);
          await askDeleteLocal(filePath, filename);
          return;
        }
        case 'Skip': {
          console.error(`Skipped ${filename}.`);
          return;
        }
        // 'Add as new note' falls through to create below
      }
    }
  }

  // Step 3: No match or user chose "Add as new" — create new note
  const shouldIngest = exactMatch ? true : await confirm(`Add "${filename}" to Ledger?`);

  if (!shouldIngest) {
    console.error(`Skipped ${filename}.`);
    return;
  }

  const noteType = await choose('Note type:', [
    'feedback',
    'user-preference',
    'architecture-decision',
    'project-status',
    'reference',
    'event',
    'error',
    'general',
  ]);

  const defaultDomain = inferDomain(noteType);
  const domainChoice = await choose(`Domain (default: ${defaultDomain}):`, [
    `${defaultDomain} (default)`,
    ...(['system', 'persona', 'workspace', 'project'] as const).filter(d => d !== defaultDomain),
  ]);
  const domain = domainChoice.replace(' (default)', '') as Domain;

  const { openai } = config;
  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: content,
  });
  const embedding = embeddingResponse.data[0].embedding;

  const upsertKey = filename.replace(/\.md$/, '').replace(/_/g, '-');

  const { data, error } = await config.supabase
    .from('notes')
    .insert({
      content,
      metadata: {
        type: noteType,
        agent: 'ledger-ingest',
        upsert_key: upsertKey,
        file_path: filename,
        content_hash: hash,
        domain,
      },
      embedding,
    })
    .select('id')
    .single();

  if (error) {
    console.error(`Error adding note: ${error.message}`);
    return;
  }

  console.error(`Added "${filename}" → Ledger (note ${data.id}, domain: ${domain})`);
  await askDeleteLocal(filePath, filename);
}

async function updateAndHash(
  config: LedgerConfig,
  noteId: number,
  content: string,
): Promise<void> {
  const { openai, supabase } = config;

  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: content,
  });
  const embedding = embeddingResponse.data[0].embedding;
  const hash = contentHash(content);

  const { data: note } = await supabase
    .from('notes')
    .select('metadata')
    .eq('id', noteId)
    .single();

  const metadata = {
    ...(note?.metadata as Record<string, unknown> || {}),
    content_hash: hash,
  };

  await supabase
    .from('notes')
    .update({ content, embedding, metadata, updated_at: new Date().toISOString() })
    .eq('id', noteId);
}

async function askDeleteLocal(filePath: string, filename: string): Promise<void> {
  const shouldDelete = await confirm(`Delete local file "${filename}"?`);
  if (shouldDelete) {
    unlinkSync(filePath);
    console.error(`Deleted ${filename}.`);
  } else {
    console.error(`Kept ${filename} locally.`);
  }
}

async function autoIngestFile(config: LedgerConfig, filePath: string, existingNotes: NoteRow[]): Promise<void> {
  if (!existsSync(filePath)) return;

  const filename = basename(filePath);
  const content = readFileSync(filePath, 'utf-8').trim();
  const hash = contentHash(content);

  // Check for exact duplicate — skip silently if identical
  const exactMatch = existingNotes.find(n => (n.metadata as Record<string, unknown>).content_hash === hash);

  if (exactMatch) {
    console.error(`AUTO: ${filename} — identical to existing note, skipped.`);
    return;
  }

  // Check if a note already exists for this file (by file_path or upsert_key)
  const existingNote = await findNoteByFile(config.supabase, filename);

  if (existingNote) {
    // Update existing note instead of creating a duplicate
    await updateAndHash(config, existingNote.id, content);
    console.error(`AUTO: ${filename} — updated existing note ${existingNote.id}.`);
    return;
  }

  // No existing note — create new
  // Infer type from filename
  let noteType = 'general';
  if (filename.startsWith('feedback_')) noteType = 'feedback';
  else if (filename.startsWith('user_')) noteType = 'user-preference';
  else if (filename.startsWith('project_')) noteType = 'project-status';
  else if (filename.startsWith('reference_')) noteType = 'reference';

  const embeddingResponse = await config.openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: content,
  });
  const embedding = embeddingResponse.data[0].embedding;

  const upsertKey = filename.replace(/\.md$/, '').replace(/_/g, '-');

  const noteDomain = inferDomain(noteType);

  const { data, error } = await config.supabase
    .from('notes')
    .insert({
      content,
      metadata: {
        type: noteType,
        agent: 'ledger-auto-ingest',
        upsert_key: upsertKey,
        file_path: filename,
        content_hash: hash,
        domain: noteDomain,
      },
      embedding,
    })
    .select('id')
    .single();

  if (error) {
    console.error(`AUTO: Error ingesting ${filename}: ${error.message}`);
    return;
  }

  console.error(`AUTO: ${filename} → Ledger (note ${data.id}, domain: ${noteDomain}).`);
}
