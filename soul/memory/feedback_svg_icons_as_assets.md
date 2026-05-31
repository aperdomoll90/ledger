---
name: SVG icons live in assets, not snippets
description: Store SVG icons as `.svg` files in `theme/assets/`, reference via `{{ 'name.svg' | inline_asset_content }}`; snippets are reserved for Liquid markup with dynamic logic, locale calls, or composition
type: feedback
originSessionId: 06392a40-770d-4b91-b72f-740be80dc822
---
SVG icons are static markup with no Liquid logic. They belong in `theme/assets/` as `.svg` files, not in `theme/snippets/` as `.liquid` files. Reference them inline via Shopify's `inline_asset_content` filter:

```liquid
{{ 'icon-magnifier.svg' | inline_asset_content }}
```

The filter inlines the raw SVG markup at render time, preserving `currentColor` stroke inheritance and CSS sizing on a wrapper element. Functionally identical to `{% render 'icon-name' %}` but with cleaner separation.

**Why:**
- File extension matches content. `.svg` is an SVG; `.liquid` implies Liquid logic.
- Designers can edit and replace `.svg` files directly without needing to know Liquid.
- The `snippets/` directory stays semantically meaningful (markup with composition, locale, or conditional logic), not a dumping ground for static assets.
- Same `currentColor` / CSS sizing benefits as the snippet approach.

**When to apply:**
- Any SVG that is pure static markup (icon glyphs, decorative shapes, logos as SVG) goes in `theme/assets/`.
- Snippets stay for Liquid that does something Liquid-only: localized labels (`{{ 'key' | t }}`), composition (`{% render %}`), conditionals, loops, asset-URL filters.

**Stripping when moving from snippet to asset:** the old snippet often has a leading `{%- comment -%}...{%- endcomment -%}` block describing the icon. Strip that when moving to `.svg` (SVG files don't take Liquid comments). Keep only the `<svg>...</svg>` markup. Keep all SVG attributes (`viewBox`, `fill`, `stroke`, `aria-hidden`, etc.).

**Wrapper element pattern:** when inlining via `inline_asset_content`, wrap in a span/div that sets the icon's size (`width: 1rem; height: 1rem;`) so the SVG fills the wrapper via the standard `& svg { width: 100%; height: 100%; }` rule. The SVG's intrinsic size (~300x150 default) is otherwise unconstrained.
