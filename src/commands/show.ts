import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { execFileSync } from 'child_process';
import type { LedgerConfig } from '../lib/config.js';
import { searchHybrid } from '../lib/search/ai-search.js';
import { fatal, ExitCode } from '../lib/errors.js';

const VIEW_DIR = '/tmp/ledger-view';

interface ShowOptions {
  type?: string;
  project?: string;
}

export async function show(config: LedgerConfig, query: string, options: ShowOptions = {}): Promise<void> {
  const results = await searchHybrid(
    { supabase: config.supabase, openai: config.openai },
    {
      query,
      limit: (options.type || options.project) ? 10 : 1,
      document_type: options.type,
      project: options.project,
    },
  );

  if (results.length === 0) {
    fatal('No matching documents found.', ExitCode.NOTE_NOT_FOUND);
  }

  const document = results[0];
  const filename = `${document.name}.md`;

  mkdirSync(VIEW_DIR, { recursive: true });
  const filePath = resolve(VIEW_DIR, filename);
  writeFileSync(filePath, document.content + '\n', 'utf-8');

  const score = document.score?.toFixed(3) ?? document.similarity?.toFixed(3) ?? 'n/a';
  console.log(`Match: "${document.name}" (score: ${score})`);
  console.log(filePath);

  try {
    execFileSync('code', [filePath], { stdio: 'ignore' });
  } catch {
    // VS Code not available — path already printed
  }
}
