# Phase 2 Manual Verification Checklist

> Last verified: 2026-04-15 (Session 43)

## Prerequisites

- Langfuse running: `docker compose -f docker/langfuse/docker-compose.yml up -d`
- Dashboard: `http://localhost:9100`
- Ledger `.env` has `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`

## Check 1: CLI search trace

Run:

```bash
cd ~/repos/ledger && npx tsx src/cli.ts show "any search query"
```

In the Langfuse dashboard (Traces):

- [ ] Trace name is `search`
- [ ] Tags: `search`, `hybrid`
- [ ] Session ID starts with `cli-`
- [ ] Environment: `development`
- [ ] Child spans: `semantic-cache-lookup` (always), `retrieve` (on cache miss)
- [ ] On cache miss: `retrieve` has children `retrieve.vector`, `retrieve.keyword`, `retrieve.fusion` with timing data
- [ ] On cache hit: only `semantic-cache-lookup` with `hit: true`, no retrieve spans

## Check 2: MCP search trace

From Claude Code (or any MCP client), invoke `search_documents`. Check Langfuse:

- [ ] Trace name is `search`
- [ ] Tags: `search`, `hybrid`
- [ ] Session ID starts with `mcp-`
- [ ] Environment: `development`
- [ ] Same span structure as CLI

Note: MCP server must be restarted after code changes to pick up new instrumentation.

## Check 3: Eval search traces

Run:

```bash
cd ~/repos/ledger && npx tsx src/cli.ts eval --dry-run
```

In the dashboard, filter by Environment = `eval`:

- [ ] Multiple `search` traces appear (one per golden query)
- [ ] All share the same session ID starting with `eval-`
- [ ] Tags: `search`, `hybrid`
- [ ] Environment: `eval`

## Check 4: Graceful degradation

Stop Langfuse:

```bash
docker compose -f docker/langfuse/docker-compose.yml down
```

Run the same CLI search. Confirm:

- [ ] Search completes normally with results returned
- [ ] No errors in stderr related to Langfuse or tracing
- [ ] Ledger is fully functional without observability

Restart Langfuse after this check.

## Check 5: Cache behavior visibility

Run the same CLI search twice in a row:

- [ ] First run: `cacheHit: false` in trace output, full span tree
- [ ] Second run: `cacheHit: true` in trace output, only `semantic-cache-lookup` span

## Integration test (automated)

```bash
INTEGRATION_TEST=1 npx vitest run tests/integration/search-traces.test.ts
```

- [ ] Test passes (trace lands in Langfuse API with expected shape within 15s)
