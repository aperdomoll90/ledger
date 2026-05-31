---
name: liquid snippet and section files have no c- prefix
description: Shopify theme Liquid files (sections, snippets) are named with the base component name; the `c-` prefix lives only on CSS class names inside the file
type: feedback
originSessionId: 06392a40-770d-4b91-b72f-740be80dc822
---
Liquid section and snippet files in `theme/sections/` and `theme/snippets/` are named with the bare component name (e.g. `search.liquid`, `search-input.liquid`, `product-card.liquid`, `nav-menu.liquid`). The `c-` prefix never appears in file names. CSS classes inside the file still use the prefix: `.c-search`, `.c-search__input`, `.c-product-card`.

**Why:** The `c-` prefix is short for "class" (CSS class). Putting it on a file name reads as "class-search.liquid", which is meaningless. The file IS the component, it's not itself a class. Existing convention is already visible in the repo (`snippets/icon-search.liquid`, `sections/header.liquid`).

**How to apply:** When naming any new section, snippet, or block in a Shopify theme, drop the `c-` from the file name. Render calls match the file name: `{% render 'search-suggestions' %}` loads `snippets/search-suggestions.liquid`. CSS file naming follows the separate `component-common-<name>.css` rule and is unaffected.
