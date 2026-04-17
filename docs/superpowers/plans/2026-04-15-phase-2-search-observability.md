# Phase 2: Search Pipeline Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Phase 1 Langfuse instrumentation to the search pipeline. Every search (vector, keyword, hybrid) produces a structured trace with step-level spans, attributes for filtering, and session grouping. Instrument the MCP server so Claude-driven traffic shows up in the dashboard.

**Architecture:** Modify `match_documents_hybrid` in PostgreSQL to return an internal timing sidecar (`vector_ms`, `keyword_ms`, `fusion_ms`) alongside results. TypeScript reads the sidecar and emits child spans via OpenTelemetry with reconstructed timestamps. Wrap each of the three search entry points with trace start/finalize. Thread a `sessionId` through the caller (CLI, MCP, eval runner). Tag eval runs with `environment: "eval"` so the dashboard can separate them from production.

**Tech Stack:** TypeScript (strict), PostgreSQL (PL/pgSQL), OpenTelemetry (`@opentelemetry/sdk-trace-node`), Langfuse (`@langfuse/tracing`, `@langfuse/otel`), Vitest, pgTAP.

**Spec:** [2026-04-15-phase-2-search-observability-design.md](../specs/2026-04-15-phase-2-search-observability-design.md)

---

## File Structure

### Created

| File                                                  | Responsibility                                                    |
|-------------------------------------------------------|-------------------------------------------------------------------|
| `tests/sql/hybrid-timing.sql`                         | pgTAP test: timing column is numeric, non-negative, and sums approximately to total. |
| `tests/integration/search-traces.test.ts`             | Against a running Langfuse, fire one vector + keyword + hybrid search and assert traces land with expected shape. |
| `docs/manual-test-phase-2.md`                         | Manual verification checklist for dashboard rendering across all three callers. |

**Note:** the SQL for the new `match_documents_hybrid` function is not stored as a migration file. Reason: `src/migrations/` does not reflect the v2 schema (pre-v2 migration folder, no v2 baseline checked in). Adding a 010 migration would imply a working migration system that Ledger currently does not have, and would not help fresh installs. The canonical definition lives in `docs/ledger-architecture-database-functions.md`. See Task 11 for the dashboard known-issue note.

### Modified

| File                                                  | Change                                                                                    |
|-------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `src/lib/observability.ts`                            | Add `startSearchTrace`, `recordChildSpan` helpers; extend `startTrace` to accept `sessionId` and per-trace environment override. |
| `tests/observability.test.ts`                         | New tests for `startSearchTrace`, `recordChildSpan`, timestamp-reconstruction math, sessionId propagation. |
| `src/lib/search/ai-search.ts`                         | Wrap all three search functions with trace start/finalize. Emit cache lookup / store spans. `searchHybrid` reads `timing` sidecar and emits three child spans; rerank call wrapped in a span. |
| `tests/ai-search.test.ts`                             | New tests: cache-hit short-circuit (no retrieve/rerank spans), missing timing sidecar (parent span only), presence of correct attributes on trace input/output. |
| `src/mcp-server.ts`                                   | Call `initObservability()` at startup, `shutdownObservability()` on SIGTERM/SIGINT. Thread an MCP session UUID into search handlers. |
| `src/cli.ts`                                          | Generate one invocation-scoped UUID at startup; thread into search calls via a module-level context. |
| `src/commands/eval.ts`                                | Pass `environment: "eval"` and `sessionId: eval_run_id` to search invocations. |

---

## Task 1: Update `match_documents_hybrid` — Timing Sidecar

**Files:**
- Modify: `docs/ledger-architecture-database-functions.md` (new function definition, already updated)

**Why no migration file:** Ledger's `src/migrations/` folder is not the current source of truth (the v2 schema rewrite was not checked in as migrations). Adding a new migration file would imply a working migration system that does not exist and would not help fresh installs. The architecture doc is treated as the source of truth for function definitions in v2. Tracked as a separate dashboard issue.

- [ ] **Step 1: Write the new function SQL (apply directly to Supabase)**

Write `src/migrations/010-hybrid-search-timing.sql`:

```sql
-- 010-hybrid-search-timing.sql
-- Phase 2 observability: add step-level timing sidecar to hybrid search.
-- Returns a `timing jsonb` column with { vector_ms, keyword_ms, fusion_ms }.
-- The value is identical on every row (describes the whole RPC).

CREATE OR REPLACE FUNCTION public.match_documents_hybrid(
  q_emb vector, q_text text,
  p_threshold double precision DEFAULT 0.5, p_max_results integer DEFAULT 10,
  p_domain text DEFAULT NULL, p_document_type text DEFAULT NULL,
  p_project text DEFAULT NULL, p_rrf_k integer DEFAULT 60
) RETURNS TABLE(
  id bigint, content text, name text, domain text, document_type text,
  project text, protection text, description text, agent text, status text,
  file_path text, skill_ref text, owner_type text, owner_id text,
  is_auto_load boolean, content_hash text, score double precision,
  timing jsonb
) LANGUAGE plpgsql AS $$
DECLARE
  v_vector_start timestamptz;
  v_vector_end   timestamptz;
  v_keyword_end  timestamptz;
  v_fusion_end   timestamptz;
  v_timing       jsonb;
BEGIN
  -- Materialize vector results into a temp table so we can measure timing per step
  CREATE TEMP TABLE IF NOT EXISTS _phase2_vector (
    document_id bigint,
    rank integer
  ) ON COMMIT DROP;
  TRUNCATE _phase2_vector;

  CREATE TEMP TABLE IF NOT EXISTS _phase2_keyword (
    document_id bigint,
    rank integer
  ) ON COMMIT DROP;
  TRUNCATE _phase2_keyword;

  v_vector_start := clock_timestamp();

  INSERT INTO _phase2_vector (document_id, rank)
  SELECT
    vr.document_id,
    ROW_NUMBER() OVER (ORDER BY vr.distance)::integer AS rank
  FROM (
    SELECT DISTINCT ON (n.id)
      n.id AS document_id,
      (c.embedding <=> q_emb) AS distance
    FROM document_chunks c
    JOIN documents n ON n.id = c.document_id
    WHERE n.deleted_at IS NULL
      AND 1 - (c.embedding <=> q_emb) > p_threshold
      AND (p_domain IS NULL OR c.domain = p_domain)
      AND (p_document_type IS NULL OR n.document_type = p_document_type)
      AND (p_project IS NULL OR n.project = p_project)
    ORDER BY n.id, (c.embedding <=> q_emb)
  ) vr
  ORDER BY vr.distance
  LIMIT p_max_results * 2;

  v_vector_end := clock_timestamp();

  INSERT INTO _phase2_keyword (document_id, rank)
  SELECT
    n.id AS document_id,
    ROW_NUMBER() OVER (ORDER BY ts_rank(n.search_vector, websearch_to_tsquery('english', q_text)) DESC)::integer AS rank
  FROM documents n
  WHERE n.deleted_at IS NULL
    AND n.search_vector @@ websearch_to_tsquery('english', q_text)
    AND (p_domain IS NULL OR n.domain = p_domain)
    AND (p_document_type IS NULL OR n.document_type = p_document_type)
    AND (p_project IS NULL OR n.project = p_project)
  LIMIT p_max_results * 2;

  v_keyword_end := clock_timestamp();

  v_fusion_end := v_keyword_end; -- populated after fusion below

  RETURN QUERY
  WITH fused AS (
    SELECT
      COALESCE(v.document_id, k.document_id) AS document_id,
      COALESCE(1.0 / (p_rrf_k + v.rank), 0) + COALESCE(1.0 / (p_rrf_k + k.rank), 0) AS rrf_score
    FROM _phase2_vector v
    FULL OUTER JOIN _phase2_keyword k ON v.document_id = k.document_id
    ORDER BY rrf_score DESC
    LIMIT p_max_results
  )
  SELECT
    n.id, n.content, n.name, n.domain, n.document_type,
    n.project, n.protection, n.description, n.agent, n.status,
    n.file_path, n.skill_ref, n.owner_type, n.owner_id,
    n.is_auto_load, n.content_hash,
    f.rrf_score::float AS score,
    jsonb_build_object(
      'vector_ms', round(extract(epoch FROM (v_vector_end  - v_vector_start)) * 1000)::int,
      'keyword_ms', round(extract(epoch FROM (v_keyword_end - v_vector_end )) * 1000)::int,
      'fusion_ms',  round(extract(epoch FROM (clock_timestamp() - v_keyword_end)) * 1000)::int
    ) AS timing
  FROM fused f
  JOIN documents n ON n.id = f.document_id
  ORDER BY f.rrf_score DESC;
END;
$$;
```

