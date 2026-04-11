// benchmark-ingestion.ts
// Measures ingestion pipeline performance with different optimization modes.
// Does NOT write to the database. Only runs chunking, enrichment, and embedding.
//
// Usage:
//   npx tsx src/scripts/benchmark-ingestion.ts                     # run all modes
//   npx tsx src/scripts/benchmark-ingestion.ts --mode baseline     # run one mode
//   npx tsx src/scripts/benchmark-ingestion.ts --file docs/foo.md  # custom test file
//
// Modes:
//   baseline    — current code: sequential enrichment, sequential embeddings
//   batch-embed — sequential enrichment, batch embeddings (one API call)
//   parallel-cr — parallel Contextual Retrieval (3 concurrent, TPM-safe), sequential embeddings
//   truncated   — truncated context (summary + neighbors), sequential embeddings
//   all         — truncated + parallel + batch embeddings combined
//
// Results are appended to docs/benchmark-results.json

import 'dotenv/config';
import OpenAI from 'openai';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { chunkText } from '../lib/search/embeddings.js';
import { openaiLimiter, createRateLimiter, updateLimitsFromHeaders } from '../lib/rate-limiter.js';
import type { IChunkProps } from '../lib/search/embeddings.js';

// =============================================================================
// Config
// =============================================================================

// TPM-safe limiter for parallel chat with full document context (~18K tokens/call).
// gpt-4o-mini: 200K TPM. 200K / 18K = ~11 calls/min max.
const chatLimiter = createRateLimiter({
  maxConcurrent: 3,
  reservoirAmount: 10,
  reservoirRefreshInterval: 60_000,
  minTime: 2000,
  retryLimit: 3,
});

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CONTEXT_MODEL = 'gpt-4o-mini';
const RESULTS_FILE = 'docs/benchmark-results.json';
const DEFAULT_TEST_FILE = 'docs/ledger-architecture-database-schemas.md';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, maxRetries: 5 });

// =============================================================================
// Types
// =============================================================================

type BenchmarkMode = 'baseline' | 'batch-embed' | 'parallel-cr' | 'truncated' | 'all';

interface IBenchmarkResultProps {
  mode:              BenchmarkMode;
  file:              string;
  fileSize:          number;
  chunkCount:        number;
  timestamp:         string;
  timings: {
    chunking:        number;
    enrichment:      number;
    embedding:       number;
    total:           number;
  };
  tokenEstimate: {
    enrichmentInput: number;
    embeddingInput:  number;
  };
}

// =============================================================================
// Prompts
// =============================================================================

const CONTEXT_PROMPT = `Here is the full document:
<document>
{DOCUMENT_CONTENT}
</document>

Here is the chunk:
<chunk>
{CHUNK_CONTENT}
</chunk>

Write a short context (2-3 sentences) that situates this chunk within the document. Include the document's topic and what specific information this chunk covers. Be concise and factual.`;

const TRUNCATED_CONTEXT_PROMPT = `Here is a summary of the document:
<document_summary>
{DOCUMENT_SUMMARY}
</document_summary>

Here is the section this chunk belongs to (header path):
<section>
{HEADER_PATH}
</section>

Here are the neighboring chunks for context:
<previous_chunk>
{PREV_CHUNK}
</previous_chunk>

<chunk>
{CHUNK_CONTENT}
</chunk>

<next_chunk>
{NEXT_CHUNK}
</next_chunk>

Write a short context (2-3 sentences) that situates this chunk within the document. Include the document's topic and what specific information this chunk covers. Be concise and factual.`;

const SUMMARY_PROMPT = `Summarize this document in 150-200 words. Focus on: what the document is about, its structure, and the key topics it covers. Be factual and concise.

<document>
{DOCUMENT_CONTENT}
</document>`;

