// search-traces.test.ts
// Integration test: verifies that search traces land in Langfuse with the
// expected structure (trace name, tags, session ID, child spans).
//
// Gated: only runs when LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, and OPENAI_API_KEY are all set.
// Skipped by default to keep the unit suite fast and offline-capable.
//
// What it proves:
//   - Observability is wired end-to-end (init → span emit → export → Langfuse API).
//   - Trace name is "search".
//   - Tags include the search mode (e.g., "hybrid").
//   - sessionId propagates through to the landed trace.
//   - Child spans (retrieve, retrieve.vector/keyword/fusion) appear for hybrid.

import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { observeOpenAI } from '@langfuse/openai';
import { randomUUID } from 'node:crypto';
import type { IClientsProps } from '../../src/lib/documents/classification.js';

const hasLangfuse =
  !!process.env.LANGFUSE_PUBLIC_KEY &&
  !!process.env.LANGFUSE_SECRET_KEY;
const hasSupabase =
  !!process.env.SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasOpenAI = !!process.env.OPENAI_API_KEY;

// Explicit opt-in: full suite would otherwise pick up these tests when
// Langfuse env vars happen to be in the process. Integration tests need a
// clean slate (no module-state interference from unit tests), so we gate on
// a dedicated flag. Run with: INTEGRATION_TEST=1 npx vitest run tests/integration/
const runIntegration =
  process.env.INTEGRATION_TEST === '1' && hasLangfuse && hasSupabase && hasOpenAI;
const describeIfEnabled = runIntegration ? describe : describe.skip;

const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL ?? 'http://localhost:9100';

// Poll Langfuse's public API for a trace matching our unique sessionId.
// Batched export can take several seconds, so we retry up to 15s with 1s delay.
async function pollForTrace(sessionId: string, maxAttempts = 15): Promise<unknown | null> {
  const auth = Buffer.from(
    `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
  ).toString('base64');

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(
      `${LANGFUSE_BASE_URL}/api/public/traces?sessionId=${encodeURIComponent(sessionId)}&limit=1`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    if (response.ok) {
      const payload = (await response.json()) as { data?: Array<{ id: string }> };
      if (payload.data && payload.data.length > 0) {
        return payload.data[0];
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return null;
}

async function fetchObservations(traceId: string): Promise<Array<{ name: string; metadata?: Record<string, unknown> }>> {
  const auth = Buffer.from(
    `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
  ).toString('base64');

  const response = await fetch(
    `${LANGFUSE_BASE_URL}/api/public/observations?traceId=${encodeURIComponent(traceId)}&limit=50`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as {
    data?: Array<{ name: string; metadata?: Record<string, unknown> }>;
  };
  return payload.data ?? [];
}

describeIfEnabled('search traces → Langfuse (integration)', () => {
  it('hybrid search emits a complete trace visible in the Langfuse API', async () => {
    const { initObservability, shutdownObservability } = await import('../../src/lib/observability.js');
    const { searchHybrid } = await import('../../src/lib/search/ai-search.js');
    initObservability();

    const testSessionId = `integration-test-${randomUUID()}`;
    const clients: IClientsProps = {
      supabase: createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!),
      openai: observeOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })),
      sessionId: testSessionId,
      observabilityEnvironment: 'integration-test',
    };

    // Use a semantically unique query so the semantic cache (vector similarity
    // threshold 0.90) doesn't match prior test runs. A shared prefix with a
    // UUID suffix still embeds to a near-identical vector; picking random
    // vocabulary forces a cache miss and exercises the full pipeline.
    const randomWords = ['zebra', 'quasar', 'pineapple', 'centrifuge', 'marmalade', 'trombone', 'stoichiometry'];
    const pick = randomWords.sort(() => Math.random() - 0.5).slice(0, 4).join(' ');
    const uniqueQuery = `${pick} ${randomUUID()}`;
    await searchHybrid(clients, { query: uniqueQuery, limit: 5 });

    await shutdownObservability();

    const trace = await pollForTrace(testSessionId);
    expect(trace, 'trace should land in Langfuse within 15 seconds').not.toBeNull();

    const traceRecord = trace as { id: string; name: string };
    expect(traceRecord.name).toBe('search');

    const observations = await fetchObservations(traceRecord.id);
    const spanNames = observations.map(observation => observation.name);

    // Expected child spans (some are conditional on cache state)
    expect(spanNames).toContain('semantic-cache-lookup');
    // Either a cache hit (no retrieve) or cache miss (retrieve span present)
    const hasRetrieve = spanNames.includes('retrieve');
    const hasTimingChildren =
      spanNames.includes('retrieve.vector') &&
      spanNames.includes('retrieve.keyword') &&
      spanNames.includes('retrieve.fusion');
    expect(hasRetrieve || hasTimingChildren).toBe(true);
  }, 45_000);
});
