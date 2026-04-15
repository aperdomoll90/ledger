# Langfuse Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automated pipeline observability to Ledger's ingestion path using self-hosted Langfuse, so every document create/update produces a trace with step-level timing, token usage, and cost.

**Architecture:** Self-hosted Langfuse (6 Docker containers, port 9100) integrated via 3 SDK packages. OpenAI client is wrapped once in `config.ts` for auto-capture of LLM/embedding calls. Manual spans added for non-API steps (chunking, DB write). Graceful degradation when Langfuse is unavailable.

**Tech Stack:** Langfuse v3 (Docker), `@langfuse/tracing`, `@langfuse/openai`, `@langfuse/otel`, `@opentelemetry/sdk-trace-node`

**Spec:** `docs/superpowers/specs/2026-04-14-observability-langfuse-design.md`

---

## File Map

| File                                            | Action | Responsibility                                              |
|-------------------------------------------------|--------|-------------------------------------------------------------|
| `docker/langfuse/docker-compose.yml`            | Create | Langfuse stack definition (6 containers, port 9100)         |
| `docker/langfuse/.env.example`                  | Create | Template for Langfuse server environment variables          |
| `src/lib/observability.ts`                      | Create | Langfuse init, span helpers, shutdown, graceful degradation |
| `tests/observability.test.ts`                   | Create | Unit tests for observability module                         |
| `src/lib/config.ts`                             | Modify | Wrap OpenAI client with `observeOpenAI()`                   |
| `src/lib/documents/operations.ts`               | Modify | Add trace root + manual spans for chunking and DB write     |
| `src/lib/search/chunk-context-enrichment.ts`    | None   | Already receives OpenAI client as parameter from operations.ts |
| `src/lib/search/embeddings.ts`                  | None   | Already receives OpenAI client as parameter from operations.ts |
| `src/cli.ts`                                    | Modify | Call `initObservability()` at startup, shutdown on exit     |
| `.env`                                          | Modify | Add Langfuse env vars                                       |
| `package.json`                                  | Modify | Add 4 npm packages                                         |

---

### Task 1: Docker Compose Setup

**Files:**
- Create: `docker/langfuse/docker-compose.yml`
- Create: `docker/langfuse/.env.example`

This task sets up the Langfuse infrastructure. You will run Docker Compose to bring up 6 containers, then create a project in the Langfuse dashboard to get your API keys.

- [ ] **Step 1: Create the directory**

```bash
mkdir -p ~/repos/ledger/docker/langfuse
```

- [ ] **Step 2: Create the docker-compose.yml**

Create `docker/langfuse/docker-compose.yml`:

