import { readFileSync, existsSync, mkdirSync, cpSync, readdirSync } from 'fs';
import { resolve, basename, join } from 'path';
import { homedir } from 'os';
import type { LedgerConfig } from '../lib/config.js';
import { searchNotes, inferDelivery, type NoteRow, type NoteMetadata } from '../lib/notes.js';
import { contentHash } from '../lib/hash.js';
import { confirm, choose } from '../lib/prompt.js';

interface MigrateStats {
  uploaded: number;
  combined: number;
  skipped: number;
  alreadyInLedger: number;
}

export async function migrate(config: LedgerConfig): Promise<void> {
  const stats: MigrateStats = { uploaded: 0, combined: 0, skipped: 0, alreadyInLedger: 0 };

  // Phase 1: Backup
  console.error('\n=== Phase 1: Backup ===\n');
  const backupDir = await backupExisting(config);
  console.error(`  Backup saved to ${backupDir}\n`);

  // Load all existing notes from Ledger once
  const existingNotes = await fetchAllNotes(config);
  console.error(`  Ledger has ${existingNotes.length} notes.\n`);

  // Phase 2: Parse references from CLAUDE.md and MEMORY.md
  console.error('=== Phase 2: Scan references ===\n');
  const referencedFiles = parseReferences(config);
  console.error(`  Found ${referencedFiles.size} referenced files.\n`);

  // Phase 3: Process referenced files first
  console.error('=== Phase 3: Process referenced files ===\n');
  const memoryFiles = getMemoryFiles(config);
  const referencedList = memoryFiles.filter(f => referencedFiles.has(f));
  const orphanList = memoryFiles.filter(f => !referencedFiles.has(f));

  if (referencedList.length > 0) {
    console.error(`  ${referencedList.length} referenced file(s) to process:\n`);
    for (const filename of referencedList) {
      const filePath = resolve(config.memoryDir, filename);
      await processFile(config, filePath, existingNotes, stats);
    }
  } else {
    console.error('  No referenced files found.\n');
  }

  // Phase 4: Process CLAUDE.md rules
  console.error('\n=== Phase 4: CLAUDE.md rules ===\n');
  await processClaudeMd(config, existingNotes, stats);

  // Phase 5: Process orphaned files
  if (orphanList.length > 0) {
    console.error('\n=== Phase 5: Orphaned files ===\n');
    console.error(`  ${orphanList.length} file(s) not linked in CLAUDE.md or MEMORY.md:\n`);
    for (const filename of orphanList) {
      const filePath = resolve(config.memoryDir, filename);
      await processFile(config, filePath, existingNotes, stats);
    }
  }

  // Phase 6: Summary
  console.error('\n=== Migration complete ===\n');
  console.error(`  ${stats.uploaded} uploaded`);
  console.error(`  ${stats.combined} combined`);
  console.error(`  ${stats.alreadyInLedger} already in Ledger`);
  console.error(`  ${stats.skipped} skipped`);
  console.error(`  Backup: ${backupDir}`);
  console.error(`\n  Next: run \`ledger setup claude\` to install hooks and pull.\n`);
}

async function backupExisting(config: LedgerConfig): Promise<string> {
  const date = new Date().toISOString().split('T')[0];
  const backupDir = resolve(homedir(), '.ledger', 'migration-backup', date);
  mkdirSync(backupDir, { recursive: true });

  // Backup memory directory
  if (existsSync(config.memoryDir)) {
    const memBackup = join(backupDir, 'memory');
    mkdirSync(memBackup, { recursive: true });
    const files = readdirSync(config.memoryDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const src = resolve(config.memoryDir, f);
      const dst = join(memBackup, f);
      cpSync(src, dst);
    }
    console.error(`  Backed up ${files.length} memory files`);
  }

  // Backup global CLAUDE.md
  if (existsSync(config.claudeMdPath)) {
    cpSync(config.claudeMdPath, join(backupDir, 'CLAUDE.md'));
    console.error('  Backed up CLAUDE.md');
  }

  return backupDir;
}

export function parseReferences(config: LedgerConfig): Set<string> {
  const referenced = new Set<string>();

  // Parse MEMORY.md for linked files: [name](filename.md)
  const memoryMdPath = resolve(config.memoryDir, 'MEMORY.md');
  if (existsSync(memoryMdPath)) {
    const content = readFileSync(memoryMdPath, 'utf-8');
    const linkRegex = /\[.*?\]\(([^)]+\.md)\)/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      referenced.add(basename(match[1]));
    }
    console.error(`  MEMORY.md links to ${referenced.size} files`);
  }

  // Parse CLAUDE.md for .md file references
  if (existsSync(config.claudeMdPath)) {
    const content = readFileSync(config.claudeMdPath, 'utf-8');
    const mdRefRegex = /[\w_-]+\.md/g;
    let match;
    while ((match = mdRefRegex.exec(content)) !== null) {
      const filename = match[0];
      if (filename !== 'CLAUDE.md' && filename !== 'MEMORY.md' && filename !== 'README.md') {
        referenced.add(filename);
      }
    }
  }

  return referenced;
}

