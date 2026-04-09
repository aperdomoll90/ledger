# Ledger Architecture - S37 Rate Limiter Update

This file contains the updated architecture content that needs to be synced to Ledger document #137 (ledger-architecture) via sync-local-docs.ts.

## Changes from S34 to S37

1. **New section: Rate Limiter** - Added between TypeScript and MCP Tools sections
2. **Updated System Layers diagram** - Added [Rate Limiter] markers in Ingestion and Search layers
3. **Updated TypeScript module table** - Added rate-limiter.ts as 6th module
4. **Updated RAG Pipeline** - Added [Rate Limiter] markers at each external API call
5. **Updated Repo Structure** - Added rate-limiter.ts, reranker.ts, sync-local-docs.ts
6. **Updated eval baseline** - Run 14 numbers (from run 12)
7. **Updated test count** - 212 tests (from 126)
8. **Updated Cross-cutting concerns** - Added "Rate Limiting" to the list

## Rate Limiter Section (new)

Provider-agnostic proactive rate limiting using Bottleneck. Prevents 429 (Too Many Requests) errors by controlling request flow before they reach external APIs. Added in Session 37 after S36 bulk sync failure.

Two layers of defense:
1. Proactive pacing (Bottleneck): token bucket with reservoir, concurrency cap, minimum spacing
2. Reactive retry (OpenAI SDK built-in, maxRetries: 5): catches any that slip through

Two singleton instances:
- openaiLimiter (OpenAI): shared by generateEmbedding() and generateContextSummaries()
- cohereLimiter (Cohere): used by rerankResults() (idle until reranker re-enabled)

Adaptive header reading: reads x-ratelimit-remaining-requests from OpenAI response headers after each call.

Spec: docs/superpowers/specs/2026-04-09-rate-aware-api-client-design.md