```yaml
# Langfuse self-hosted stack for Ledger observability.
# Docs: https://langfuse.com/docs/deployment/self-host
#
# Usage:
#   cd docker/langfuse
#   docker compose up -d
#
# Dashboard: http://localhost:9100
# All other services are internal-only (no host ports exposed).

services:
  langfuse-web:
    image: langfuse/langfuse:3
    depends_on:
      postgres:
        condition: service_healthy
      clickhouse:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
    ports:
      - "9100:3000"
    environment:
      - DATABASE_URL=postgresql://langfuse:langfuse@postgres:5432/langfuse
      - SALT=${SALT}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - NEXTAUTH_URL=http://localhost:9100
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
      - CLICKHOUSE_URL=http://clickhouse:8123
      - CLICKHOUSE_USER=default
      - CLICKHOUSE_PASSWORD=langfuse
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - REDIS_AUTH=${REDIS_AUTH}
      - LANGFUSE_S3_EVENT_UPLOAD_ENABLED=true
      - LANGFUSE_S3_EVENT_UPLOAD_BUCKET=langfuse
      - LANGFUSE_S3_EVENT_UPLOAD_REGION=us-east-1
      - LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID=minioadmin
      - LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=minioadmin
      - LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT=http://minio:9000
      - LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE=true
      - LANGFUSE_INIT_ORG_ID=ledger-org
      - LANGFUSE_INIT_ORG_NAME=Ledger
      - LANGFUSE_INIT_PROJECT_ID=ledger-project
      - LANGFUSE_INIT_PROJECT_NAME=Ledger
      - LANGFUSE_INIT_USER_EMAIL=adrian@perdomostudio.com
      - LANGFUSE_INIT_USER_NAME=Adrian
      - LANGFUSE_INIT_USER_PASSWORD=${LANGFUSE_INIT_USER_PASSWORD}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/api/public/health"]
      interval: 15s
      timeout: 5s
      retries: 5

  langfuse-worker:
    image: langfuse/langfuse-worker:3
    depends_on:
      postgres:
        condition: service_healthy
      clickhouse:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
    environment:
      - DATABASE_URL=postgresql://langfuse:langfuse@postgres:5432/langfuse
      - SALT=${SALT}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - NEXTAUTH_URL=http://localhost:9100
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
      - CLICKHOUSE_URL=http://clickhouse:8123
      - CLICKHOUSE_USER=default
      - CLICKHOUSE_PASSWORD=langfuse
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - REDIS_AUTH=${REDIS_AUTH}
      - LANGFUSE_S3_EVENT_UPLOAD_ENABLED=true
      - LANGFUSE_S3_EVENT_UPLOAD_BUCKET=langfuse
      - LANGFUSE_S3_EVENT_UPLOAD_REGION=us-east-1
      - LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID=minioadmin
      - LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=minioadmin
      - LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT=http://minio:9000
      - LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE=true
    restart: unless-stopped

  postgres:
    image: postgres:17
    environment:
      - POSTGRES_USER=langfuse
      - POSTGRES_PASSWORD=langfuse
      - POSTGRES_DB=langfuse
    volumes:
      - langfuse-postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U langfuse"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  clickhouse:
    image: clickhouse/clickhouse-server
    environment:
      - CLICKHOUSE_USER=default
      - CLICKHOUSE_PASSWORD=langfuse
    volumes:
      - langfuse-clickhouse:/var/lib/clickhouse
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:8123/ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7
    command: redis-server --requirepass ${REDIS_AUTH}
    volumes:
      - langfuse-redis:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_AUTH}", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  minio:
    image: cgr.dev/chainguard/minio
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=minioadmin
      - MINIO_ROOT_PASSWORD=minioadmin
    volumes:
      - langfuse-minio:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

volumes:
  langfuse-postgres:
  langfuse-clickhouse:
  langfuse-redis:
  langfuse-minio:
```

- [ ] **Step 3: Create the .env.example**

Create `docker/langfuse/.env.example`:

```bash
# Langfuse server environment variables.
# Copy this to .env and fill in the generated values.
#
# Generate secrets:
#   openssl rand -hex 32

SALT=<generate-with-openssl-rand-hex-32>
ENCRYPTION_KEY=<generate-with-openssl-rand-hex-32>
NEXTAUTH_SECRET=<generate-with-openssl-rand-hex-32>
REDIS_AUTH=<generate-with-openssl-rand-hex-32>
LANGFUSE_INIT_USER_PASSWORD=<choose-a-password>
```

- [ ] **Step 4: Generate the actual .env file**

```bash
cd ~/repos/ledger/docker/langfuse
cp .env.example .env

# Generate secrets
SALT=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
NEXTAUTH_SECRET=$(openssl rand -hex 32)
REDIS_AUTH=$(openssl rand -hex 32)

# Write to .env (choose your own password for LANGFUSE_INIT_USER_PASSWORD)
cat > .env << EOF
SALT=${SALT}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
REDIS_AUTH=${REDIS_AUTH}
LANGFUSE_INIT_USER_PASSWORD=changeme123
EOF
```

- [ ] **Step 5: Add docker/langfuse/.env to .gitignore**

Append to the project's `.gitignore`:

```
# Langfuse secrets
docker/langfuse/.env
```

- [ ] **Step 6: Start Langfuse**

```bash
cd ~/repos/ledger/docker/langfuse
docker compose up -d
```

Wait for all containers to be healthy:

```bash
docker compose ps
```

Expected: all 6 services show "healthy" status. This may take 30-60 seconds on first run (image pulls).

- [ ] **Step 7: Create a MinIO bucket**

