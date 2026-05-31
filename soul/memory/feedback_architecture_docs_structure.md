---
name: Architecture document structure
description: Architecture docs use ASCII box diagrams for system overviews, arrow notation for data flows, tables for inventories — all inside plain code blocks
type: feedback
---

Architecture documents follow the patterns established in the Ledger docs (`docs/ledger-architecture-*.md`, `docs/reference-rag-system-architecture.md`):

**Diagram types (all ASCII inside ``` code blocks — no Mermaid, no dot):**
- **System overview** — box diagrams with `┌─┐│└─┘` borders showing pipelines and layers
- **Data flow** — arrow notation showing table relationships: `documents ──< document_chunks (1:N, CASCADE delete)`
- **Pipeline flow** — linear step chains: `Extract → Hash → Chunk → Enrich → Embed → Store`
- **ERD** — ASCII table relationships with cardinality and cascade behavior
- **Decision flows** — indented trees or numbered sequences with conditions

**Structure pattern:**
1. Title + one-line summary quote block
2. Table of contents with anchor links
3. Plain English overview — what it is, why it exists
4. System overview diagram (box diagram showing the full picture)
5. Inventory table — grouped by function/category, one-line purpose per item (e.g. the 13 tables grouped as Storage, Caching, History, Security, Ingestion, Evaluation)
6. Data flow diagrams between components
7. Detail sections — each inventory item gets its own section with full schema, examples, edge cases. The inventory is the map; the sections are the territory.

**Writing style:**
- Lead with plain English — explain *what it is* and *why it exists* before any technical detail. "Documents go in, get chunked and embedded for search, and every change is tracked" comes before column schemas.
- If a technical term is needed, explain what it means inline.
- For function/code explanations, use takes/does/returns table format instead of prose.
- Tables must be visually aligned — pad columns with spaces so `|` pipes line up vertically. Same for ASCII diagrams.
- TOC with anchor links for any doc longer than a few sections.

**Why:** Adrian wants to see the system visually before reading details, and understand the concept in plain language before diving into implementation. ASCII diagrams in code blocks work everywhere (terminal, VS Code, GitHub, Ledger) without rendering dependencies.

**How to apply:** Start with plain English summary, then overview diagram, then tables, then details. Use `┌─┐│└─┘` for boxes, `──>` for flows, aligned `|` tables for inventories. Keep diagrams inside plain ``` blocks — no language hint needed. Always include a TOC.
