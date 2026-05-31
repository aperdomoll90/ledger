---
name: component CSS file naming convention
description: Two-tier file naming. Page-level CSS file name = section liquid file name (no prefix). Sub-component CSS = component-<scope>-<name>.css scoped or component-common-<name>.css reusable.
type: feedback
originSessionId: 48f770dc-b3fe-4615-806c-6c6b3eb418d3
---
CSS file naming follows two tiers:

**Tier 1 — Page-level CSS (section files):**
File name matches the section liquid file name exactly, no `component-` prefix and no scope prefix.

- `theme/sections/product-list-page.liquid` -> `theme/assets/product-list-page.css`
- `theme/sections/cart.liquid` -> `theme/assets/cart.css`
- `theme/sections/product.liquid` -> `theme/assets/product.css`

Rule: CSS and Liquid have the exact same name. This is the master/foundation stylesheet for the page section, holding the page-level BEM block (e.g. `.c-product-list-page`) and its element children.

**Tier 2 — Sub-component CSS (rendered inside pages):**
File name is `component-<scope>-<name>.css` for page-scoped, `component-common-<name>.css` for reusable.

- Page-scoped (lives only on one page surface): `component-plp-grid.css`, `component-plp-hero.css`, `component-plp-filter-side-drawer.css`, `component-home-hero.css`.
- Reusable (used across multiple pages): `component-common-header.css`, `component-common-footer.css`, `component-common-pagination.css`, `component-common-toggle-switch.css`.

**BEM block names:**
Block name = file's `<name>` segment unless there's a collision. Scope prefix only when two BEM blocks would otherwise collide (e.g. `c-home-hero` vs `c-collection-hero` after a PLP hero introduced ambiguity). Don't pre-add scope prefix to BEM blocks defensively; wait for the actual collision.

**Why:**
- The page-level file matching the section file name signals "this IS the page's master stylesheet" instead of "this is one component among many." Page-level layout, sticky bars, body grid, drawer/backdrop wiring live here naturally.
- The `component-<scope>-<name>` prefix on sub-components forces a deliberate decision: is this reusable or page-bound? `common-` files communicate reusability at a glance.
- Filename = block name keeps onboarding low-friction. A new contributor reading the markup sees `c-filter-side-drawer` and knows to open `component-plp-filter-side-drawer.css`.

**How to apply:**
- New section: CSS file name = section liquid name. Both live next to each other in their respective directories.
- New sub-component: ask "is this used on multiple pages?" If yes, `component-common-<name>.css`. If no, `component-<scope>-<name>.css`.
- If a component starts page-scoped but later gets reused, rename to `component-common-<name>.css` and update its `stylesheet_tag` references.
- Two distinct components on the same page get two files (hero + grid each have their own). Don't merge "for the same feature."

Locked 2026-05-18 during the Starbrite Shopify PLP cleanup pass (S7). Supersedes the prior single-tier "component-<scope>-<name>" rule.
