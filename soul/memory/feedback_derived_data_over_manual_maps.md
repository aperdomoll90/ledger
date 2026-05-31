---
name: derived-data-over-manual-maps
description: Prefer deriving relationships from data via filters/transforms over hardcoded lookup tables. Manual maps are a smell when the platform already encodes the relationship.
type: feedback
originSessionId: 153998ce-dbcc-4988-8b49-eb1502f2a913
---
When two pieces of data are already related by a deterministic transform the platform exposes (e.g., `collection.handle` is the `handleize` of a facet value `label`; URL slugs are the lowercase-hyphenated form of titles; metafield keys are namespaced versions of admin names), derive the relationship in code rather than maintaining a manual lookup table or hardcoded list.

**Why:** Manual maps encode information that already exists in the system. They go stale, drift from the underlying data, and require code edits for taxonomy growth that should be data-only changes. Adrian called this out directly in the Starbrite PLP work on 2026-05-19 (Session 81): rejected a `'boating|Boating,rv|RV,...'` map because the same relationship was already available via `value.label | handleize == collection.handle`. Manual maps are the lowest-quality version of a production solution.

**How to apply:** Before writing a lookup table, switch statement, or hardcoded value list, ask: "Is this relationship already implicit in data the system gives me?" If yes, derive via filters (`handleize`, `downcase`, `split`, `replace`), system fields (`collection.handle`, `request.path`, `product.metafields.*`), or back-references in the data model. Hardcoded values are acceptable only when expressing *intent* (e.g., "these two filter types are the implicit-eligible ones"), not *data* (e.g., "the boating handle maps to the Boating label"). When in doubt, name what the hardcoded value is — if it names data, derive it; if it names a decision, keep it.