// =============================================================================
// Helpers
// =============================================================================

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function findHeaderPath(content: string, chunkContent: string): string {
  const lines = content.split('\n');
  const headers: string[] = [];
  let foundChunk = false;

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^(#+)/)?.[1].length ?? 1;
      while (headers.length >= level) headers.pop();
      headers.push(line.replace(/^#+\s*/, '').trim());
    }
    if (line.includes(chunkContent.slice(0, 50))) {
      foundChunk = true;
      break;
    }
  }

  return foundChunk ? headers.join(' > ') : '';
}

async function generateDocSummary(documentContent: string): Promise<{ summary: string; inputTokens: number }> {
  const prompt = SUMMARY_PROMPT.replace('{DOCUMENT_CONTENT}', documentContent);
  const inputTokens = estimateTokens(prompt);

  const response = await openaiLimiter.schedule(() =>
    openai.chat.completions.create({
      model: CONTEXT_MODEL,
      messages: [
        { role: 'system', content: 'You are a precise technical writer. Output only the summary, nothing else.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
      temperature: 0,
    }),
  );

  return {
    summary: (response.choices[0].message.content ?? '').trim(),
    inputTokens,
  };
}

// =============================================================================
// Enrichment strategies
// =============================================================================

async function enrichBaseline(
  chunks: IChunkProps[],
  documentContent: string,
): Promise<{ summaries: string[]; timeMs: number; inputTokens: number }> {
  const start = Date.now();
  const summaries: string[] = [];
  let inputTokens = 0;

  for (const chunk of chunks) {
    const prompt = CONTEXT_PROMPT
      .replace('{DOCUMENT_CONTENT}', documentContent)
      .replace('{CHUNK_CONTENT}', chunk.content);
    inputTokens += estimateTokens(prompt);

    const response = await openaiLimiter.schedule(() =>
      openai.chat.completions.create({
        model: CONTEXT_MODEL,
        messages: [
          { role: 'system', content: 'You are a precise technical writer. Output only the context summary, nothing else.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 150,
        temperature: 0,
      }),
    );
    summaries.push((response.choices[0].message.content ?? '').trim());
  }

  return { summaries, timeMs: Date.now() - start, inputTokens };
}

async function enrichParallel(
  chunks: IChunkProps[],
  documentContent: string,
): Promise<{ summaries: string[]; timeMs: number; inputTokens: number }> {
  const start = Date.now();
  let inputTokens = 0;

  const promises = chunks.map((chunk, index) => {
    const prompt = CONTEXT_PROMPT
      .replace('{DOCUMENT_CONTENT}', documentContent)
      .replace('{CHUNK_CONTENT}', chunk.content);
    inputTokens += estimateTokens(prompt);

    return chatLimiter.schedule({ id: `enrich-${index}` }, async () => {
      const response = await openai.chat.completions.create({
        model: CONTEXT_MODEL,
        messages: [
          { role: 'system', content: 'You are a precise technical writer. Output only the context summary, nothing else.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 150,
        temperature: 0,
      });
      return { index, summary: (response.choices[0].message.content ?? '').trim() };
    });
  });

  const results = await Promise.all(promises);
  results.sort((first, second) => first.index - second.index);

  return { summaries: results.map(result => result.summary), timeMs: Date.now() - start, inputTokens };
}

async function enrichTruncated(
  chunks: IChunkProps[],
  documentContent: string,
): Promise<{ summaries: string[]; timeMs: number; inputTokens: number }> {
  const start = Date.now();
  const summaries: string[] = [];
  let inputTokens = 0;

  const { summary: docSummary, inputTokens: summaryTokens } = await generateDocSummary(documentContent);
  inputTokens += summaryTokens;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const prevChunk = chunkIndex > 0 ? chunks[chunkIndex - 1].content : '(start of document)';
    const nextChunk = chunkIndex < chunks.length - 1 ? chunks[chunkIndex + 1].content : '(end of document)';
    const headerPath = findHeaderPath(documentContent, chunks[chunkIndex].content);

    const prompt = TRUNCATED_CONTEXT_PROMPT
      .replace('{DOCUMENT_SUMMARY}', docSummary)
      .replace('{HEADER_PATH}', headerPath || '(unknown section)')
      .replace('{PREV_CHUNK}', prevChunk)
      .replace('{CHUNK_CONTENT}', chunks[chunkIndex].content)
      .replace('{NEXT_CHUNK}', nextChunk);
    inputTokens += estimateTokens(prompt);

    const response = await openaiLimiter.schedule(() =>
      openai.chat.completions.create({
        model: CONTEXT_MODEL,
        messages: [
          { role: 'system', content: 'You are a precise technical writer. Output only the context summary, nothing else.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 150,
        temperature: 0,
      }),
    );
    summaries.push((response.choices[0].message.content ?? '').trim());
  }

  return { summaries, timeMs: Date.now() - start, inputTokens };
}

async function enrichTruncatedParallel(
  chunks: IChunkProps[],
  documentContent: string,
): Promise<{ summaries: string[]; timeMs: number; inputTokens: number }> {
  const start = Date.now();
  let inputTokens = 0;

  const { summary: docSummary, inputTokens: summaryTokens } = await generateDocSummary(documentContent);
  inputTokens += summaryTokens;

  // Truncated context = ~1K tokens per call. TPM-safe for full concurrency.
  const promises = chunks.map((chunk, chunkIndex) => {
    const prevChunk = chunkIndex > 0 ? chunks[chunkIndex - 1].content : '(start of document)';
    const nextChunk = chunkIndex < chunks.length - 1 ? chunks[chunkIndex + 1].content : '(end of document)';
    const headerPath = findHeaderPath(documentContent, chunk.content);

    const prompt = TRUNCATED_CONTEXT_PROMPT
      .replace('{DOCUMENT_SUMMARY}', docSummary)
      .replace('{HEADER_PATH}', headerPath || '(unknown section)')
      .replace('{PREV_CHUNK}', prevChunk)
      .replace('{CHUNK_CONTENT}', chunk.content)
      .replace('{NEXT_CHUNK}', nextChunk);
    inputTokens += estimateTokens(prompt);

    return openaiLimiter.schedule({ id: `tp-${chunkIndex}` }, async () => {
      const response = await openai.chat.completions.create({
        model: CONTEXT_MODEL,
        messages: [
          { role: 'system', content: 'You are a precise technical writer. Output only the context summary, nothing else.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 150,
        temperature: 0,
      });
      return { index: chunkIndex, summary: (response.choices[0].message.content ?? '').trim() };
    });
  });

  const results = await Promise.all(promises);
  results.sort((first, second) => first.index - second.index);

  return { summaries: results.map(result => result.summary), timeMs: Date.now() - start, inputTokens };
}

// =============================================================================
// Embedding strategies
// =============================================================================

async function embedSequential(
  texts: string[],
): Promise<{ embeddings: number[][]; timeMs: number; inputTokens: number }> {
  const start = Date.now();
  const embeddings: number[][] = [];
  let inputTokens = 0;

  for (const text of texts) {
    inputTokens += estimateTokens(text);
    const result = await openaiLimiter.schedule(async () => {
      const { data, response } = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
      }).withResponse();
      await updateLimitsFromHeaders(openaiLimiter, response.headers);
      return data.data[0].embedding;
    });
    embeddings.push(result);
  }

  return { embeddings, timeMs: Date.now() - start, inputTokens };
}

async function embedBatch(
  texts: string[],
): Promise<{ embeddings: number[][]; timeMs: number; inputTokens: number }> {
  const start = Date.now();
  const inputTokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
  const BATCH_SIZE = 100;
  const allEmbeddings: number[][] = [];

  for (let batchStart = 0; batchStart < texts.length; batchStart += BATCH_SIZE) {
    const batch = texts.slice(batchStart, batchStart + BATCH_SIZE);
    const result = await openaiLimiter.schedule(async () => {
      const { data, response } = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch,
      }).withResponse();
      await updateLimitsFromHeaders(openaiLimiter, response.headers);
      return data.data.map(entry => entry.embedding);
    });
    allEmbeddings.push(...result);
  }

  return { embeddings: allEmbeddings, timeMs: Date.now() - start, inputTokens };
}

// =============================================================================
// Benchmark runner
// =============================================================================

async function runBenchmark(
  mode: BenchmarkMode,
  content: string,
  filePath: string,
): Promise<IBenchmarkResultProps> {
  console.log(`\n--- ${mode.toUpperCase()} ---`);

  const chunkStart = Date.now();
  const chunks = chunkText(content);
  const chunkTime = Date.now() - chunkStart;
  console.log(`  Chunking: ${chunkTime}ms (${chunks.length} chunks)`);

  const useParallel = mode === 'parallel-cr' || mode === 'all';
  const useTruncated = mode === 'truncated' || mode === 'all';

  let enrichResult: { summaries: string[]; timeMs: number; inputTokens: number };

  if (useTruncated && useParallel) {
    enrichResult = await enrichTruncatedParallel(chunks, content);
  } else if (useTruncated) {
    enrichResult = await enrichTruncated(chunks, content);
  } else if (useParallel) {
    enrichResult = await enrichParallel(chunks, content);
  } else {
    enrichResult = await enrichBaseline(chunks, content);
  }

  console.log(`  Enrichment: ${enrichResult.timeMs}ms (~${enrichResult.inputTokens} input tokens)`);

  const embeddingInputs = chunks.map((chunk, index) =>
    enrichResult.summaries[index] + '\n\n' + chunk.content,
  );

  const useBatch = mode === 'batch-embed' || mode === 'all';
  const embedResult = useBatch
    ? await embedBatch(embeddingInputs)
    : await embedSequential(embeddingInputs);

  console.log(`  Embedding: ${embedResult.timeMs}ms (~${embedResult.inputTokens} input tokens)`);

  const total = chunkTime + enrichResult.timeMs + embedResult.timeMs;
  console.log(`  TOTAL: ${total}ms`);

  return {
    mode,
    file: filePath,
    fileSize: content.length,
    chunkCount: chunks.length,
    timestamp: new Date().toISOString(),
    timings: {
      chunking: chunkTime,
      enrichment: enrichResult.timeMs,
      embedding: embedResult.timeMs,
      total,
    },
    tokenEstimate: {
      enrichmentInput: enrichResult.inputTokens,
      embeddingInput: embedResult.inputTokens,
    },
  };
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const modeArg = process.argv.find((_, argIndex, argv) => argv[argIndex - 1] === '--mode') as BenchmarkMode | undefined;
  const fileArg = process.argv.find((_, argIndex, argv) => argv[argIndex - 1] === '--file');
  const filePath = fileArg ?? DEFAULT_TEST_FILE;

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, 'utf8');
  console.log(`File: ${filePath} (${content.length} chars)`);

  const modes: BenchmarkMode[] = modeArg
    ? [modeArg]
    : ['baseline', 'batch-embed', 'parallel-cr', 'truncated', 'all'];

  const results: IBenchmarkResultProps[] = [];

  for (const mode of modes) {
    const result = await runBenchmark(mode, content, filePath);
    results.push(result);
  }

  console.log('\n=== SUMMARY ===');
  console.log('');
  const baseline = results.find(benchmarkResult => benchmarkResult.mode === 'baseline');
  for (const benchmarkResult of results) {
    const speedup = baseline ? `${Math.round((1 - benchmarkResult.timings.total / baseline.timings.total) * 100)}%` : 'n/a';
    const tokenSavings = baseline
      ? `${Math.round((1 - benchmarkResult.tokenEstimate.enrichmentInput / baseline.tokenEstimate.enrichmentInput) * 100)}%`
      : 'n/a';
    console.log(`${benchmarkResult.mode.padEnd(15)} | ${String(benchmarkResult.timings.total).padStart(7)}ms | enrichment: ${String(benchmarkResult.timings.enrichment).padStart(7)}ms | embedding: ${String(benchmarkResult.timings.embedding).padStart(7)}ms | speedup: ${speedup.padStart(4)} | token savings: ${tokenSavings}`);
  }

  let existing: IBenchmarkResultProps[] = [];
  if (existsSync(RESULTS_FILE)) {
    try {
      existing = JSON.parse(readFileSync(RESULTS_FILE, 'utf8'));
    } catch {
      existing = [];
    }
  }
  existing.push(...results);
  writeFileSync(RESULTS_FILE, JSON.stringify(existing, null, 2) + '\n');
  console.log(`\nResults saved to ${RESULTS_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
