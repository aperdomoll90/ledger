import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { loadConfigFile, saveConfigFile, type LedgerConfig } from '../lib/config.js';
import { fetchPersonaNotes, updateNoteContent, updateNoteHash, opAddNote, type NoteRow, type Clients, type DeliveryTier } from '../lib/notes.js';
import { contentHash } from '../lib/hash.js';
import { generateClaudeMd, generateMemoryMd } from '../lib/generators.js';
import { confirm } from '../lib/prompt.js';

interface SyncOptions {
  quiet: boolean;
  force: boolean;
  dryRun: boolean;
}

interface SyncResult {
  downloaded: string[];
  uploaded: string[];
  conflicts: string[];
  orphansRemoved: string[];
  skipped: string[];
}

export async function sync(config: LedgerConfig, options: SyncOptions): Promise<SyncResult> {
  const { quiet, force, dryRun } = options;
  const notes = await fetchPersonaNotes(config.supabase);

  const result: SyncResult = {
    downloaded: [],
    uploaded: [],
    conflicts: [],
    orphansRemoved: [],
    skipped: [],
  };

  if (notes.length === 0) {
    if (!quiet) console.error('No persona notes found in Ledger.');
    return result;
  }

  mkdirSync(config.memoryDir, { recursive: true });

  // --- Phase 0: Sync type registry ---
  await syncTypeRegistryPull(config, quiet, force, dryRun);

  const notesByFile = new Map<string, NoteRow>();
  for (const note of notes) {
    const localFile = note.metadata.local_file as string | undefined;
    if (localFile) notesByFile.set(localFile, note);
  }

  // --- Phase 1: Process each persona note ---
  for (const note of notes) {
    const localFile = note.metadata.local_file as string | undefined;
    if (!localFile) continue;

    const filePath = resolve(config.memoryDir, localFile);
    const ledgerContent = note.content;
    const ledgerHash = contentHash(ledgerContent);
    const storedHash = note.metadata.content_hash as string | undefined;

    if (!existsSync(filePath)) {
      // File missing locally → download from Ledger
      if (dryRun) {
        if (!quiet) console.error(`  ${localFile} — would download (missing locally)`);
        result.downloaded.push(localFile);
        continue;
      }
      writeFileSync(filePath, `${ledgerContent}\n`, 'utf-8');
      if (!storedHash || storedHash !== ledgerHash) {
        await updateNoteHash(config.supabase, note.id, ledgerHash);
      }
      result.downloaded.push(localFile);
      if (!quiet) console.error(`  ${localFile} — downloaded`);
      continue;
    }

    // File exists locally — compare
    const localRaw = readFileSync(filePath, 'utf-8').trim();
    const localHash = contentHash(localRaw);

    const localChanged = storedHash ? localHash !== storedHash : localHash !== ledgerHash;
    const ledgerChanged = storedHash ? ledgerHash !== storedHash : false;

    if (!localChanged && !ledgerChanged) {
      // In sync — skip
      result.skipped.push(localFile);
      continue;
    }

    if (localChanged && !ledgerChanged) {
      // Local modified, Ledger unchanged → push local to Ledger
      if (dryRun) {
        if (!quiet) console.error(`  ${localFile} — would upload (modified locally)`);
        result.uploaded.push(localFile);
        continue;
      }

      if (force) {
        // --force means overwrite local with Ledger
        writeFileSync(filePath, `${ledgerContent}\n`, 'utf-8');
        result.downloaded.push(localFile);
        if (!quiet) console.error(`  ${localFile} — overwritten with Ledger version (--force)`);
        continue;
      }

      if (quiet) {
        // In quiet mode (SessionStart hook), don't prompt — just flag it
        console.log(`MODIFIED:${localFile}`);
        result.conflicts.push(localFile);
        continue;
      }

      // Interactive: ask user
      console.error(`\n  ${localFile} — modified locally`);
      const shouldPush = await confirm('  Upload local changes to Ledger?');
      if (shouldPush) {
        await updateNoteContent(config.supabase, config.openai, note.id, localRaw);
        await updateNoteHash(config.supabase, note.id, localHash);
        result.uploaded.push(localFile);
        console.error(`  ${localFile} — uploaded to Ledger`);
      } else {
        // Discard local, restore from Ledger
        writeFileSync(filePath, `${ledgerContent}\n`, 'utf-8');
        result.downloaded.push(localFile);
        console.error(`  ${localFile} — restored from Ledger`);
      }
      continue;
    }

    if (!localChanged && ledgerChanged) {
      // Ledger updated, local unchanged → download
      if (dryRun) {
        if (!quiet) console.error(`  ${localFile} — would download (updated in Ledger)`);
        result.downloaded.push(localFile);
        continue;
      }
      writeFileSync(filePath, `${ledgerContent}\n`, 'utf-8');
      await updateNoteHash(config.supabase, note.id, ledgerHash);
      result.downloaded.push(localFile);
      if (!quiet) console.error(`  ${localFile} — updated from Ledger`);
      continue;
    }

    // Both changed — conflict
    if (dryRun) {
      if (!quiet) console.error(`  ${localFile} — CONFLICT (both changed)`);
      result.conflicts.push(localFile);
      continue;
    }

    if (force) {
      writeFileSync(filePath, `${ledgerContent}\n`, 'utf-8');
      result.downloaded.push(localFile);
      if (!quiet) console.error(`  ${localFile} — overwritten with Ledger version (--force)`);
      continue;
    }

    if (quiet) {
      console.log(`CONFLICT:${localFile}`);
      result.conflicts.push(localFile);
      continue;
    }

    // Interactive: show conflict
    console.error(`\n  ${localFile} — CONFLICT (both changed)`);
    const keepLedger = await confirm('  Keep Ledger version? (no = keep local and upload)');
    if (keepLedger) {
      writeFileSync(filePath, `${ledgerContent}\n`, 'utf-8');
      await updateNoteHash(config.supabase, note.id, ledgerHash);
      result.downloaded.push(localFile);
      console.error(`  ${localFile} — restored from Ledger`);
    } else {
      await updateNoteContent(config.supabase, config.openai, note.id, localRaw);
      await updateNoteHash(config.supabase, note.id, localHash);
      result.uploaded.push(localFile);
      console.error(`  ${localFile} — uploaded to Ledger`);
    }
  }

  // --- Phase 2: Detect orphaned local files (in memory/ but not in Ledger) ---
  const localFiles = readdirSync(config.memoryDir)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md');

  for (const file of localFiles) {
    if (!notesByFile.has(file)) {
      if (dryRun) {
        if (!quiet) console.error(`  ${file} — orphaned (not in Ledger, would remove)`);
        result.orphansRemoved.push(file);
        continue;
      }
      // Orphaned cache file — Ledger note was deleted, remove local
      const filePath = resolve(config.memoryDir, file);
      unlinkSync(filePath);
      result.orphansRemoved.push(file);
      if (!quiet) console.error(`  ${file} — removed (no longer in Ledger)`);
    }
  }

  // --- Phase 3: Regenerate MEMORY.md and CLAUDE.md ---
  if (!dryRun) {
    const allLocalFiles = [...result.downloaded, ...result.uploaded, ...result.skipped, ...result.conflicts];
    const memoryPath = resolve(config.memoryDir, 'MEMORY.md');
    writeFileSync(memoryPath, generateMemoryMd(allLocalFiles), 'utf-8');

    const feedbackNotes = notes.filter(n => (n.metadata.type as string) === 'feedback');
    const newClaudeMd = generateClaudeMd(feedbackNotes);

    if (existsSync(config.claudeMdPath)) {
      const existing = readFileSync(config.claudeMdPath, 'utf-8');
      if (existing.startsWith('# Global Rules') || force) {
        writeFileSync(config.claudeMdPath, newClaudeMd, 'utf-8');
        if (!quiet) console.error('  wrote ~/CLAUDE.md');
      }
    } else {
      writeFileSync(config.claudeMdPath, newClaudeMd, 'utf-8');
      if (!quiet) console.error('  wrote ~/CLAUDE.md');
    }
  }

  // --- Phase 3.5: Push type registry ---
  await syncTypeRegistryPush(config, quiet, dryRun);

  // --- Summary ---
  if (!quiet) {
    const parts = [
      result.downloaded.length > 0 ? `${result.downloaded.length} downloaded` : null,
      result.uploaded.length > 0 ? `${result.uploaded.length} uploaded` : null,
      result.conflicts.length > 0 ? `${result.conflicts.length} conflicts` : null,
      result.orphansRemoved.length > 0 ? `${result.orphansRemoved.length} orphans removed` : null,
      result.skipped.length > 0 ? `${result.skipped.length} in sync` : null,
    ].filter(Boolean).join(', ');

    console.error(`\nSync complete: ${parts || 'nothing to do'}`);
  }

  return result;
}