export function getMemoryFiles(config: LedgerConfig): string[] {
  if (!existsSync(config.memoryDir)) return [];
  return readdirSync(config.memoryDir)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
}

async function processFile(
  config: LedgerConfig,
  filePath: string,
  existingNotes: NoteRow[],
  stats: MigrateStats,
): Promise<void> {
  const filename = basename(filePath);
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return;

  const hash = contentHash(content);

  console.error(`  --- ${filename} ---`);

  // Check 1: exact match by upsert_key
  const upsertKey = filename.replace(/\.md$/, '').replace(/_/g, '-');
  const keyMatch = existingNotes.find(
    n => n.metadata.upsert_key === upsertKey,
  );

  if (keyMatch) {
    const ledgerHash = keyMatch.metadata.content_hash;
    if (ledgerHash === hash) {
      console.error(`  Exact match in Ledger (note ${keyMatch.id}). Skipping.\n`);
      stats.alreadyInLedger++;
      return;
    }
    // Same key but different content
    console.error(`  Found in Ledger (note ${keyMatch.id}) but content differs.`);
    await handleDifference(config, content, keyMatch, stats);
    return;
  }

  // Check 2: exact match by content hash
  const hashMatch = existingNotes.find(
    n => n.metadata.content_hash === hash,
  );

  if (hashMatch) {
    const key = hashMatch.metadata.upsert_key || `note-${hashMatch.id}`;
    console.error(`  Identical content found in Ledger as "${key}". Skipping.\n`);
    stats.alreadyInLedger++;
    return;
  }

  // Check 3: semantic similarity
  const similar = await searchNotes(config.supabase, config.openai, content, 0.5, 1);

  if (similar.length > 0 && similar[0].similarity > 0.85) {
    const match = similar[0];
    const key = match.metadata.upsert_key || `note-${match.id}`;
    console.error(`  Similar to "${key}" (${(match.similarity * 100).toFixed(0)}% match)`);
    await handleDifference(config, content, match, stats);
    return;
  }

  // No match — new file
  console.error('  Not in Ledger.');
  const shouldUpload = await confirm('  Upload to Ledger?');

  if (!shouldUpload) {
    console.error('  Skipped.\n');
    stats.skipped++;
    return;
  }

  await uploadNewNote(config, filename, content, hash);
  stats.uploaded++;
  console.error('');
}

async function handleDifference(
  config: LedgerConfig,
  localContent: string,
  ledgerNote: NoteRow,
  stats: MigrateStats,
): Promise<void> {
  const key = ledgerNote.metadata.upsert_key || `note-${ledgerNote.id}`;

  // Show preview of differences
  const localLines = localContent.split('\n').length;
  const ledgerLines = ledgerNote.content.split('\n').length;
  console.error(`\n  Local: ${localLines} lines`);
  console.error(`  Ledger "${key}": ${ledgerLines} lines`);

  // Find lines only in local
  const localSet = new Set(localContent.split('\n').map(l => l.trim()).filter(Boolean));
  const ledgerSet = new Set(ledgerNote.content.split('\n').map(l => l.trim()).filter(Boolean));
  const onlyLocal = [...localSet].filter(l => !ledgerSet.has(l));
  const onlyLedger = [...ledgerSet].filter(l => !localSet.has(l));

  if (onlyLocal.length > 0) {
    console.error(`\n  Only in local (${onlyLocal.length} lines):`);
    for (const line of onlyLocal.slice(0, 10)) {
      console.error(`    + ${line}`);
    }
    if (onlyLocal.length > 10) console.error(`    ... and ${onlyLocal.length - 10} more`);
  }

  if (onlyLedger.length > 0) {
    console.error(`\n  Only in Ledger (${onlyLedger.length} lines):`);
    for (const line of onlyLedger.slice(0, 10)) {
      console.error(`    - ${line}`);
    }
    if (onlyLedger.length > 10) console.error(`    ... and ${onlyLedger.length - 10} more`);
  }

  console.error('');
  const action = await choose('  Action:', [
    'Combine (merge both)',
    'Keep Ledger version',
    'Keep local version',
    'Keep both as separate notes',
    'Skip',
  ]);

  switch (action) {
    case 'Combine (merge both)': {
      const combined = combineContent(ledgerNote.content, localContent);
      await updateNote(config, ledgerNote.id, combined, ledgerNote.metadata);
      console.error(`  Combined into note ${ledgerNote.id}.\n`);
      stats.combined++;
      break;
    }
    case 'Keep Ledger version': {
      console.error(`  Kept Ledger version.\n`);
      stats.alreadyInLedger++;
      break;
    }
    case 'Keep local version': {
      await updateNote(config, ledgerNote.id, localContent, ledgerNote.metadata);
      console.error(`  Updated Ledger with local version.\n`);
      stats.uploaded++;
      break;
    }
    case 'Keep both as separate notes': {
      const filename = `migrated-${Date.now()}.md`;
      await uploadNewNote(config, filename, localContent, contentHash(localContent));
      console.error(`  Added local as separate note.\n`);
      stats.uploaded++;
      break;
    }
    case 'Skip': {
      console.error('  Skipped.\n');
      stats.skipped++;
      break;
    }
  }
}