Langfuse needs an S3 bucket for event uploads. MinIO starts empty.

```bash
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker compose exec minio mc mb local/langfuse
```

- [ ] **Step 8: Open the dashboard and get API keys**

Open `http://localhost:9100` in your browser. Log in with:
- Email: `adrian@perdomostudio.com`
- Password: whatever you set for `LANGFUSE_INIT_USER_PASSWORD`

The "Ledger" project should already exist (auto-created via `LANGFUSE_INIT_*` env vars). Go to **Settings > API Keys** and create a new API key pair. Copy the public key (`pk-lf-...`) and secret key (`sk-lf-...`).

- [ ] **Step 9: Add Langfuse keys to Ledger's .env**

Add these lines to `~/.ledger/.env` (Ledger's environment file):

```bash
# Langfuse observability (optional — Ledger works without these)
LANGFUSE_PUBLIC_KEY=pk-lf-<your-key>
LANGFUSE_SECRET_KEY=sk-lf-<your-key>
LANGFUSE_BASE_URL=http://localhost:9100
```

- [ ] **Step 10: Commit**

```bash
cd ~/repos/ledger
git add docker/langfuse/docker-compose.yml docker/langfuse/.env.example .gitignore
git commit -m "add Langfuse Docker Compose stack and env template"
```

---

### Task 2: Install npm packages

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install Langfuse and OpenTelemetry packages**

```bash
cd ~/repos/ledger
npm install @langfuse/tracing @langfuse/openai @langfuse/otel @opentelemetry/sdk-trace-node
```

- [ ] **Step 2: Verify installation**

```bash
cd ~/repos/ledger
node -e "require('@langfuse/otel'); console.log('ok')"
```

Expected: `ok` (no errors)

- [ ] **Step 3: Commit**

```bash
cd ~/repos/ledger
git add package.json package-lock.json
git commit -m "add Langfuse and OpenTelemetry packages"
```

---

### Task 3: Observability Module

**Files:**
- Create: `src/lib/observability.ts`
- Create: `tests/observability.test.ts`

This is the core module. It initializes Langfuse, provides span helper functions, and handles graceful shutdown. When Langfuse env vars are missing, everything no-ops silently.

- [ ] **Step 1: Write the failing tests**

Create `tests/observability.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('observability', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('initObservability', () => {
    it('returns false when LANGFUSE_PUBLIC_KEY is not set', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { initObservability } = await import('../src/lib/observability.js');
      const result = initObservability();
      expect(result).toBe(false);
    });

    it('returns true when LANGFUSE_PUBLIC_KEY is set', async () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
      process.env.LANGFUSE_BASE_URL = 'http://localhost:9100';
      const { initObservability, shutdownObservability } = await import('../src/lib/observability.js');
      const result = initObservability();
      expect(result).toBe(true);
      await shutdownObservability();
    });
  });

  describe('isObservabilityEnabled', () => {
    it('returns false before init', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { isObservabilityEnabled } = await import('../src/lib/observability.js');
      expect(isObservabilityEnabled()).toBe(false);
    });
  });

  describe('startTrace / startSpan', () => {
    it('returns no-op trace when observability is disabled', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { initObservability, startTrace } = await import('../src/lib/observability.js');
      initObservability();
      const trace = startTrace('test-trace', { tags: ['test'] });
      expect(trace).toBeDefined();
      expect(trace.end).toBeTypeOf('function');
      // Should not throw
      trace.end();
    });

    it('returns no-op span when observability is disabled', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { initObservability, startSpan } = await import('../src/lib/observability.js');
      initObservability();
      const span = startSpan('test-span', { input: { key: 'value' } });
      expect(span).toBeDefined();
      expect(span.end).toBeTypeOf('function');
      expect(span.update).toBeTypeOf('function');
      span.update({ output: { result: 'ok' } });
      span.end();
    });
  });

  describe('shutdownObservability', () => {
    it('resolves without error when observability is disabled', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { shutdownObservability } = await import('../src/lib/observability.js');
      await expect(shutdownObservability()).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/repos/ledger
npx vitest run tests/observability.test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Write the observability module**

Create `src/lib/observability.ts`:

```typescript
// observability.ts
// Langfuse tracing integration for pipeline observability.
//
// Provides trace/span helpers for instrumenting Ledger's ingestion pipeline.
// When Langfuse env vars are absent, all functions no-op silently.
// Ledger works identically with or without observability enabled.
//
// Built on OpenTelemetry (OTel), the industry-standard tracing protocol.
// Langfuse acts as the trace collector and dashboard. The OTel foundation
// means switching to Datadog, Grafana Tempo, or Jaeger requires swapping
// the exporter, not the instrumentation.

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider, startObservation, propagateAttributes } from '@langfuse/tracing';