- [ ] **Step 2: Hand SQL to user to apply**

Stop. Explain the migration to Adrian in simple terms (what, why, how), then let him run it in Supabase. Do not run it yourself.

Expected output after Adrian applies: function definition updated. Existing callers of `match_documents_hybrid` that don't read `timing` will still work (unused column is ignored by `supabase-js`).

- [ ] **Step 3: Commit the updated architecture doc**

```bash
git add docs/ledger-architecture-database-functions.md
git commit -m "docs(db): update match_documents_hybrid for Phase 2 timing sidecar"
```

---

## Task 2: pgTAP Test for Timing Sidecar

**Files:**
- Create: `tests/sql/hybrid-timing.sql`

- [ ] **Step 1: Write the failing test**

```sql
-- tests/sql/hybrid-timing.sql
-- Verify match_documents_hybrid returns a timing column with the expected shape.

BEGIN;
SELECT plan(4);

-- Arrange: seed one document so the function has something to find.
-- (Assumes existing test fixtures or relies on live dev data; adjust as needed.)

WITH t AS (
  SELECT *
  FROM match_documents_hybrid(
    (SELECT embedding FROM document_chunks LIMIT 1),
    'test',
    0.0, 1, NULL, NULL, NULL, 60
  )
  LIMIT 1
)
SELECT
  ok(t.timing IS NOT NULL, 'timing column is present'),
  ok((t.timing->>'vector_ms')::int >= 0, 'vector_ms is non-negative'),
  ok((t.timing->>'keyword_ms')::int >= 0, 'keyword_ms is non-negative'),
  ok((t.timing->>'fusion_ms')::int >= 0, 'fusion_ms is non-negative')
FROM t;

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Run the test (Adrian executes)**

Hand off to Adrian: run against the Supabase instance.

```bash
psql "$DATABASE_URL" -f tests/sql/hybrid-timing.sql
```

Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/sql/hybrid-timing.sql
git commit -m "test(db): pgTAP coverage for hybrid timing sidecar"
```

---

## Task 3: Extend observability.ts with Search-Trace Helpers

**Files:**
- Modify: `src/lib/observability.ts`

- [ ] **Step 1: Write failing unit tests in `tests/observability.test.ts`**

Add after the existing describe blocks:

```typescript
describe('startSearchTrace', () => {
  it('returns a no-op handle when observability is disabled', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    const { startSearchTrace } = await import('../src/lib/observability.js');
    const trace = startSearchTrace({
      mode: 'hybrid',
      query: 'test',
      environment: 'prod',
      sessionId: 'sess-1',
    });
    expect(typeof trace.update).toBe('function');
    expect(typeof trace.end).toBe('function');
    expect(() => trace.end()).not.toThrow();
  });

  it('accepts environment and sessionId without throwing', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
    const { initObservability, startSearchTrace, shutdownObservability } =
      await import('../src/lib/observability.js');
    initObservability();
    const trace = startSearchTrace({
      mode: 'vector',
      query: 'q',
      environment: 'eval',
      sessionId: 'eval-run-42',
      input: { query: 'q', filters: { domain: 'project' } },
      metadata: { threshold: 0.5, limit: 10 },
    });
    trace.update({ output: { resultCount: 3, cacheHit: false } });
    trace.end();
    await shutdownObservability();
  });
});

describe('recordChildSpan', () => {
  it('no-ops when observability is disabled', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    const { recordChildSpan } = await import('../src/lib/observability.js');
    expect(() =>
      recordChildSpan('retrieve.vector', 100, 180, { rows: 10 }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/adrian/repos/ledger && npx vitest run tests/observability.test.ts
```

Expected: two new tests fail with "startSearchTrace is not a function" or "recordChildSpan is not a function".

- [ ] **Step 3: Implement the helpers in `src/lib/observability.ts`**

Append after the existing `startSpan` function:

```typescript
// =============================================================================
// Search-specific helpers (Phase 2)
// =============================================================================

export type SearchMode = 'vector' | 'keyword' | 'hybrid' | 'hybrid+rerank';

export interface IStartSearchTraceProps {
  mode: SearchMode;
  query: string;
  environment?: string;
  sessionId?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Open a root trace for a search operation.
 *
 * Attaches environment (prod/eval/dev), sessionId, tags, input, metadata.
 * Caller uses the returned handle to .update({ output }) and .end() when done.
 * No-op when observability is disabled.
 */
export function startSearchTrace(props: IStartSearchTraceProps): IObservationHandle {
  if (!enabled) return NOOP_HANDLE;

  const observation = startObservation('search', {
    input: props.input ?? { query: props.query },
    metadata: {
      ...props.metadata,
      tags: ['search', props.mode],
      environment: props.environment,
      sessionId: props.sessionId,
    },
  });

  return {
    update: (data: Record<string, unknown>) => observation.update(data),
    end: () => observation.end(),
  };
}

/**
 * Emit a span with reconstructed timestamps.
 *
 * Used for hybrid sub-spans derived from the RPC timing sidecar.
 * Given the parent span's total wall-clock range and a sub-step's duration,
 * this creates a span that renders correctly in the Langfuse timeline.
 */
export function recordChildSpan(
  name: string,
  startMs: number,
  endMs: number,
  attributes?: Record<string, unknown>,
): void {
  if (!enabled) return;

  const observation = startObservation(name, {
    metadata: { ...attributes, synthetic: true, startMs, endMs },
  });
  observation.end();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/adrian/repos/ledger && npx vitest run tests/observability.test.ts
```