export function combineContent(ledgerContent: string, localContent: string): string {
  const ledgerLines = new Set(ledgerContent.split('\n').map(l => l.trim()));
  const localLines = localContent.split('\n');

  // Add lines from local that aren't in Ledger
  const newLines = localLines.filter(l => !ledgerLines.has(l.trim()) && l.trim() !== '');

  if (newLines.length === 0) return ledgerContent;

  return `${ledgerContent}\n\n${newLines.join('\n')}`;
}

async function processClaudeMd(
  config: LedgerConfig,
  existingNotes: NoteRow[],
  stats: MigrateStats,
): Promise<void> {
  if (!existsSync(config.claudeMdPath)) {
    console.error('  No CLAUDE.md found. Skipping.\n');
    return;
  }

  const content = readFileSync(config.claudeMdPath, 'utf-8');

  // Extract sections (## headings)
  const sections = extractSections(content);
  const feedbackNotes = existingNotes.filter(
    n => n.metadata.type === 'feedback',
  );

  // Pre-compute hash map for feedback notes to avoid repeated hashing
  const feedbackHashMap = new Map<string, NoteRow>();
  for (const note of feedbackNotes) {
    feedbackHashMap.set(contentHash(note.content), note);
  }

  console.error(`  Found ${sections.length} sections in CLAUDE.md`);
  console.error(`  Ledger has ${feedbackNotes.length} feedback notes\n`);

  for (const section of sections) {
    const sectionContent = section.content.trim();
    if (!sectionContent) continue;

    console.error(`  --- ${section.heading} ---`);

    // Check if this section's content exists in any feedback note
    const hash = contentHash(sectionContent);
    const exactMatch = feedbackHashMap.get(hash);

    if (exactMatch) {
      const key = exactMatch.metadata.upsert_key || `note-${exactMatch.id}`;
      console.error(`  Matches feedback note "${key}". Skipping.\n`);
      stats.alreadyInLedger++;
      continue;
    }

    // Semantic check
    const similar = await searchNotes(config.supabase, config.openai, sectionContent, 0.5, 1);

    if (similar.length > 0 && similar[0].similarity > 0.8) {
      const match = similar[0];
      const key = match.metadata.upsert_key || `note-${match.id}`;
      console.error(`  Similar to "${key}" (${(match.similarity * 100).toFixed(0)}% match)`);

      // Check for lines that are in local but not in Ledger
      const localSet = new Set(sectionContent.split('\n').map(l => l.trim()).filter(Boolean));
      const ledgerSet = new Set(match.content.split('\n').map(l => l.trim()).filter(Boolean));
      const onlyLocal = [...localSet].filter(l => !ledgerSet.has(l));

      if (onlyLocal.length > 0) {
        console.error(`  Local has ${onlyLocal.length} lines not in Ledger:`);
        for (const line of onlyLocal.slice(0, 5)) {
          console.error(`    + ${line}`);
        }
        const action = await choose('  Action:', [
          'Combine (add missing lines to Ledger)',
          'Keep Ledger version',
          'Skip',
        ]);

        if (action === 'Combine (add missing lines to Ledger)') {
          const combined = combineContent(match.content, sectionContent);
          await updateNote(config, match.id, combined, match.metadata);
          console.error(`  Combined into "${key}".\n`);
          stats.combined++;
        } else {
          console.error('  Kept Ledger version.\n');
          stats.alreadyInLedger++;
        }
      } else {
        console.error('  Ledger version is a superset. Skipping.\n');
        stats.alreadyInLedger++;
      }
      continue;
    }

    // New section not in Ledger
    console.error('  Not found in Ledger.');
    const shouldUpload = await confirm('  Upload as new feedback note?');

    if (shouldUpload) {
      const upsertKey = `feedback-${section.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}`;
      await uploadFeedbackNote(config, upsertKey, sectionContent);
      console.error(`  Uploaded as "${upsertKey}".\n`);
      stats.uploaded++;
    } else {
      console.error('  Skipped.\n');
      stats.skipped++;
    }
  }
}

