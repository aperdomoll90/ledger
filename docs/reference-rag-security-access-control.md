# Production RAG System — Access Control

> How to ensure agents and users only see documents they're authorized to access. Covers filtering patterns, authorization models, multi-tenant isolation, and implementation. Companion to `reference-rag-system-architecture.md` which provides the system overview.

---

**Key principle:** Enforce at retrieval time, **before** context reaches the LLM. If the AI sees unauthorized content, it may leak it in its response, even if you filter after generation.

## Filtering Patterns

| Pattern | How | When to use | Tradeoff |
|---|---|---|---|
| **Pre-filter** | Add permission WHERE clauses to search queries | Large corpus, most docs restricted | Fastest. Unauthorized docs never searched |
| **Post-filter** | Retrieve top-K, then filter by permissions | Small corpus, most docs accessible | Simpler but may return fewer results than expected |
| **Row-Level Security** | Database policies enforce automatically on every query | pgvector/Postgres deployments | Strongest guarantee. Even raw SQL is filtered |

## Authorization Models

| Model | How it works | Best for |
|---|---|---|
| **RBAC (Role-Based)** | Assign roles (admin, editor, viewer), roles have permissions | Simple organizations with clear roles |
| **ABAC (Attribute-Based)** | Rules based on attributes (department=engineering AND clearance=high) | Complex policies, fine-grained control |
| **ReBAC (Relationship-Based)** | Permissions based on relationships (user → member of → team → owns → document) | Google Zanzibar model, social graphs |

## Multi-Tenant Isolation

| Level | How | Isolation strength | Cost |
|---|---|---|---|
| **Database per tenant** | Separate database for each tenant | Strongest, complete isolation | Highest. N databases to manage |
| **Schema per tenant** | Separate schema within one database | Strong, namespace isolation | Medium |
| **Row-level (RLS)** | Shared tables, policies filter by tenant_id | Standard, most common pattern | Lowest. One database |

## Implementation Pattern

```
1. Agent authenticates (JWT or API key)
2. System resolves: who is this agent? what can they access?
3. Search query includes permission filter:
   WHERE document_id IN (
     SELECT document_id FROM document_permissions
     WHERE principal_id = agent_id
   )
4. Only permitted documents appear in results
5. Context sent to LLM contains only authorized content
```

## Tools

| Tool | What it does |
|---|---|
| **Cerbos** | Policy-as-code, generates query plans for vector store filters |
| **OPA (Open Policy Agent)** | General-purpose policy engine |
| **Permit.io** | RBAC/ABAC/ReBAC with API |
| **Supabase RLS** | Built-in row-level security for Postgres/pgvector |
