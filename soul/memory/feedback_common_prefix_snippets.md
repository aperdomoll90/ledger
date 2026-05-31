---
name: common-prefix snippet naming pairs with component-common-*.css
description: Liquid snippets that pair with `component-common-<name>.css` get `common-<name>-*.liquid` naming so the snippet and its stylesheet are visibly part of the same component
type: feedback
originSessionId: 06392a40-770d-4b91-b72f-740be80dc822
---
Liquid snippets paired with a `component-common-<name>.css` stylesheet take the matching `common-<name>-*.liquid` filename prefix. Examples:

- `theme/assets/component-common-search.css` pairs with `theme/snippets/common-search.liquid`, `common-search-suggestions.liquid`, `common-search-facets.liquid`, etc.
- `theme/assets/component-common-header.css` would pair with `common-header.liquid` if a header snippet ever existed.

The pattern is: `<scope>-<name>-<part>.liquid`, where `<scope>` matches the CSS file's scope (`common` for reusable across the site, page-scope like `plp` for page-specific).

**Why:** Reading a flat `theme/snippets/` directory, the prefix instantly tells you which component family a file belongs to and where to find its stylesheet. `search.liquid` is ambiguous (is it the icon? the form? a section?). `common-search.liquid` is unambiguous: it's the reusable search component whose styles live in `component-common-search.css`.

**How to apply:** When creating a new snippet for a component that has (or will have) a `component-common-<name>.css` file, use `common-<name>.liquid` for the root snippet and `common-<name>-<part>.liquid` for sub-snippets. The bare `<name>.liquid` is reserved for snippets without a paired stylesheet (e.g. `image.liquid`, `meta-tags.liquid`, `cta.liquid`).

**Legacy drift to ignore unless explicitly cleaning up:** older snippets like `c-pagination.liquid` and `c-toggle-switch.liquid` predate this rule and use the `c-` prefix. They should eventually rename to `common-pagination.liquid` / `common-toggle-switch.liquid` plus all their `{% render %}` call sites, but that's a separate cleanup pass, not a piggyback on unrelated work.
