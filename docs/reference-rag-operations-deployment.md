# Production RAG System — Deployment & Infrastructure

> How to run a RAG system reliably in production. Covers components, scheduled maintenance, backups, environment configuration, and health checks. Companion to `reference-rag-system-architecture.md` which provides the system overview.

---

## Components to Deploy

| Component | What it is | How it runs |
|---|---|---|
| **Database** | Postgres + pgvector with tables, indexes, functions, RLS | Hosted (Supabase, AWS RDS, Neon) or self-hosted |
| **MCP / API server** | The API layer that agents call | Process on server, stdio transport (MCP), or HTTP server (REST) |
| **Embedding API** | External service or self-hosted model | Cloud API (OpenAI, Voyage) or local (Ollama, BGE-M3) |
| **Cron jobs** | Scheduled maintenance tasks | System cron, GitHub Actions, or database scheduled jobs |

## Scheduled Maintenance

| Job | Frequency | What it does |
|---|---|---|
| **Cache cleanup** | Daily or weekly | Remove query cache entries unused for N days |
| **Version cleanup** | Weekly | Keep only last N content versions per document |
| **Soft-delete purge** | Daily | Hard-delete documents past grace period (e.g., 30 days) |
| **Audit partition** | Yearly | Create next year's audit_log partition |
| **Eval run** | Weekly or on-change | Run golden dataset, compute metrics, compare to baseline |

## Backup Strategy

| What | How | Frequency |
|---|---|---|
| **Database** | pg_dump or managed backup (Supabase automatic) | Daily |
| **Embeddings** | Stored in database, included in database backup | With database |
| **Golden dataset** | In database + version-controlled export | With database + git |
| **Config / secrets** | Environment variables, not in code | Separate secrets backup |

## Environment Configuration

All configuration via environment variables:

| Variable | What |
|---|---|
| `DATABASE_URL` or `SUPABASE_URL` | Database connection |
| `SUPABASE_SERVICE_ROLE_KEY` | Database authentication (replace with per-agent JWT in production) |
| `OPENAI_API_KEY` | Embedding API |
| `EMBEDDING_MODEL` | Which model to use (default in database, override here) |
| `RERANKER_API_KEY` | Reranking service (if using cloud reranker) |

## Health Checks

| Check | What it verifies | Frequency |
|---|---|---|
| Database connection | Can reach Postgres | Every request / every 30s |
| Embedding API | OpenAI/Voyage responds | Every 5 minutes |
| Search function | Run a test query, verify non-empty results | Every 5 minutes |
| Disk/storage | Database size within limits | Daily |
