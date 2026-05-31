---
name: shopify-block-name-25char-limit
description: "Shopify section schema block \"name\" field has a hard 25-character limit; theme-check doesn't flag it but `shopify theme push` rejects with \"Invalid block: name is too long (max 25 characters)\"."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d5973165-c85b-4b7c-b505-05e20bbf19d9
---

Shopify section schema `blocks[*].name` field is capped at 25 characters. Theme-check does NOT validate this locally — it passes lint clean and only fails at `shopify theme push` time with the error: `Invalid block '<type>': name is too long (max 25 characters)`.

**Why:** Shopify's customizer UI reserves limited space for the block-type chip in the section editor. The validator runs server-side on push, not at lint time.

**How to apply:** When writing or editing block names in `{% schema %}` `blocks` arrays:
- Keep `name` to 25 chars or fewer. Count spaces and punctuation.
- Prefer descriptive but tight: "Drawer tab" (10), "Closer card with seal" (21), "Year card" (9).
- If naturally over 25, drop adjectives or use abbreviations: "Closer card (circular seal)" (27) → "Closer card with seal" (21).
- Same constraint plausibly applies to other Shopify schema string fields (section `name`, settings `label`); when in doubt, keep them tight.

Related to [[feedback_shopify_theme_blocks_explicit_types]] — both are constraints that show up only at upload time, not at theme-check. Verify with `shopify theme push` (or `npm run dev`'s live sync) as the canonical check.
