import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { LedgerConfig } from '../lib/config.js';
import { searchHybrid } from '../lib/search/ai-search.js';
import { fatal, ExitCode } from '../lib/errors.js';

export async function exportDocument(
  config: LedgerConfig,
  query: string,
  outputPath?: string,
): Promise<void> {
  const results = await searchHybrid(
    { supabase: config.supabase, openai: config.openai },
    { query },
  );

  if (results.length === 0) {
    fatal('No matching documents found.', ExitCode.DOCUMENT_NOT_FOUND);
  }

  const document = results[0];
  const filename = `${document.name}.md`;

  const targetPath = outputPath
    ? resolve(outputPath, filename)
    : resolve(process.cwd(), filename);

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, document.content + '\n', 'utf-8');

  console.log(`Exported "${document.name}" → ${targetPath}`);
  console.log(targetPath);
}
