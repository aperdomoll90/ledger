# Production RAG System — Security

> Threats and defenses specific to RAG systems. Untrusted content becomes LLM input, embeddings can leak information, and search can be weaponized for data extraction. Companion to `reference-rag-system-architecture.md` which provides the system overview.

---

**Why RAG security is different from regular app security:** In a traditional app, user input is the attack surface. In RAG, *stored documents* are also an attack surface because they get retrieved and fed to the LLM as context. An attacker who can insert a document can control what the AI says.

Full research: `docs/research/2026-03-31-rag-security-best-practices.md`

## Ingestion Security

| Threat | Defense |
|---|---|
| **Prompt injection in documents** — attacker embeds "ignore previous instructions" in a document. When retrieved, LLM follows it. | **Content sanitization:** scan for instruction-like patterns at ingestion. **Instruction hierarchy:** configure LLM to treat retrieved content as DATA, never INSTRUCTION (reduces success from 73% to 23%). |
| **Content poisoning** — insert misleading documents to degrade search quality. 5 poisoned docs in millions can achieve 90% attack success. | **Provenance tracking:** record who created each document, when, from what source. **Trust scoring:** weight results by source trustworthiness. **Embedding anomaly detection:** flag chunks with unusual embedding patterns. |
| **Malicious file uploads** — hidden content in PDFs, macro-laden Office docs, oversized files. | **Input validation:** magic byte verification, hidden content stripping, file size limits, content-type verification. |

## Retrieval Security

| Threat | Defense |
|---|---|
| **Data exfiltration** — sensitive content (API keys, PII, credentials) leaks through LLM responses. | **Content classification at ingestion:** flag documents containing sensitive data. **PII redaction:** detect and redact before sending context to LLM (tools: Microsoft Presidio). **Retrieval guardrails:** post-retrieval, pre-LLM check. |
| **Bulk extraction** — attacker crafts queries to systematically extract all stored content. | **Rate limiting:** cap queries per agent per hour. **Extraction detection:** monitor for semantic similarity between consecutive queries (systematic scanning pattern). |

## Output Security

| Threat | Defense |
|---|---|
| **Hallucination with authority** — LLM invents information and presents it as if it came from a retrieved document. | **Groundedness checking:** verify answer claims against retrieved context via NLI model or LLM-as-judge. Flag unsupported claims. |
| **Sensitive data in responses** — even if retrieval is filtered, the LLM may include data it shouldn't. | **Output scanning:** post-generation filter for PII, credentials, instruction leakage. **Canary tokens:** dummy documents in corpus. If LLM outputs their content, retrieval is leaking. |

## Infrastructure Security

| Threat | Defense |
|---|---|
| **Credential exposure** — database keys, API keys leaked or hardcoded. | **Secrets management:** all credentials in environment variables or Vault/KMS. Never in code. Rotation schedule. |
| **Unencrypted data** — vectors and content readable if database is breached. | **Encryption:** AES-256 at rest, TLS 1.3 in transit. Supabase handles this by default. |
| **Shared service key** — one key with full access used by all agents. | **Per-agent authentication:** JWT or API key per agent. Principle of least privilege. |
| **Audit tampering** — modifying audit entries to cover tracks. | **Audit immutability:** append-only RLS policy, no UPDATE/DELETE even for service_role. Optional: cryptographic hash chaining. |

## API & Cost Security

| Threat | Defense |
|---|---|
| **Cost attack** — flood searches to burn embedding/LLM API credits. | **Rate limiting:** per-agent, per-hour caps. **Cost-aware throttling:** track actual spend per query, pause agent if budget exceeded. |
| **MCP tool abuse** — agent calls delete in a loop or bulk-modifies content. | **Rate limiting on writes.** **Protection levels** on sensitive documents. **Confirmation gates** on destructive operations. |

## Supply Chain Security

| Threat | Defense |
|---|---|
| **Embedding provider sees your data** — every document sent to OpenAI/Cohere for embedding. | **Self-host embedding model** for sensitive data (BGE-M3, all-MiniLM). **Zero-data-retention agreements** for cloud providers. |
| **LLM provider sees retrieved context** — all search results sent as context during generation. | **Zero-data-retention agreements.** **Data classification:** don't retrieve highly sensitive docs for general queries. |
| **Model version drift** — provider updates model, embeddings change silently. | **Pin model versions.** **Track embedding_model_id per chunk.** **Verify checksums** on model artifacts. |

## Defense-in-Depth Architecture

Security at every layer, not just at the perimeter:

```
Ingestion:    Content sanitization → Input validation → Provenance tracking
                                          ↓
Storage:      Encryption at rest → RLS → Audit immutability
                                          ↓
Retrieval:    Rate limiting → Pre-filter permissions → PII redaction
                                          ↓
Generation:   Instruction hierarchy → Groundedness check → Output scanning
                                          ↓
API:          Per-agent auth → Rate limiting → Cost tracking
```
