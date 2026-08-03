---
name: feedback_data_attributes_for_variants
description: "Style component variants/states with data-* attributes (data-variant, data-height, etc.) and attribute selectors in CSS — NOT BEM modifier classes (c-block--variant). Applies even when adding the attribute fresh."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ab9cc0c1-4f1a-4176-8ad3-25f82704a95e
---

Adrian's default for component variants AND states is a `data-*` attribute on the element + an attribute selector in CSS — NOT a BEM modifier class. Use `data-variant="glossy"` with CSS `.c-block[data-variant="glossy"]`, not `c-block--glossy`. This applies whether or not a JS hook exists: **add the data attribute fresh if there isn't one.** Reach for `data-variant` for visual variants (glossy/vintage, primary/secondary), and the existing `data-*` state pattern (`data-open`, `data-height`, `data-align`, `data-selected`) for state.

**Why:** Adrian corrects this repeatedly. He had to flag it again mid-build (the staff trading-card got a `c-card--glossy` modifier class; he wanted `data-variant="glossy"`). Data attributes keep variant + state in one mechanism (one markup contract, flips cleanly from JS, reads cleanly in CSS via `[data-X]`), and avoid the modifier-class proliferation he dislikes.

**How to apply:** When building any component variant or state, default to `data-<name>="<value>"` on the element and `.c-block[data-<name>="<value>"]` in CSS (compound with the block class for specificity/scoping). Do NOT create `c-block--<variant>` modifier classes. The base `c-block` class stays the shared/unmodified look; variants layer on via the attribute.

**Supersedes:** This is broader than the original narrow reading (and broader than CLAUDE.md rule 15a's "BEM modifiers for variants" — Adrian's direct preference wins). The earlier caveat "don't ADD a data attribute just to drop a modifier" is reversed: adding the attribute IS the preferred path now.

**Related:** [[feedback_css_shorthand_resets_subproperties]], [[feedback_css_native_nesting]].
