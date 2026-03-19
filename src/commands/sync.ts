import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { resolve } from 'path';
import type { LedgerConfig } from '../lib/config.js';
import { fetchPersonaNotes, updateNoteContent, updateNoteHash, type NoteRow } from '../lib/notes.js';
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
