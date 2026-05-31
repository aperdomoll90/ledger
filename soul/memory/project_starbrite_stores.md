---
name: Starbrite Shopify store URLs
description: Shopify store handles for the Starbrite engagement — Adrian's Partner dev store vs the client's production store
type: project
originSessionId: 0ae94323-e42c-4fed-aba1-851786f9fe39
---
**Adrian's Partner dev store:** `perdomo-studio-dev.myshopify.com`
- Used for: Phase 1-4 theme development, hot-reload via `shopify theme dev`, `npm run dev` target in the starbrite-shopify repo
- Adrian is the owner (Partner account)
- May or may not have sample products seeded; check before assuming product / collection routes have data to render

**Client production store:** `starbritedev.myshopify.com`
- This IS the live production store (confirmed by Adrian 2026-05-11). The "dev" suffix is legacy naming, not a separate staging environment.
- Used for: pulling existing themes into `archive/` (historic artifact), eventual push of the new theme (when ready + approved)
- Adrian does NOT have staff access as of 2026-05-11; needs invite from Turner + Bob with "Themes" or "Develop" permission scope
- Until staff access is granted, the `_pull:client` npm script in the repo stays commented out and `archive/` stays empty

**Push policy:**
- All push scripts in the repo use `--unpublished` to avoid auto-publishing on either store
- Pushing to the client store requires explicit Adrian confirmation; never run from agent autonomy
- Live publish only via the Shopify admin UI, never via CLI
