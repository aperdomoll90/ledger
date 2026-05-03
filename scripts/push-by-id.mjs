// Push a local file to its Ledger document, identified by `ledger_id` in frontmatter.
// Bypasses CLI ARG_MAX limits by going through the TypeScript updateDocument() pipeline.
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { updateDocument } from '../dist/lib/documents/operations.js';

const filePath = process.argv[2];
if (!filePath) { console.error('Usage: node push-by-id.mjs <file>'); process.exit(1); }

const raw = readFileSync(filePath, 'utf8');
const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
if (!fmMatch) { console.error('No frontmatter found'); process.exit(1); }
const idMatch = fmMatch[1].match(/^ledger_id:\s*(\d+)/m);
if (!idMatch) { console.error('No ledger_id in frontmatter'); process.exit(1); }
const docId = parseInt(idMatch[1], 10);
const body = raw.slice(fmMatch[0].length);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const clients  = { supabase, openai, cohereApiKey: undefined };

console.log(`Pushing #${docId} from ${filePath} (${body.length} chars)...`);
try {
  await updateDocument(clients, { id: docId, content: body, agent: 'sync-local-docs' });
  console.log(`#${docId} updated successfully.`);
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
