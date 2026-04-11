# Production RAG System — API Layer

> How agents and applications interact with the RAG system. Covers protocols, standard tool set, and design principles. Companion to `reference-rag-system-architecture.md` which provides the system overview.

---

## Protocols

| Protocol | What it is | When to use |
|---|---|---|
| **MCP (Model Context Protocol)** | Standard protocol for AI agents to call tools. Agent sees tool descriptions and calls them by name with typed parameters. | When your RAG system is used by AI agents (Claude, GPT, etc.) |
| **REST API** | HTTP endpoints (GET /search, POST /documents, etc.) | Web apps, mobile apps, scripts, integrations |
| **SDK / Library** | Direct function calls in code | Same-language applications, backend services |
| **CLI** | Command-line interface | Admin tasks, scripts, cron jobs, manual operations |

## Standard Tool Set

A production RAG API typically exposes:

| Category | Tools |
|---|---|
| **Search** | Hybrid search (default), vector-only search, keyword-only search, smart context retrieval |
| **CRUD** | Create document, update content, update fields, delete, restore |
| **Read** | List documents (with filters), get by ID, get by name |
| **Eval** | Log feedback, run eval suite, get metrics |
| **Admin** | Cleanup cache, purge deleted docs, re-embed documents |

## Design Principles

- **Validation at the boundary** — validate all input with schemas (Zod, JSON Schema) before it reaches internal code
- **Protection checks** — enforce document protection levels (immutable, protected, guarded) before mutation operations
- **Error handling** — structured error responses, never raw exceptions to clients
- **Thin wrappers** — API tools are thin. Business logic lives in the library layer or database, not in the API handler
