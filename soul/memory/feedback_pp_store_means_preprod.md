---
name: feedback-pp-store-means-preprod
description: "In Starbrite context \"pp store\" abbreviates \"preprod\" (starbrite-preprod.myshopify.com), NOT Perdomo Studio dev. Don't assume from initials."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 871b965e-8bae-47ed-b248-5ffa00a8e029
---

When Adrian says "pp store" in Starbrite Shopify work, he means **preprod** = `starbrite-preprod.myshopify.com` (the dedicated Star brite preprod dev store), NOT `perdomo-studio-dev.myshopify.com` (the Perdomo Studio dev store).

**Why:** I assumed "pp" was an abbreviation of "Perdomo Studio" because that store comes up frequently in memory and CLAUDE.md. The actual abbreviation is "pre-prod". Adrian corrected me on 2026-06-11 when I queried sandbox instead of preprod.

**How to apply:** When Adrian says "pp store" / "pp" in Starbrite work, use `SHOPIFY_STORE=preprod` (resolves to `starbrite-preprod.myshopify.com`) in `scripts/lib/store.mjs`. If the context is ambiguous, confirm before running the API call rather than after. See [[project-starbrite-stores]].