export async function syncTypeRegistryPush(config: LedgerConfig, quiet: boolean, dryRun: boolean): Promise<void> {
  const configFile = loadConfigFile();
  const userTypes = configFile.types;

  if (!userTypes || Object.keys(userTypes).length === 0) {
    return; // Nothing to push
  }

  const content = JSON.stringify(userTypes, null, 2);
  const clients: Clients = { supabase: config.supabase, openai: config.openai };

  if (dryRun) {
    if (!quiet) console.error('  type-registry — would push to Ledger');
    return;
  }

  await opAddNote(clients, content, 'system-rule', 'ledger-sync', {
    upsert_key: 'system-rule-type-registry',
    description: 'User-defined type registry overrides. Managed by ledger sync.',
    delivery: 'persona',
    scope: 'system',
    interactive_skip: true,
  }, true); // force: true to skip duplicate guard

  if (!quiet) console.error('  type-registry — pushed to Ledger');
}

export async function syncTypeRegistryPull(config: LedgerConfig, quiet: boolean, force: boolean, dryRun: boolean): Promise<void> {
  const { data: note } = await config.supabase
    .from('notes')
    .select('content')
    .eq('metadata->>upsert_key', 'system-rule-type-registry')
    .limit(1)
    .single();

  if (!note) return; // No remote type registry

  let remoteTypes: Record<string, DeliveryTier>;
  try {
    remoteTypes = JSON.parse(note.content);
  } catch {
    if (!quiet) console.error('  type-registry — invalid JSON in remote note, skipping');
    return;
  }

  const configFile = loadConfigFile();
  const localTypes = configFile.types ?? {};

  // Merge: local wins unless --force
  const merged = force
    ? { ...localTypes, ...remoteTypes }
    : { ...remoteTypes, ...localTypes };

  // Check if anything changed
  const localJson = JSON.stringify(localTypes, Object.keys(localTypes).sort());
  const mergedJson = JSON.stringify(merged, Object.keys(merged).sort());

  if (localJson === mergedJson) return; // No changes

  if (dryRun) {
    const newKeys = Object.keys(merged).filter(k => !(k in localTypes));
    if (newKeys.length > 0 && !quiet) {
      console.error(`  type-registry — would add: ${newKeys.map(k => `${k} (${merged[k]})`).join(', ')}`);
    }
    return;
  }

  configFile.types = merged;
  saveConfigFile(configFile);

  const newKeys = Object.keys(merged).filter(k => !(k in localTypes));
  if (newKeys.length > 0 && !quiet) {
    console.error(`  type-registry synced: added ${newKeys.map(k => `${k} (${merged[k]})`).join(', ')}`);
  }
}