export interface Section {
  heading: string;
  content: string;
}

export function extractSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const lines = markdown.split('\n');
  let currentHeading = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      if (currentHeading && currentContent.length > 0) {
        sections.push({ heading: currentHeading, content: currentContent.join('\n') });
      }
      currentHeading = headingMatch[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentHeading && currentContent.length > 0) {
    sections.push({ heading: currentHeading, content: currentContent.join('\n') });
  }

  return sections;
}

async function uploadNewNote(
  config: LedgerConfig,
  filename: string,
  content: string,
  hash: string,
): Promise<void> {
  // Infer type from filename
  let noteType = 'general';
  if (filename.startsWith('feedback_') || filename.startsWith('feedback-')) noteType = 'feedback';
  else if (filename.startsWith('user_') || filename.startsWith('user-')) noteType = 'user-preference';
  else if (filename.startsWith('project_') || filename.startsWith('project-')) noteType = 'project-status';
  else if (filename.startsWith('reference_') || filename.startsWith('reference-')) noteType = 'reference';

  const embeddingResponse = await config.openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: content,
  });
  const embedding = embeddingResponse.data[0].embedding;

  const upsertKey = filename.replace(/\.md$/, '').replace(/_/g, '-');

  // Check if upsert_key already exists to avoid duplicates on re-run
  const { data: existing } = await config.supabase
    .from('notes')
    .select('id')
    .eq('metadata->>upsert_key', upsertKey)
    .limit(1)
    .single();

  const delivery = inferDelivery(noteType);

  if (existing) {
    await updateNote(config, existing.id, content, {
      type: noteType,
      agent: 'ledger-migrate',
      upsert_key: upsertKey,
      local_file: filename,
      content_hash: hash,
      delivery,
    });
    console.error(`  Updated existing note ${existing.id} (type: ${noteType}, delivery: ${delivery})`);
    return;
  }

  const { data, error } = await config.supabase
    .from('notes')
    .insert({
      content,
      metadata: {
        type: noteType,
        agent: 'ledger-migrate',
        upsert_key: upsertKey,
        local_file: filename,
        content_hash: hash,
        delivery,
      },
      embedding,
    })
    .select('id')
    .single();

  if (error) {
    console.error(`  Error uploading: ${error.message}`);
    return;
  }

  console.error(`  Uploaded (note ${data.id}, type: ${noteType}, delivery: ${delivery})`);
}

async function uploadFeedbackNote(
  config: LedgerConfig,
  upsertKey: string,
  content: string,
): Promise<void> {
  const embeddingResponse = await config.openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: content,
  });
  const embedding = embeddingResponse.data[0].embedding;

  const localFile = upsertKey.replace(/-/g, '_') + '.md';
  const hash = contentHash(content);

  const { data, error } = await config.supabase
    .from('notes')
    .insert({
      content,
      metadata: {
        type: 'feedback',
        agent: 'ledger-migrate',
        upsert_key: upsertKey,
        local_file: localFile,
        content_hash: hash,
        delivery: inferDelivery('feedback'),
      },
      embedding,
    })
    .select('id')
    .single();

  if (error) {
    console.error(`  Error uploading: ${error.message}`);
    return;
  }

  console.error(`  Saved (note ${data.id})`);
}

async function updateNote(
  config: LedgerConfig,
  noteId: number,
  content: string,
  existingMetadata: NoteMetadata,
): Promise<void> {
  const embeddingResponse = await config.openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: content,
  });
  const embedding = embeddingResponse.data[0].embedding;
  const hash = contentHash(content);

  const metadata = { ...existingMetadata, content_hash: hash };

  const { error } = await config.supabase
    .from('notes')
    .update({ content, embedding, metadata, updated_at: new Date().toISOString() })
    .eq('id', noteId);

  if (error) {
    console.error(`  Error updating: ${error.message}`);
  }
}

async function fetchAllNotes(config: LedgerConfig): Promise<NoteRow[]> {
  const { data, error } = await config.supabase
    .from('notes')
    .select('id, content, metadata, created_at, updated_at');

  if (error) {
    console.error(`Error fetching notes: ${error.message}`);
    return [];
  }

  return (data || []) as NoteRow[];
}
