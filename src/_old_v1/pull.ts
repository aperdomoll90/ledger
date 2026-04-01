import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { LedgerConfig } from '../lib/config.js';
import { fetchPersonaNotes, updateNoteHash, getClaudeMdContent, getMemoryMdContent } from '../lib/notes.js';
import { contentHash } from '../lib/hash.js';

interface PullOptions {
  quiet: boolean;
  force: boolean;
}

export async function pull(config: LedgerConfig, options: PullOptions): Promise<void> {
  const { quiet, force } = options;
  const notes = await fetchPersonaNotes(config.supabase);

  if (notes.length === 0) {
    if (!quiet) console.error('No cached notes found in Ledger.');
    return;
  }

  mkdirSync(config.memoryDir, { recursive: true });

  const writtenFiles: string[] = [];
  const conflicts: string[] = [];

  for (const note of notes) {
    const noteFilePath = note.metadata.file_path as string | undefined;
    if (!noteFilePath) continue;

    const localFile = noteFilePath.includes('/') ? noteFilePath.split('/').pop()! : noteFilePath;
    const filePath = resolve(config.memoryDir, localFile);
    const ledgerContent = note.content;
    const ledgerHash = contentHash(ledgerContent);
    const storedHash = note.metadata.content_hash as string | undefined;

    if (!force && existsSync(filePath)) {
      const localRaw = readFileSync(filePath, 'utf-8').trim();
      const localHash = contentHash(localRaw);

      // If local content differs from what we last wrote (stored hash), it's been modified
      if (storedHash && localHash !== storedHash) {
        // If Ledger also changed, it's a conflict
        if (ledgerHash !== storedHash) {
          conflicts.push(localFile);
          console.log(`CONFLICT:${localFile}`);
          continue;
        }
        // Only local changed — don't overwrite
        conflicts.push(localFile);
        console.log(`CONFLICT:${localFile}`);
        continue;
      }
    }

    writeFileSync(filePath, `${ledgerContent}\n`, 'utf-8');
    writtenFiles.push(localFile);

    // Store the hash of what we wrote so check can detect local modifications
    if (!storedHash || storedHash !== ledgerHash) {
      await updateNoteHash(config.supabase, note.id, ledgerHash);
    }

    if (!quiet) console.error(`  wrote ${localFile}`);
  }

  writeGeneratedFiles(config, notes, writtenFiles, conflicts, force, quiet);

  if (!quiet) {
    console.error(`\nPull complete: ${writtenFiles.length} written, ${conflicts.length} conflicts`);
  }
}

function writeGeneratedFiles(
  config: LedgerConfig,
  notes: Awaited<ReturnType<typeof fetchPersonaNotes>>,
  writtenFiles: string[],
  conflicts: string[],
  force: boolean,
  quiet: boolean,
): void {
  const memoryMd = getMemoryMdContent(notes);
  if (memoryMd) {
    const memoryPath = resolve(config.memoryDir, 'MEMORY.md');
    writeFileSync(memoryPath, memoryMd, 'utf-8');
    if (!quiet) console.error('  wrote MEMORY.md (from memory-md note)');
  }

  const claudeMd = getClaudeMdContent(notes);
  if (claudeMd) {
    writeFileSync(config.claudeMdPath, claudeMd, 'utf-8');
    if (!quiet) console.error('  wrote ~/CLAUDE.md (from claude-md note)');
  }
}
