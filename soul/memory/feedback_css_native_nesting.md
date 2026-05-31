---
name: css-native-nesting-default
description: CSS native nesting is the default form for pseudo-classes, pseudo-elements, attribute/state selectors, and descendant relationships within a single block. Top-level flat selectors stay only for cross-component relationships.
type: feedback
originSessionId: 153998ce-dbcc-4988-8b49-eb1502f2a913
---
When writing or editing CSS in any Adrian project, **nest selectors that belong to the same block under that block via `&`**. Flat top-level selectors stay only for cross-component relationships where nesting would create artificial coupling.

**Why:** Reduces duplication; co-locates all states/variants/descendants of a block in one place; matches the "Vanilla CSS with native nesting" rule in project CLAUDE.md files. Adrian explicitly formalized this as a standing behavior on 2026-05-20 (Starbrite S82) after observing repeated flat-sibling refactors. Manual conversion every time was friction; making it the default removes that.

**How to apply:**

| Form                                | Nest as                                                          |
|-------------------------------------|--------------------------------------------------------------------|
| `.foo:hover`                        | `.foo { &:hover { ... } }`                                        |
| `.foo::before`, `.foo::after`       | `.foo { &::before { ... } }`                                      |
| `.foo[data-open='true']`            | `.foo { &[data-open='true'] { ... } }`                            |
| `.foo[data-open] .bar`              | `.foo { &[data-open] .bar { ... } }` (cross-element state owned by .foo) |
| `.foo .bar` where .bar lives only inside .foo | `.foo { .bar { ... } }` or `.foo { & .bar { ... } }`     |
| `.foo .bar svg`                     | `.foo .bar { svg { ... } }` or `.foo .bar { & svg { ... } }`      |

**Keep flat:**
- Cross-component descendants where both are independent blocks: `.c-grid .c-card { ... }` — `.c-card` is its own block, not a member of `.c-grid`.
- Sibling combinators that reach across blocks: `.foo + .bar`.
- Shared selectors targeting multiple unrelated blocks.
- `@media` overrides at the bottom of a stylesheet (per `feedback_breakpoints_single_block.md` — that rule wins; do not nest @media inside per-block rules).

**Edge case — modifiers:**
BEM modifiers like `.c-foo--toggle` and `.c-foo--price` are usually kept flat as their own top-level rules, since they describe variants of the block and might be co-styled (e.g., `.c-foo--toggle .c-foo__inner`). Nesting `&--toggle` inside `.c-foo` is also valid but slightly less scannable for variant-heavy components. Default: flat for modifiers; nested for everything else.
