---
name: feedback-shopify-theme-blocks-explicit-types
description: "Shopify theme block + static section schema gotchas not caught by theme-check (lint passes, upload fails) — explicit block type lists vs @theme wildcard, presets vs default mutual exclusion"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8c389a53-bb8a-4634-a042-953d8aecb9fc
---

## Gotcha 1: @theme wildcard rejected in block schemas

When declaring nested blocks in a Shopify theme block's schema, use an explicit list of block types. Do NOT use `{ "type": "@theme" }` as a wildcard.

**Why:** During the starbrite-shopify PDP specs-drawer build (Session 18), `accordion.liquid` and `tab.liquid` were authored with `"blocks": [{ "type": "@theme" }]` (the pattern shown in the unused dawn `group.liquid` scaffold and Shopify's docs). Theme-check (`npm run check`) passed cleanly. But `npm run dev` upload to the partner dev store rejected both with `Invalid block '@theme': type is already taken`. The dawn scaffold uses the same pattern but is never referenced anywhere, so its schema is never validated by an actual upload. Lint passes; server upload fails.

**How to apply:**
- In any `theme/blocks/<name>.liquid` schema, the `blocks` array MUST list specific types: `"blocks": [{ "type": "accordion" }, { "type": "text-block" }, ...]`.
- All referenced block types must exist as files in `theme/blocks/` before being referenced. Otherwise theme-check throws "block type does not exist" errors.
- When building a block library incrementally (planning sequence), build leaf blocks first, then update parent blocks' schemas as each new child lands. Or build all blocks first and add references in a final pass.
- The same lesson applies to section schemas: `disabled_on`, `presets`, and `blocks` all need explicit references; wildcards rejected.
- Theme-check is a useful lint authority but NOT equivalent to Shopify's server-side schema validation. The only reliable end-to-end check is `npm run dev` upload.

## Gotcha 2: cannot declare both `presets` and `default` in the same section schema

A section is either *dynamic* (insertable via "Add section" in the customizer, declares `presets`) OR *static* (rendered via `{% section 'name' %}` in layout/templates, declares `default` for initial blocks). Shopify rejects schemas with both keys, even though theme-check accepts both.

**Why:** The starbrite-shopify `pdp-specs-drawer` section was authored with both `presets` (carried over from generic section-schema templates) and `default` (to seed initial tab blocks). Upload rejected with `Invalid schema: cannot define both 'default' and 'presets'`.

**How to apply:**
- Section statically rendered in `theme.liquid` via `{% section 'name' %}`: use `default: { blocks: [...] }` to seed initial state. NO `presets`.
- Section addable via template JSON + customizer "Add section" button: use `presets: [{ name: ..., blocks: ... }]`. NO `default`.
- The mental model: `presets` is "templates to instantiate this section FROM"; `default` is "what this single static instance STARTS WITH". A section can be either pattern, never both.

## Gotcha 3: `default.blocks` cannot have nested `blocks` arrays

The `default` schema on a static section can seed the section's top-level blocks (e.g. 3 tab blocks for our specs-drawer). But the BLOCK entries inside `default.blocks` cannot themselves declare a nested `blocks` array. Only `type`, `id`, and `settings` are valid inside a `default.blocks[]` entry.

**Why:** During the starbrite-shopify PDP specs-drawer build, the section schema's `default.blocks[]` declared each tab with a nested `blocks` array (an accordion inside Product Info, text-blocks inside each tab). Upload rejected with `Invalid default: invalid block type 'tab': 'blocks' is not a valid attribute`. Shopify treats `default` as flat — initial state for the section's direct children, not the whole nested tree.

**How to apply:**
- `default.blocks[]` entries: only `type`, `id` (optional), and `settings`. No nested `blocks`.
- The merchant adds nested content (accordion children inside a tab, text-blocks inside an accordion) via the customizer after first render. There is no schema-side way to pre-populate nested theme blocks for a static section.
- If you want richer initial state, write directly to `config/settings_data.json` under `current.sections.<id>.blocks` — but that file is auto-managed by the theme editor, so this is fragile.

## Gotcha 4: `default.blocks[].settings` rejected for theme-block types in static sections

A static section can declare `default.blocks` with section-INLINE block types (blocks defined inside the section's own schema), but cannot meaningfully seed THEME BLOCK types (blocks living in `theme/blocks/<name>.liquid`). Upload rejects with `cannot include settings because there are no settings defined`, even though the theme block's own `.liquid` schema clearly defines settings.

**Why:** During the starbrite-shopify specs-drawer build, dropping nested blocks (gotcha 3) was not enough. Even a flat `default.blocks[].settings` on the `tab` theme block was rejected. Shopify's `default` validator appears not to resolve theme blocks' external schema for the purpose of pre-seeding, while runtime rendering via `{% content_for 'blocks' %}` does resolve them. The dichotomy: theme blocks are merchant-managed at edit time, not theme-developer-seedable at install time.

**How to apply:**
- Static sections that use theme blocks must ship with NO `default` schema. Their blocks list starts empty.
- The merchant adds the initial blocks once via the customizer's "Add block" button inside the section. Shopify writes them to `config/settings_data.json` under `current.sections.<id>.blocks`. After that one-time setup, the section is permanently populated.
- DO NOT manually edit `config/settings_data.json` to pre-seed. The file is auto-managed by the theme editor; manual edits get overwritten on next save.
- If you genuinely need install-time seeded blocks for a section that uses block-style children, the only path is to abandon theme blocks and use SECTION-DEFINED blocks (inline `blocks: [...]` in the section's own schema). That gives up theme-block reusability across sections but enables `default` seeding.

## General principle

Theme-check is a useful lint authority but does not catch all schema mistakes. Shopify's server-side validation is stricter. After any section/block schema change, the only reliable end-to-end check is `npm run dev` upload + observe Shopify CLI's error stream.
