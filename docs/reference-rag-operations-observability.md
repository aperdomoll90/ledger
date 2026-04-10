# Production RAG System — Observability

> What to monitor, how to track costs, and when to alert. Companion to `reference-rag-system-architecture.md` which provides the system overview.

---

## What to Monitor

| Metric | Why | Target | Alert when |
|---|---|---|---|
| **Search latency** (p50/p95/p99) | Is search fast enough? | p95 < 2s | p95 > 3s |
| **Embedding latency** | Is the API slowing down? | < 500ms | > 1s |
| **Cost per query** | Budget tracking | Track trend | Sudden spike or > budget |
| **Cost per day** | Total spend | Track trend | > 2x average |
| **Cache hit rate** | Is caching saving money? | 60-80% at maturity | < 40% |
| **Zero-result rate** | Are searches failing? | < 5% | > 10% |
| **Score distributions** | Are results high-quality? | Track median over time | Median drops > 20% |
| **Error rates** | Timeouts, API failures | < 1% | > 5% |
| **Embedding drift** | Has content meaning shifted? | Monthly check | Centroid shift > threshold |

## Cost Breakdown

For budgeting and optimization:

| Component | What to track | How to reduce |
|---|---|---|
| **Embedding API** | Tokens per day, calls per day | Query cache (60-80% hit rate), embedding cache for re-ingestion |
| **LLM generation** | Tokens per response, responses per day | Semantic response cache, smaller context windows, smart retrieval |
| **Database** | Storage size, query count | Cleanup jobs, archive old versions, purge soft-deletes |
| **Reranking API** | Calls per search (if using cloud reranker) | Only rerank top-K, not all results |

## Alerting Thresholds

| Severity | Condition | Action |
|---|---|---|
| **Warning** | p95 latency > 2s, cache hit rate < 50%, zero-result rate > 5% | Investigate at next opportunity |
| **Error** | API errors > 5%, cost spike > 3x daily average | Investigate immediately |
| **Critical** | Search completely failing, API key expired, database down | Page on-call / fix immediately |

## Tools

| Tool | What it does |
|---|---|
| **Langfuse** | Open-source tracing, cost tracking, RAGAS integration |
| **LangSmith** | End-to-end tracing, prompt playground, evaluation |
| **Arize Phoenix** | Embedding visualization, drift detection |
| **Datadog LLM Observability** | Enterprise dashboards, RAGAS evaluations built in |
| **Built-in** | `search_evaluations` table + periodic analysis script (no external tool needed) |
