---
name: project_starbrite_folder_structure
description: How Starbrite project files are organized on disk; three concerns split, four-category naming convention in base research docs
type: project
originSessionId: f1f562a6-aca3-4234-84e8-1914a3a487b1
---
Starbrite working docs live at `~/Documents/Starbrite Working Docs/Brand designing/` with three concerns split into folders, plus `scripts/` and `old/`.

**Concern folders:**

- **`base research docs/`** — immutable source material and factual reference docs. Never contains opinions. Uses a 4-category naming convention (see below). Has its own `README.md` index.
- **`client facing/`** — polished deliverables for Starbrite (findings + recommendations, design system, site organization, audit findings brief).
- **`internal working docs/`** — scaffolding, drafts, working notes, decision parking lots (architecture reference, brand inputs, client meeting prep, Instincts migration parking lot).
- **`scripts/`** — generator scripts that produce files in `base research docs/` (Python stdlib only).
- **`old/`** — archived and superseded versions.

**Four-category naming in `base research docs/`** (applied 2026-04-22):

| Prefix        | Category          | Editable?                             | Examples                                                                                                         |
|---------------|-------------------|---------------------------------------|------------------------------------------------------------------------------------------------------------------|
| `raw-`        | Raw data (JSON)   | Never                                 | `raw-products-taxonomy-metafields.json`, `raw-api-product-type-schema.json`                                      |
| `source-`     | Source material   | Only when external source changes     | `source-starbrite-site-verbatim-quotes.md`                                                                        |
| `audit-`      | Audit baseline    | Never overwrite, new baselines = new file with date | `audit-accessibility-baseline-2026-04-21.md`, `audit-ui-review-baseline-2026-04-20.md`               |
| `reference-`  | Derived reference | Regenerate or hand-update             | `reference-product-schema.md`, `reference-collection-schema.md`, `reference-shopify-store-architecture.md`, `reference-metafield-frequency-analysis.md` |

Plus one client-provided file that keeps its original name as a provenance signal: `Star brite Star Tron Brand Voice.md`.

**Frontmatter required on all `.md` files in `base research docs/`:** title, type, topic, project, source, updated, status, regenerate, related. Full template in the folder's `README.md`.

**Raw Shopify GraphQL exports (the TXT files from GraphiQL):** `~/Documents/queries from shopify/` (peer folder, NOT under Working Docs). Contains the raw query exports before consolidation.

**Why:** Adrian split by concern to prevent overwriting source material. Within base research docs the 4-category prefix was added after the folder grew enough that "which kind of doc is this" was no longer obvious from the filename. Prefix also makes `ls` naturally sort docs by category.

**How to apply:**
- When creating a new reference doc in `base research docs/`, use the `reference-` prefix and add full frontmatter.
- When pulling new raw data, use the `raw-` prefix and save as `.json` (not `.txt`).
- When running a new audit, use `audit-` prefix with a date in the filename; never overwrite an older baseline.
- New client-facing or internal docs go in their respective sibling folders, not in `base research docs/`.
- If a generator script writes into `base research docs/`, it must produce the frontmatter as part of its output (see `scripts/metafield_frequency_analysis.py` for the pattern).
- Read the folder's `README.md` for the current file index before assuming a file exists or what it contains.