// =============================================================================
// State
// =============================================================================

let provider: NodeTracerProvider | null = null;
let enabled = false;

// =============================================================================
// No-op objects (returned when observability is disabled)
// =============================================================================

interface IObservationHandle {
  update: (data: Record<string, unknown>) => void;
  end: () => void;
}

const NOOP_HANDLE: IObservationHandle = {
  update: () => {},
  end: () => {},
};

// =============================================================================
// Init / Shutdown
// =============================================================================

/**
 * Initialize Langfuse observability.
 * Returns true if enabled, false if skipped (missing env vars).
 *
 * Call once at CLI startup. Safe to call multiple times (idempotent).
 */
export function initObservability(): boolean {
  if (enabled) return true;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey) return false;

  provider = new NodeTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey,
        secretKey,
        baseUrl: baseUrl ?? 'http://localhost:9100',
        environment: process.env.NODE_ENV ?? 'development',
        exportMode: 'batched',
        flushAt: 10,
        flushInterval: 2,
      }),
    ],
  });

  setLangfuseTracerProvider(provider);
  enabled = true;
  return true;
}

/**
 * Flush pending traces and shut down the provider.
 * Call before process exit to ensure all traces are sent.
 */
export async function shutdownObservability(): Promise<void> {
  if (!provider) return;
  await provider.forceFlush();
  await provider.shutdown();
  provider = null;
  enabled = false;
}

/**
 * Check if observability is currently enabled.
 */
export function isObservabilityEnabled(): boolean {
  return enabled;
}

// =============================================================================
// Trace / Span helpers
// =============================================================================

/**
 * Start a new trace (root-level observation).
 * Use for top-level operations like document ingestion.
 *
 * Returns a handle with update() and end() methods.
 * When observability is disabled, returns a no-op handle.
 */
export function startTrace(
  name: string,
  options?: { tags?: string[]; metadata?: Record<string, unknown>; input?: Record<string, unknown> },
): IObservationHandle {
  if (!enabled) return NOOP_HANDLE;

  if (options?.tags || options?.metadata) {
    propagateAttributes({
      tags: options.tags,
      metadata: options.metadata,
    });
  }

  const observation = startObservation(name, {
    input: options?.input,
    metadata: options?.metadata,
  });

  return {
    update: (data: Record<string, unknown>) => observation.update(data),
    end: () => observation.end(),
  };
}

/**
 * Start a span (child observation within a trace).
 * Use for pipeline steps like chunking, enrichment, embedding, DB write.
 *
 * Returns a handle with update() and end() methods.
 * When observability is disabled, returns a no-op handle.
 */
export function startSpan(
  name: string,
  options?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> },
): IObservationHandle {
  if (!enabled) return NOOP_HANDLE;

  const observation = startObservation(name, {
    input: options?.input,
    metadata: options?.metadata,
  });

  return {
    update: (data: Record<string, unknown>) => observation.update(data),
    end: () => observation.end(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/repos/ledger
npx vitest run tests/observability.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/repos/ledger
git add src/lib/observability.ts tests/observability.test.ts
git commit -m "add observability module with trace/span helpers and tests"
```

---

### Task 4: Wrap the OpenAI Client

**Files:**
- Modify: `src/lib/config.ts`

The OpenAI client in `config.ts` is imported throughout the codebase. Wrapping it with `observeOpenAI()` at the source means all downstream OpenAI calls are automatically traced with zero changes to calling code.

- [ ] **Step 1: Update config.ts to wrap the OpenAI client**

In `src/lib/config.ts`, add the import at the top:

```typescript
import { observeOpenAI } from '@langfuse/openai';
```

Then change the `loadConfig()` function. Replace the line that creates the OpenAI client:

```typescript
    openai: new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 5 }),
```

With:

```typescript
    openai: observeOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 5 })),
