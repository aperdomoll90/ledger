---
name: project-starbrite-bv-styling-portal-only
description: "Bazaarvoice widget styling is done in the BV Configuration Hub Style Editor, never in theme CSS"
metadata: 
  node_type: memory
  type: project
  originSessionId: 01975b25-cbc6-43e8-b60c-f707f35fdfa8
  modified: 2026-07-31T21:58:52.867Z
---

On Starbrite, all Bazaarvoice widget styling (reviews, ratings, Q&A, inline ratings on product cards) is configured in the BV Configuration Hub Style Editor. Adrian's decision, 2026-07-31: do not style BV components from theme CSS.

The one existing BV rule in `theme/assets/main.css` (`div[data-bv-show] { display: block !important }`) is a hydration fix from BV's own Shopify integration guide, not styling, and stays.

Consequence to accept: BV styling values live in the vendor portal, outside git, and cannot be diffed or code-reviewed. Design tokens cannot be referenced, so every value is a literal that must be hand-updated if the palette changes. BV's font dropdown is a fixed web-safe list, so Tuna and Rubik are unavailable and the nearest sans has to be chosen instead.

Token values to type into the portal (BV takes px): text `#1D1D1F`, mid `#4A4A4A`, muted `#595959`, navy `#0A2240`, yellow `#F4E726`, border `#E0DDD5`, surface `#F7F5F0`. Sizes 11 / 13 / 16 / 20 / 24 / 32. Radii 2 / 6 / 8 / 14 / 32. Spacing 4 / 8 / 16 / 24 / 32 / 48. Source of truth is `theme/snippets/css-variables.liquid`. Related: [[project-starbrite-consolidation]].
