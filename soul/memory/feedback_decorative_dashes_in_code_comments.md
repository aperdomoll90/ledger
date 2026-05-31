---
name: Decorative dashes acceptable in code-comment dividers
description: The CLAUDE.md decorative-symbol ban does not apply to ─── dashes used as section dividers inside TypeScript/code-block comments in reference docs
type: feedback
originSessionId: ea047e6d-57f1-4fca-bcc1-f6974a26d887
---
Decorative `───` dashes are acceptable as section dividers inside TypeScript (or other code-block) comments in reference docs. The CLAUDE.md decorative-symbol ban targets prose, markdown headers, tables, and general user-facing output. In-code comment dividers are a different register and Adrian has explicitly opted to keep them.

**Why:** Adrian explicitly OK'd the `───` dashes in `~/Documents/Starbrite Working Docs/Brand designing/base research docs/interface Product.txt` on 2026-04-22, after I flagged them twice during a cleanup pass. His words: "those dashes are ok in this case."

**How to apply:** Do not flag, strip, or suggest removing `───` (or similar decorative dashes) that appear as section dividers inside code-block comments in reference docs (e.g. `// ─── Taxonomy axes ───`). The ban still applies everywhere else: prose output, markdown headers, tables, ASCII diagrams in prose, bullet markers, and general structured text outside code blocks.
