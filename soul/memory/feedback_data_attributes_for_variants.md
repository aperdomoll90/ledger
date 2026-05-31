---
name: feedback_data_attributes_for_variants
description: "When a data-* attribute already serves as the JS hook AND CSS scoping selector for a section/component variant, drop the matching BEM modifier class — it's redundant"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ab9cc0c1-4f1a-4176-8ad3-25f82704a95e
---

When an element already carries a `data-X="<variant>"` attribute that's used by JS as a selector hook AND can serve as a CSS scoping selector, the matching `c-block__element--<variant>` BEM modifier class is redundant. Drop the modifier class; the CSS rule reads the data attribute instead.

**Why:** Audit of the starbrite-shopify search component found each section snippet carrying BOTH `c-search__section--<variant>` (BEM modifier) AND `data-search-section="<variant>"` (JS hook). Two of the four modifier classes were dead in CSS entirely; the other two were used by CSS rules that could just as easily be `[data-search-section="X"]` attribute selectors. The data attribute is already part of the markup contract (used by `collectElements` and by `collectVisibleRows` in the controller), so making CSS read it instead is single-source-of-truth.

**How to apply:** During code review of a section/component that exposes variants:
1. Grep for any `data-X="<variant>"` attributes already on the element
2. If found, grep for matching `c-block--<variant>` or `c-block__element--<variant>` modifier classes
3. If both exist, drop the modifier class from markup; rewrite the CSS rule from `.c-block__element--X` to `[data-X="X"]` (or compound `.c-block__element[data-X="X"]` if specificity matters)

**Caveat:** This applies when the data attribute already exists for OTHER reasons (JS hook, state machine). Don't ADD a data attribute just to drop a modifier class — that's worse than the BEM modifier per project rule 15a ("BEM modifier classes ARE used for true variants"). Only drop the modifier when the data attribute is already there doing other work.

**Related:** [[feedback_css_shorthand_resets_subproperties]] surfaced in the same session.