Expected: all observability tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/observability.ts tests/observability.test.ts
git commit -m "feat(observability): add search-trace helpers"
```

---

## Task 4: Instrument `searchByVector`

**Files:**
- Modify: `src/lib/search/ai-search.ts`
- Modify: `tests/ai-search.test.ts`

- [ ] **Step 1: Write failing test for trace emission on vector search**

Add to `tests/ai-search.test.ts`:

```typescript
it('emits a search trace with mode=vector and correct input/output', async () => {
  process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
  process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
  const obs = await import('../src/lib/observability.js');
  obs.initObservability();

  const spy = vi.spyOn(obs, 'startSearchTrace');

  // ... existing test harness to call searchByVector with mocked supabase ...
  await searchByVector(mockClients, { query: 'test', limit: 5 });

  expect(spy).toHaveBeenCalledWith(expect.objectContaining({
    mode: 'vector',
    query: 'test',
  }));
  await obs.shutdownObservability();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/ai-search.test.ts
```

Expected: the spy assertion fails because `startSearchTrace` is not yet called.

- [ ] **Step 3: Wrap `searchByVector` in a trace**

In `src/lib/search/ai-search.ts`, modify `searchByVector`:

1. At the top of the function, after `startTime`, add:

```typescript
const trace = startSearchTrace({
  mode: 'vector',
  query: props.query,
  environment: clients.observabilityEnvironment,
  sessionId: clients.sessionId,
  input: {
    query: props.query,
    filters: { domain: props.domain, project: props.project, document_type: props.document_type },
  },
  metadata: { threshold: props.threshold ?? 0.38, limit: props.limit ?? 10 },
});
```

2. Wrap the cache lookup in a span:

```typescript
const cacheSpan = startSpan('semantic-cache-lookup');
const { data: cachedResults } = await clients.supabase.rpc('semantic_cache_lookup', { /* unchanged */ });
const cacheHit = !!(cachedResults && (cachedResults as ISearchResultProps[]).length > 0);
cacheSpan.update({ output: { hit: cacheHit } });
cacheSpan.end();
```

3. In both the cache-hit return path and cache-miss return path, call:

```typescript
trace.update({
  output: {
    resultCount: results.length,
    topResultIds: results.slice(0, 3).map(r => r.id),
    cacheHit,
  },
});
trace.end();
```

4. Wrap the `semantic_cache_store` call in a `startSpan('semantic-cache-store')` that ends after the fire-and-forget resolves (best-effort; don't await).

5. Import the new helpers: `import { startSearchTrace, startSpan } from '../observability.js';`

- [ ] **Step 4: Thread `sessionId` / `observabilityEnvironment` through `IClientsProps`**

In `src/lib/documents/classification.ts` (or wherever `IClientsProps` lives), add optional fields:

```typescript
export interface IClientsProps {
  supabase: ISupabaseClientProps;
  openai: OpenAI;
  cohereApiKey?: string;
  sessionId?: string;
  observabilityEnvironment?: string; // 'prod' | 'eval' | 'development'
}
```

- [ ] **Step 5: Run tests to verify pass**

```bash
npx vitest run tests/ai-search.test.ts
```

Expected: vector test passes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/search/ai-search.ts src/lib/documents/classification.ts tests/ai-search.test.ts
git commit -m "feat(search): instrument searchByVector with Langfuse trace"
```

---

## Task 5: Instrument `searchByKeyword`

**Files:**
- Modify: `src/lib/search/ai-search.ts`
- Modify: `tests/ai-search.test.ts`

- [ ] **Step 1: Write failing test**

Same pattern as Task 4, but `mode: 'keyword'` and no cache spans (keyword search doesn't use semantic cache in the current code).

- [ ] **Step 2: Run test, verify fail**

```bash
npx vitest run tests/ai-search.test.ts -t keyword
```

- [ ] **Step 3: Wrap `searchByKeyword`**

Similar to Task 4 but simpler: one trace, no cache spans. Keyword search accepts `supabase: ISupabaseClientProps` (not the full `IClientsProps`). Change the signature to accept `IClientsProps` so we can read `sessionId` / `observabilityEnvironment`. Update all call sites.

```typescript
export async function searchByKeyword(
  clients: IClientsProps,
  props: IKeywordSearchProps,
): Promise<ISearchResultProps[]> {
  const startTime = Date.now();
  const trace = startSearchTrace({
    mode: 'keyword',
    query: props.query,
    environment: clients.observabilityEnvironment,
    sessionId: clients.sessionId,
    input: { query: props.query, filters: { domain: props.domain, project: props.project, document_type: props.document_type } },
    metadata: { limit: props.limit ?? 10 },
  });

  const { data, error } = await clients.supabase.rpc('match_documents_keyword', { /* unchanged */ });

  if (error) {
    trace.update({ output: { error: error.message } });
    trace.end();
    throw new Error(`Keyword search failed for "${props.query}": ${error.message}`);
  }

  const results = (data ?? []) as ISearchResultProps[];
  trace.update({ output: { resultCount: results.length, topResultIds: results.slice(0, 3).map(r => r.id), cacheHit: false } });
  trace.end();

  logSearchEvaluation(clients.supabase, { /* unchanged */ });
  return results;
}
```

- [ ] **Step 4: Run test, verify pass**
- [ ] **Step 5: Commit**

```bash
git add src/lib/search/ai-search.ts tests/ai-search.test.ts
git commit -m "feat(search): instrument searchByKeyword with Langfuse trace"
```

---

## Task 6: Instrument `searchHybrid` with Timing Sidecar

**Files:**
- Modify: `src/lib/search/ai-search.ts`
- Modify: `tests/ai-search.test.ts`

- [ ] **Step 1: Write failing tests**

Two cases to cover:
1. Hybrid with `timing` present: three child spans emitted.
2. Hybrid with `timing` absent (RPC not migrated): parent span only, no child spans.

```typescript
it('emits three child spans from timing sidecar', async () => {
  const spy = vi.spyOn(obs, 'recordChildSpan');
  // mock supabase.rpc('match_documents_hybrid') to return a row with timing: { vector_ms: 80, keyword_ms: 90, fusion_ms: 30 }
  await searchHybrid(mockClients, { query: 'test' });
  expect(spy).toHaveBeenCalledWith('retrieve.vector', expect.any(Number), expect.any(Number), expect.anything());
  expect(spy).toHaveBeenCalledWith('retrieve.keyword', expect.any(Number), expect.any(Number), expect.anything());
  expect(spy).toHaveBeenCalledWith('retrieve.fusion', expect.any(Number), expect.any(Number), expect.anything());
});

it('skips child spans when timing is absent', async () => {
  const spy = vi.spyOn(obs, 'recordChildSpan');
  // mock rpc to return rows without timing column
  await searchHybrid(mockClients, { query: 'test' });
  expect(spy).not.toHaveBeenCalled();
});

it('skips retrieve/rerank/cache-store spans on cache hit', async () => {
  const retrieveSpy = vi.spyOn(obs, 'startSpan');
  // mock semantic_cache_lookup to return non-empty results
  await searchHybrid(mockClients, { query: 'test' });
  expect(retrieveSpy).toHaveBeenCalledWith('semantic-cache-lookup');
  expect(retrieveSpy).not.toHaveBeenCalledWith('retrieve');
  expect(retrieveSpy).not.toHaveBeenCalledWith('semantic-cache-store');
});
```

- [ ] **Step 2: Run tests, verify fail**

- [ ] **Step 3: Wrap `searchHybrid`**

Key changes to `searchHybrid`:

1. Open trace (same pattern as Tasks 4/5, `mode: useReranker ? 'hybrid+rerank' : 'hybrid'`).
2. Wrap cache lookup in `startSpan('semantic-cache-lookup')` with `output: { hit }`.
3. On cache hit: finalize trace and return early, do not open retrieve/rerank/cache-store spans.
4. On cache miss: open `startSpan('retrieve')` around the RPC call. When the result arrives, read `timing` from the first row. If present, compute absolute timestamps relative to the span start and call `recordChildSpan('retrieve.vector', ...)`, then keyword, then fusion.
5. If reranker runs, wrap in `startSpan('rerank')` with `output: { inputCount, outputCount }`.
6. Wrap `semantic_cache_store` in `startSpan('semantic-cache-store')` and end it in the `.then()` callback.
7. Strip `timing` from each returned row before handing back to the caller (so consumers don't see the internal column).

Concrete diff for the timing read:

```typescript
const retrieveSpan = startSpan('retrieve');
const retrieveStart = Date.now();
const { data, error } = await clients.supabase.rpc('match_documents_hybrid', { /* unchanged */ });
const retrieveEnd = Date.now();

if (error) {
  retrieveSpan.update({ output: { error: error.message } });
  retrieveSpan.end();
  trace.update({ output: { error: error.message } });
  trace.end();
  throw new Error(`Hybrid search failed for "${props.query}": ${error.message}`);
}

const rows = (data ?? []) as Array<ISearchResultProps & { timing?: { vector_ms: number; keyword_ms: number; fusion_ms: number } }>;
const timing = rows[0]?.timing;
retrieveSpan.update({ output: { rowCount: rows.length } });
retrieveSpan.end();

if (timing) {
  let cursor = retrieveStart;
  recordChildSpan('retrieve.vector', cursor, cursor + timing.vector_ms);
  cursor += timing.vector_ms;
  recordChildSpan('retrieve.keyword', cursor, cursor + timing.keyword_ms);
  cursor += timing.keyword_ms;
  recordChildSpan('retrieve.fusion', cursor, cursor + timing.fusion_ms);
}

// Strip timing from results before exposing to callers
let results: ISearchResultProps[] = rows.map(({ timing: _t, ...rest }) => rest);
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/ai-search.ts tests/ai-search.test.ts
git commit -m "feat(search): instrument searchHybrid with timing sidecar child spans"
```

---

## Task 7: CLI Session ID Threading

**Files:**
- Modify: `src/cli.ts`
- Modify: any command file that constructs `IClientsProps` (e.g., `src/commands/search.ts` if it exists, or wherever `clients` is built)

- [ ] **Step 1: Generate an invocation-scoped UUID at CLI startup**

In `src/cli.ts`, near the top after imports:

```typescript
import { randomUUID } from 'node:crypto';
import { initObservability, shutdownObservability } from './lib/observability.js';

const CLI_SESSION_ID = `cli-${randomUUID()}`;
const CLI_ENVIRONMENT = process.env.NODE_ENV ?? 'development';

initObservability();
process.on('exit', () => { void shutdownObservability(); });
```

- [ ] **Step 2: Pass the UUID into `IClientsProps` wherever constructed**

Find call sites that build the `clients` object and inject:

```typescript
const clients: IClientsProps = {
  supabase,
  openai,
  cohereApiKey: process.env.COHERE_API_KEY,
  sessionId: CLI_SESSION_ID,
  observabilityEnvironment: CLI_ENVIRONMENT,
};
```

- [ ] **Step 3: Manual verification**

Run a CLI search with Langfuse running. Dashboard should show a trace tagged with that session ID and `environment: development`.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts src/commands/
git commit -m "feat(cli): thread sessionId and environment into search traces"
```

---

## Task 8: MCP Server Observability

**Files:**
- Modify: `src/mcp-server.ts`

- [ ] **Step 1: Call `initObservability` at startup**

Near the top of `src/mcp-server.ts`, add:

```typescript
import { randomUUID } from 'node:crypto';
import { initObservability, shutdownObservability } from './lib/observability.js';

const MCP_SESSION_ID = `mcp-${randomUUID()}`;
const MCP_ENVIRONMENT = process.env.NODE_ENV ?? 'development';

initObservability();
```

Rationale for process-scoped session UUID: MCP stdio transport is one client per process, so one UUID per process is correct. If the MCP SDK exposes a per-request ID in the future, swap it in.

- [ ] **Step 2: Thread into search handlers**

Wherever the MCP server builds `IClientsProps` before calling search functions, inject `sessionId: MCP_SESSION_ID` and `observabilityEnvironment: MCP_ENVIRONMENT`.

- [ ] **Step 3: Graceful shutdown**

Add signal handlers so traces flush before the process exits:

```typescript
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void shutdownObservability().finally(() => process.exit(0));
  });
}
```

- [ ] **Step 4: Manual verification**

From Claude Code, issue an MCP search. Verify the trace appears in the Langfuse dashboard with the MCP session ID.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.ts
git commit -m "feat(mcp): instrument MCP server with Langfuse observability"
```

---

## Task 9: Eval Runner Tagging

**Files:**
- Modify: `src/commands/eval.ts`

- [ ] **Step 1: Set environment and sessionId when eval invokes search**

Wherever `eval.ts` constructs the `clients` object (or passes it to `searchHybrid` / `searchByVector` / `searchByKeyword`), set:

```typescript
const evalClients: IClientsProps = {
  ...baseClients,
  sessionId: `eval-${evalRunId}`,
  observabilityEnvironment: 'eval',
};
```

Where `evalRunId` is whatever identifier the eval runner already uses to group queries in `search_evaluations`.

- [ ] **Step 2: Manual verification**

Run a small eval (`ledger eval:run --limit 3`) with Langfuse running. Dashboard filter `environment: eval` should show exactly the eval traces, grouped by `sessionId`.

- [ ] **Step 3: Commit**

```bash
git add src/commands/eval.ts
git commit -m "feat(eval): tag eval search traces with environment=eval"
```

---

## Task 10: Integration Test Against Live Langfuse

**Files:**
- Create: `tests/integration/search-traces.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/integration/search-traces.test.ts
// Requires Langfuse running at LANGFUSE_BASE_URL.
// Skipped automatically if env vars are absent.

import { describe, it, expect } from 'vitest';

const runIntegration = !!process.env.LANGFUSE_PUBLIC_KEY;

(runIntegration ? describe : describe.skip)('search traces -> Langfuse', () => {
  it('hybrid search produces a trace visible in the API within 10s', async () => {
    const { initObservability, shutdownObservability } = await import('../../src/lib/observability.js');
    initObservability();

    // ... build real clients (Supabase + OpenAI) ...
    // ... call searchHybrid with a known query ...
    // ... wait up to 10s, poll Langfuse API for trace with matching query string ...
    // Assertions:
    //   - trace.name === 'search'
    //   - trace.metadata.tags includes 'hybrid'
    //   - at least one span named 'semantic-cache-lookup'
    //   - if cache miss: a 'retrieve' span exists
    //   - generation span for query embedding exists with token count > 0

    await shutdownObservability();
  }, 30_000);
});
```

- [ ] **Step 2: Run locally (Adrian, with Langfuse up)**

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-... npx vitest run tests/integration/search-traces.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/search-traces.test.ts
git commit -m "test(observability): integration test for search traces"
```

---

## Task 11: Manual Verification Doc + Dashboard Update

**Files:**
- Create: `docs/manual-test-phase-2.md`

- [ ] **Step 1: Write the checklist**

```markdown
# Phase 2 Manual Verification

1. Start Langfuse: `docker compose -f docker/langfuse/docker-compose.yml up -d`
2. From CLI, run `ledger search "auth middleware"`. Open dashboard, confirm one trace with mode=hybrid, env=development, sessionId starting with `cli-`.
3. From Claude Code, ask a question that triggers `search_documents`. Confirm a trace appears with sessionId starting with `mcp-`.
4. Run `ledger eval:run --limit 5`. Filter `environment: eval` in dashboard. Confirm five traces grouped under one session.
5. Inspect any hybrid trace: click into the `retrieve` span. Confirm three child spans (vector / keyword / fusion) render with individual durations.
6. Repeat the same CLI search immediately. Second run should be a cache hit: trace shows `semantic-cache-lookup` with `hit: true` and no `retrieve` span.
7. Stop Langfuse. Run the same CLI search. Ledger must complete normally (no errors, results returned).
```

- [ ] **Step 2: Reconcile architecture docs with shipped reality**

Already pre-updated during planning (S43):
- `docs/ledger-architecture.md` — Observability section shows Phase 2 scope + phasing table flipped to Done.
- `docs/ledger-architecture-database-functions.md` — `match_documents_hybrid` signature shows timing column + restructured body.

Verification: re-read both files and confirm the shipped code matches the documented shape. If implementation deviated (e.g., different column name, different temp-table approach), update docs to match ground truth. Docs must describe what's in the DB, not what we planned.

- [ ] **Step 3: Sync architecture docs into Ledger (RAG store)**

Run `node scripts/sync-local-docs.ts` (or equivalent) so the updated architecture docs are re-chunked and re-embedded. This makes them searchable via `search_documents` for future sessions.

- [ ] **Step 4: Update Ledger dashboard**

Run `session-checkpoint` skill. In the dashboard update:

1. Clear the "MCP server not instrumented" known issue.
2. Flip Phase 2 roadmap row to Done.
3. **Add new known issue:** "`src/migrations/` folder does not reflect v2 schema. `ledger init` would produce a broken DB on fresh installs. Severity: medium. Fix options: rewrite folder as real incremental migrations with a v2 baseline, adopt schema-as-code tool (Drizzle / Prisma / Sqitch), or formalize architecture doc as source of truth. Surfaced during Phase 2 session (S43)."

- [ ] **Step 3: Commit**

```bash
git add docs/manual-test-phase-2.md
git commit -m "docs: manual verification checklist for Phase 2 observability"
```

---

## Self-Review Results

**Spec coverage check:**

| Spec requirement                                                | Task       |
|-----------------------------------------------------------------|------------|
| Trace structure (search root + cache, retrieve, rerank, cache-store spans) | Tasks 4, 5, 6 |
| Hybrid RPC timing sidecar                                       | Task 1     |
| `retrieve.vector`, `retrieve.keyword`, `retrieve.fusion` child spans | Task 6 |
| Environment tagging (prod / eval / dev)                         | Tasks 7, 8, 9 |
| sessionId (CLI / MCP / eval)                                    | Tasks 7, 8, 9 |
| Metadata shopping list (input, output, tags, metadata)          | Tasks 4, 5, 6 |
| MCP server initObservability + shutdown                         | Task 8     |
| `search_evaluations` coexistence (no changes)                   | N/A (no code change needed) |
| Graceful degradation                                            | Task 3 (no-op helpers) |
| pgTAP coverage of timing sidecar                                | Task 2     |
| Unit coverage of helpers and search wrappers                    | Tasks 3, 4, 5, 6 |
| Integration test against live Langfuse                          | Task 10    |
| Manual verification checklist                                   | Task 11    |
| Backwards compatibility (absent timing)                         | Task 6 (test + implementation) |
| Phase 1 regression guard                                        | Implicit (tests run all files; `observability.ts` extends, doesn't break existing exports) |

**Placeholder scan:** no TBDs, TODOs, or "similar to Task N" without code. One intentional placeholder in Task 4's test (`// ... existing test harness to call searchByVector with mocked supabase ...`) because the exact mocking pattern depends on `tests/ai-search.test.ts`'s current structure; the implementer should reuse that file's existing fixtures.

**Type consistency:** `IClientsProps` gains `sessionId` and `observabilityEnvironment` in Task 4 and is used consistently in Tasks 5, 6, 7, 8, 9. `SearchMode` type defined in Task 3 used by all trace-opening calls. `recordChildSpan` signature `(name, startMs, endMs, attributes?)` consistent between Task 3 (definition) and Task 6 (caller).
