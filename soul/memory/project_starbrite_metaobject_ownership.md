---
name: project-starbrite-metaobject-ownership
description: "Prod's content metaobject types are owned by `Shopify Claude Connector App` (claude.ai App Store integration). Preprod blocks the CLI connector from `metaobjectDefinitionCreate` for ANY type name; need a Custom App via admin for write access. Sandbox is permissive."
metadata: 
  node_type: memory
  type: project
  originSessionId: 318e191e-5f36-496d-beea-8ee45d486932
---

Star brite's prod store (`starbritedev.myshopify.com`) has its content metaobject types (`event_recap_announcement`, `prodcut_deep_dive_how_to`, `seasonal_guide_checklist`, `standard_academy`, `destination_location_feature`, and the SBI_* family) owned by the `Shopify Claude Connector App` — the public Shopify App Store integration for claude.ai (`https://apps.shopify.com/bff99d4729d3501502622947a2d997c3`). Star brite installed this app and used claude.ai chat to author the metaobject content layer.

**Why:** I'm Claude Code, a different Claude. My Shopify CLI auth identifies as `Shopify CLI Connector App` (a generic dev-tool app), not the App Store Claude Connector. On preprod (`starbrite-preprod.myshopify.com`), the CLI Connector cannot create metaobject definitions at all — even for completely novel type names like `test_migration_xyz123` — Shopify returns `NOT_AUTHORIZED: "This type is reserved for use by another application."` Same auth context works fine on sandbox (`perdomo-studio-dev.myshopify.com`). Hypothesis: preprod is a higher-tier store (Plus or partner-organization-managed) that restricts metaobject ownership to first-class custom apps; sandbox is a Partner dev store with looser permissions.

**How to apply:** When migrating metaobject definitions or instances to preprod from Charlie, the CLI path won't work. Either (a) Adrian creates a Custom App via preprod admin > Settings > Apps and sales channels > Develop apps with scopes `read/write_metaobjects, read/write_content, read/write_files, read_products`, copies the Admin API access token, and Charlie posts GraphQL via `curl -H "X-Shopify-Access-Token: $TOKEN"` directly to `https://starbrite-preprod.myshopify.com/admin/api/<version>/graphql.json`; or (b) hand the migration to Kouri (current decision as of 2026-06-11 — he works in an unpublished theme copy on the store). Sandbox can be migrated normally via `shopify store execute --store perdomo-studio-dev.myshopify.com`. Prod is read-only to us via `read_metaobjects, read_content, read_files, read_products` scopes; we do not write to prod.

See also: errorlog entry `2026-06-11 (S44) | shopify-cli/metaobjects | metaobjectDefinitionCreate rejected on preprod` in `starbrite-shopify-errorlog` (#204). Architecture context in `docs/internal/starbrite-architecture-content-pipeline.md` section 7. Related: [[project-starbrite-stores]] for the three-store topology.
