---
name: Reference docs keep short usage annotations on schema fields
description: In schema reference docs, short annotations about what's used, not used, or misused at the project level belong inline on the interface fields; they serve the audit and are not opinion bleed
type: feedback
originSessionId: ea047e6d-57f1-4fca-bcc1-f6974a26d887
---
Reference-layer schema docs (e.g. `reference-product-schema.md`, `reference-collection-schema.md`) should keep short observational annotations on each field that note:

- What the field is used for at the project level
- Whether it's used at all (e.g. "null for ALL 160 Starbrite collections, zero automation")
- Whether it's used incorrectly or in a non-standard way (e.g. "at Starbrite these are 5-digit SKU numbers only, never categorical labels")
- Simple counts and distributions that inform later audit decisions

These are not opinion bleed. They are facts-plus-usage-context that make the schema doc useful for later audit, migration planning, and "which fields do we actually care about" decisions.

**Why:** Adrian clarified this on 2026-04-22 when I proposed stripping all Starbrite-specific annotations from `reference-collection-schema.md` based on a strict reading of CLAUDE.md's three-layer rule. His words: "small comments like 'null for ALL 160 Starbrite collections, zero automation' are ok since [they help] later understanding the data; we need to make clear what being used or not in the schema currently, and if is used wrong maybe is ok as long [as it is] short and informative for later audit."

**How to apply:**

- Keep annotations short (one line, one clause).
- Keep them factual: "all 160 collections have ruleSet: null" is fact; "this catalog needs automation" is opinion.
- "Used wrong" is OK when it's observational: "tags are SKU numbers, not categorical labels" is a usage observation. "Tags should be rewritten" is an opinion.
- Counts, distributions, null/empty breakdowns are all in scope.
- Do NOT extend to recommendations, prioritization ("CRITICAL GAP for Phase 2"), or proposed fixes. Those go in opinion docs.
- Applies to reference-layer docs across all projects, not just Starbrite.

**What counts as opinion bleed (keep out):**

- Prioritization: "CRITICAL GAP", "THE column we care about"
- Recommendations: "should be rewritten", "needs cleanup"
- Future-tense framing: "for Phase 2 validation", "when we migrate"

**What counts as in-scope usage context (keep in):**

- Current state: "all 160 have ruleSet: null"
- Misuse: "tags are SKU numbers, never categorical labels"
- Non-use: "not used at Starbrite"
- Schema drift: "98 null + 62 empty string, same effect"
- Distribution counts: "135 BEST_SELLING, 25 MANUAL"