```

The `observeOpenAI` wrapper is transparent. It proxies all method calls to the real OpenAI client, and if Langfuse is initialized, it records traces. If Langfuse is not initialized, the wrapper passes through with no overhead.

- [ ] **Step 2: Run the full test suite to verify nothing breaks**

```bash
cd ~/repos/ledger
npx vitest run
```

Expected: all existing tests pass. The wrapper is transparent, so no test should break.

- [ ] **Step 3: Commit**

```bash
cd ~/repos/ledger
git add src/lib/config.ts
git commit -m "wrap OpenAI client with Langfuse observeOpenAI for auto-tracing"
```

---

### Task 5: Instrument the Ingestion Pipeline

**Files:**
- Modify: `src/lib/documents/operations.ts`

This is where the actual tracing happens. We add a trace (root) to `createDocument` and `updateDocument`, and manual spans for the chunking and DB write steps. The enrichment and embedding steps are auto-traced by the wrapped OpenAI client.

- [ ] **Step 1: Add imports to operations.ts**

At the top of `src/lib/documents/operations.ts`, add:

```typescript
import { startTrace, startSpan } from '../observability.js';
```

- [ ] **Step 2: Instrument createDocument**

Replace the body of `createDocument` (lines 33-79) with:

```typescript
export async function createDocument(
  clients: IClientsProps,
  props: ICreateDocumentProps,
  chunkConfig?: Partial<IChunkConfigProps>,
): Promise<number> {
  const config = { ...DEFAULT_CHUNK_CONFIG, ...chunkConfig };
  const hash = contentHash(props.content);

  const trace = startTrace('document-ingestion', {
    tags: ['ingestion', 'create'],
    metadata: { documentName: props.name, domain: props.domain, documentType: props.document_type },
    input: { contentLength: props.content.length },
  });

  // Chunk
  const chunkSpan = startSpan('chunking', { input: { contentLength: props.content.length } });
  const chunks = chunkText(props.content, config);
  const chunkContents = chunks.map(chunk => chunk.content);
  chunkSpan.update({ output: { chunkCount: chunks.length, avgChunkSize: Math.round(props.content.length / chunks.length) } });
  chunkSpan.end();

  // Enrich — generate context summaries per chunk (LLM calls auto-traced by wrapped client)
  const enrichSpan = startSpan('context-enrichment', { metadata: { chunkCount: chunks.length, model: 'gpt-4o-mini' } });
  const enrichmentResults = await generateContextSummaries(clients.openai, chunks, props.content);
  const chunkSummaries = enrichmentResults.map(result => result.summary);
  const chunkTokenCounts = enrichmentResults.map(result => result.tokenCount);
  enrichSpan.end();

  // Embed — summary + "\n\n" + chunk content (batch: one API call per 100 chunks, auto-traced)
  const embedSpan = startSpan('batch-embedding', { metadata: { chunkCount: chunks.length, model: 'text-embedding-3-small' } });
  const embeddingInputs = chunks.map((chunk, index) => chunkSummaries[index] + '\n\n' + chunk.content);
  const embeddings = await generateEmbeddingsBatch(clients.openai, embeddingInputs);
  const chunkEmbeddings = embeddings.map(toVectorString);
  embedSpan.end();

  // DB write
  const dbSpan = startSpan('db-write', { input: { chunkCount: chunks.length } });
  const { data, error } = await clients.supabase.rpc('document_create', {
    p_name: props.name,
    p_domain: props.domain,
    p_document_type: props.document_type,
    p_project: props.project ?? null,
    p_protection: props.protection ?? 'open',
    p_owner_type: props.owner_type ?? 'user',
    p_owner_id: props.owner_id ?? null,
    p_is_auto_load: props.is_auto_load ?? false,
    p_content: props.content,
    p_description: props.description ?? null,
    p_content_hash: hash,
    p_source_type: props.source_type ?? 'text',
    p_source_url: props.source_url ?? null,
    p_file_path: props.file_path ?? null,
    p_file_permissions: props.file_permissions ?? null,
    p_agent: props.agent ?? null,
    p_status: props.status ?? null,
    p_skill_ref: props.skill_ref ?? null,
    p_embedding_model_id: props.embedding_model_id ?? DEFAULT_EMBEDDING_MODEL,
    p_chunk_contents: chunkContents,
    p_chunk_embeddings: chunkEmbeddings,
    p_chunk_strategy: chunks[0]?.strategy ?? config.strategy,
    p_chunk_summaries: chunkSummaries,
    p_chunk_token_counts: chunkTokenCounts,
    p_chunk_overlap: config.overlapChars,
  });
  dbSpan.update({ output: { documentId: data } });
  dbSpan.end();

  trace.end();

  if (error) throw new Error(`Failed to create document "${props.name}" (${props.domain}/${props.document_type}): ${error.message}`);
  return data as number;
}
```

- [ ] **Step 3: Instrument updateDocument**

Replace the body of `updateDocument` (lines 88-124) with:

```typescript
export async function updateDocument(
  clients: IClientsProps,
  props: IUpdateDocumentProps,
  chunkConfig?: Partial<IChunkConfigProps>,
): Promise<void> {
  const config = { ...DEFAULT_CHUNK_CONFIG, ...chunkConfig };
  const hash = contentHash(props.content);

  const trace = startTrace('document-ingestion', {
    tags: ['ingestion', 'update'],
    metadata: { documentId: props.id },
    input: { contentLength: props.content.length },
  });

  // Chunk
  const chunkSpan = startSpan('chunking', { input: { contentLength: props.content.length } });
  const chunks = chunkText(props.content, config);
  const chunkContents = chunks.map(chunk => chunk.content);
  chunkSpan.update({ output: { chunkCount: chunks.length, avgChunkSize: Math.round(props.content.length / chunks.length) } });
  chunkSpan.end();

  // Enrich (LLM calls auto-traced)
  const enrichSpan = startSpan('context-enrichment', { metadata: { chunkCount: chunks.length, model: 'gpt-4o-mini' } });
  const enrichmentResults = await generateContextSummaries(clients.openai, chunks, props.content);
  const chunkSummaries = enrichmentResults.map(result => result.summary);
  const chunkTokenCounts = enrichmentResults.map(result => result.tokenCount);
  enrichSpan.end();

  // Embed (auto-traced)
  const embedSpan = startSpan('batch-embedding', { metadata: { chunkCount: chunks.length, model: 'text-embedding-3-small' } });
  const embeddingInputs = chunks.map((chunk, index) => chunkSummaries[index] + '\n\n' + chunk.content);
  const embeddings = await generateEmbeddingsBatch(clients.openai, embeddingInputs);
  const chunkEmbeddings = embeddings.map(toVectorString);
  embedSpan.end();

  // DB write
  const dbSpan = startSpan('db-write', { input: { chunkCount: chunks.length } });
  const { error } = await clients.supabase.rpc('document_update', {
    p_id: props.id,
    p_content: props.content,
    p_content_hash: hash,
    p_agent: props.agent ?? null,
    p_description: props.description ?? null,
    p_status: props.status ?? null,
    p_embedding_model_id: props.embedding_model_id ?? DEFAULT_EMBEDDING_MODEL,
    p_chunk_contents: chunkContents,
    p_chunk_embeddings: chunkEmbeddings,
    p_chunk_strategy: chunks[0]?.strategy ?? config.strategy,
    p_chunk_summaries: chunkSummaries,
    p_chunk_token_counts: chunkTokenCounts,
    p_chunk_overlap: config.overlapChars,
  });
  dbSpan.end();
  trace.end();

  if (error) throw new Error(`Failed to update document #${props.id}: ${error.message}`);
}
```

- [ ] **Step 4: Run the full test suite**

```bash
cd ~/repos/ledger
npx vitest run
```

Expected: all tests pass. The trace/span calls are no-ops in tests (Langfuse env vars are not set).

- [ ] **Step 5: Commit**

```bash
cd ~/repos/ledger
git add src/lib/documents/operations.ts
git commit -m "instrument ingestion pipeline with Langfuse traces and spans"
```

---

### Task 6: Wire Up CLI Entry Point

**Files:**
- Modify: `src/cli.ts`

The CLI needs to initialize observability at startup and flush traces on exit. Without the flush, the last batch of traces might be lost when the process exits.

- [ ] **Step 1: Add imports to cli.ts**

At the top of `src/cli.ts`, add:

```typescript
import { initObservability, shutdownObservability } from './lib/observability.js';
```

- [ ] **Step 2: Initialize observability before command parsing**

Add this line right before `program.parse()` (at the bottom of the file, before the program parses arguments):

```typescript
initObservability();
```

- [ ] **Step 3: Add shutdown hook**

Replace the existing `process.on('unhandledRejection', ...)` block with:

```typescript
process.on('unhandledRejection', (rejection) => {
  console.error(rejection instanceof Error ? rejection.message : String(rejection));
  process.exit(1);
});

