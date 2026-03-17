import type { NoteRow } from './notes.js';

// --- CLAUDE.md Section Mapping ---

const SECTION_MAP: Record<string, string[]> = {
  'Security': ['feedback-no-read-env'],
  'Coding Conventions': ['feedback-coding-conventions'],
  'Architecture': [
    'feedback-mcp-registration',
    'feedback-prefer-cli-and-skills',
    'feedback-repo-docs-structure',
    'feedback-project-logs',
  ],
  'Communication': ['feedback-communication-style'],
};

// --- Helpers ---

function extractBulletPoints(content: string): string {
  const lines = content.split('\n');
  const bullets: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('---') || trimmed.startsWith('#') || trimmed === '') continue;
    if (trimmed.startsWith('Why:') || trimmed.startsWith('**Why:**')) continue;
    if (trimmed.startsWith('How to apply:') || trimmed.startsWith('**How to apply:**')) continue;
    if (
      trimmed.startsWith('Follow these') ||
      trimmed.startsWith('Never') ||
      trimmed.startsWith('Always') ||
      trimmed.startsWith('When') ||
      trimmed.startsWith('Before')
    ) {
      bullets.push(`- ${trimmed}`);
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      bullets.push(trimmed);
    }
  }

  return bullets.join('\n');
}

// --- Generators ---

export function generateClaudeMd(notes: NoteRow[]): string {
  const notesByKey = new Map<string, NoteRow>();
  for (const note of notes) {
    const key = note.metadata.upsert_key as string;
    if (key) notesByKey.set(key, note);
  }

  const sections: string[] = ['# Global Rules'];
  const usedKeys = new Set<string>();

  for (const [sectionName, keys] of Object.entries(SECTION_MAP)) {
    const sectionBullets: string[] = [];

    for (const key of keys) {
      const note = notesByKey.get(key);
      if (note) {
        sectionBullets.push(extractBulletPoints(note.content));
        usedKeys.add(key);
      }
    }

    if (sectionBullets.length > 0) {
      sections.push(`\n## ${sectionName}\n${sectionBullets.join('\n')}`);
    }
  }

  const unmapped: string[] = [];
  for (const note of notes) {
    const key = note.metadata.upsert_key as string;
    const type = note.metadata.type as string;
    if (key && !usedKeys.has(key) && type === 'feedback') {
      unmapped.push(extractBulletPoints(note.content));
      usedKeys.add(key);
    }
  }

  if (unmapped.length > 0) {
    sections.push(`\n## General\n${unmapped.join('\n')}`);
  }

  return sections.join('\n') + '\n';
}

export function generateMemoryMd(files: string[]): string {
  const userFiles: string[] = [];
  const feedbackFiles: string[] = [];
  const projectFiles: string[] = [];

  for (const file of files) {
    if (file.startsWith('user_')) userFiles.push(file);
    else if (file.startsWith('feedback_')) feedbackFiles.push(file);
    else if (file.startsWith('project_')) projectFiles.push(file);
  }

  const lines = [
    '# Memory Index',
    '',
    'Local cache files auto-loaded into Claude Code context. Source of truth is Ledger.',
    '',
  ];

  if (userFiles.length > 0) {
    lines.push('## User Profile');
    for (const f of userFiles) lines.push(`- [${f}](${f})`);
    lines.push('');
  }

  if (feedbackFiles.length > 0) {
    lines.push('## Feedback (Behavioral Rules)');
    for (const f of feedbackFiles) lines.push(`- [${f}](${f})`);
    lines.push('');
  }

  if (projectFiles.length > 0) {
    lines.push('## Project Status');
    for (const f of projectFiles) lines.push(`- [${f}](${f})`);
    lines.push('');
  }

  lines.push('## Not Auto-Loaded (Search Ledger)');
  lines.push('Architecture, references, project details, events, errors — all in Ledger, search on demand.');
  lines.push('');

  return lines.join('\n');
}
