import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeNoteFile } from '../src/lib/file-writer.js';
import { existsSync, readFileSync, mkdirSync, rmSync, statSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = resolve(tmpdir(), 'ledger-file-writer-test');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('writeNoteFile', () => {
  it('writes content to the specified path', () => {
    const filePath = resolve(TEST_DIR, 'test-note.md');
    const result = writeNoteFile('Hello world', filePath, '644');
    expect(result.status).toBe('written');
    expect(readFileSync(filePath, 'utf-8')).toBe('Hello world');
  });

  it('creates parent directories if they do not exist', () => {
    const filePath = resolve(TEST_DIR, 'deep/nested/dir/note.md');
    const result = writeNoteFile('Nested content', filePath, '644');
    expect(result.status).toBe('written');
    expect(existsSync(filePath)).toBe(true);
  });

  it('sets file permissions', () => {
    const filePath = resolve(TEST_DIR, 'hook.sh');
    writeNoteFile('#!/bin/bash', filePath, '755');
    const stats = statSync(filePath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe('755');
  });

  it('defaults to 644 if no permissions specified', () => {
    const filePath = resolve(TEST_DIR, 'default.md');
    writeNoteFile('content', filePath, null);
    const stats = statSync(filePath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe('644');
  });

  it('returns skip status if content matches existing file', () => {
    const filePath = resolve(TEST_DIR, 'existing.md');
    writeNoteFile('same content', filePath, '644');
    const result = writeNoteFile('same content', filePath, '644');
    expect(result.status).toBe('skipped');
  });

  it('overwrites if content differs', () => {
    const filePath = resolve(TEST_DIR, 'changing.md');
    writeNoteFile('old content', filePath, '644');
    const result = writeNoteFile('new content', filePath, '644');
    expect(result.status).toBe('written');
    expect(readFileSync(filePath, 'utf-8')).toBe('new content');
  });
});
