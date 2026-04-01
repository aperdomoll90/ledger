import { writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';

export interface FileWriteResult {
  status: 'written' | 'skipped' | 'error';
  path: string;
  message?: string;
}

/**
 * Write a note's content to disk at the specified file_path.
 * Creates parent directories if needed. Sets Unix permissions.
 * Skips write if content matches existing file (idempotent).
 */
export function writeNoteFile(
  content: string,
  filePath: string,
  permissions: string | null,
): FileWriteResult {
  const parentDirectory = dirname(filePath);
  const mode = permissions ? parseInt(permissions, 8) : 0o644;

  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, { recursive: true });
  }

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    if (existing === content) {
      return { status: 'skipped', path: filePath };
    }
  }

  writeFileSync(filePath, content, { mode });
  chmodSync(filePath, mode);

  return { status: 'written', path: filePath };
}