// Flush pending Langfuse traces before exit
const shutdown = async () => {
  await shutdownObservability();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 4: Run the full test suite**

```bash
cd ~/repos/ledger
npx vitest run
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
cd ~/repos/ledger
git add src/cli.ts
git commit -m "wire observability init and shutdown into CLI entry point"
```

---

### Task 7: End-to-End Verification

**Files:** none (manual testing)

This task verifies the full pipeline works: Ledger ingests a document, the trace appears in the Langfuse dashboard with all expected spans.

- [ ] **Step 1: Ensure Langfuse is running**

```bash
cd ~/repos/ledger/docker/langfuse
docker compose ps
```

All 6 services should show "healthy".

- [ ] **Step 2: Build Ledger**

```bash
cd ~/repos/ledger
npm run build
```

Expected: clean build, no errors.

- [ ] **Step 3: Ingest a test document**

```bash
cd ~/repos/ledger
ledger add \
  --name "observability-test" \
  --domain general \
  --type reference \
  --content "This is a test document for verifying Langfuse observability integration. It should produce a trace with chunking, enrichment, embedding, and DB write spans."
```

Expected: document created successfully.

- [ ] **Step 4: Verify the trace in Langfuse dashboard**

Open `http://localhost:9100` and navigate to the **Traces** view. You should see a trace named `document-ingestion` with:

1. Root trace with tags `["ingestion", "create"]` and metadata showing the document name
2. Child span: `chunking` with input/output showing content length and chunk count
3. Child span: `context-enrichment` with metadata showing chunk count and model
4. Nested generations under enrichment: `document-summary` and `chunk-enrichment-*` with token counts
5. Child span: `batch-embedding` with metadata showing model
6. Nested generation under embedding with token counts
7. Child span: `db-write` with output showing document ID

Verify that token usage and cost are populated on the generation spans.

- [ ] **Step 5: Clean up test document**

```bash
cd ~/repos/ledger
ledger delete observability-test
```

- [ ] **Step 6: Test graceful degradation**

Temporarily remove the Langfuse env vars from `~/.ledger/.env` (comment them out), then run another ingestion:

```bash
cd ~/repos/ledger
ledger add \
  --name "observability-test-2" \
  --domain general \
  --type reference \
  --content "Testing that Ledger works without Langfuse running."
```

Expected: document created successfully, no errors. No new trace in Langfuse (because SDK is disabled).

Clean up:

```bash
ledger delete observability-test-2
```

Restore the Langfuse env vars in `~/.ledger/.env`.

- [ ] **Step 7: Run the full test suite one final time**

```bash
cd ~/repos/ledger
npm run build && npx vitest run
```

Expected: build succeeds, all tests pass.

- [ ] **Step 8: Final commit (if any fixes were needed)**

If any fixes were needed during verification, commit them:

```bash
cd ~/repos/ledger
git add -A
git commit -m "fix: address issues found during observability e2e verification"
```
