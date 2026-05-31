---
name: Use longhand font properties, not the font shorthand
description: Adrian's CSS rule — write font-family / font-style / font-weight / font-size / line-height as separate declarations, never the cramming `font:` shorthand
type: feedback
originSessionId: 0ae94323-e42c-4fed-aba1-851786f9fe39
---
Do NOT use the `font:` shorthand property. Write each component as its own longhand declaration.

**Why:** Shorthand `font: italic 700 clamp(1.5rem, 4vw, 2.5rem)/1 'Roboto Slab', Georgia, serif;` is hard to read, hard to diff, hard to modify (changing one value means re-parsing the whole line), and easy to break (forgetting a required component resets the others to their initial values). Longhand is verbose but each property's role is obvious at a glance.

**How to apply:** Whenever assigning text properties on any element, break apart into separate declarations:

```css
/* DON'T */
.c-foo {
  font: italic 700 1rem/1.4 'Roboto Slab', Georgia, serif;
}

/* DO */
.c-foo {
  font-family: 'Roboto Slab', Georgia, serif;
  font-style: italic;
  font-weight: 700;
  font-size: 1rem;
  line-height: 1.4;
}
```

Order convention: font-family → font-style → font-weight → font-size → line-height. Other related properties (letter-spacing, text-transform, color) follow as separate declarations.

Applies to new CSS authoring AND when refactoring existing rules. Existing `font:` shorthand in legacy files can be migrated incrementally when touching those rules.

**Both font-size and font-weight should use design tokens, not raw values:**

```css
/* DON'T */
font-weight: 700;
font-size: 1.5rem;

/* DO */
font-weight: var(--bold-font-weight);
font-size: var(--xl-font-size);
```

Token naming follows the `<modifier>-<property>` pattern:
- `--xsm-font-size`, `--sm-font-size`, `--md-font-size`, `--lg-font-size`, `--xl-font-size`, `--2xl-font-size`, `--3xl-font-size`, `--4xl-font-size`
- `--light-font-weight` (300), `--regular-font-weight` (400), `--medium-font-weight` (500), `--semibold-font-weight` (600), `--bold-font-weight` (700)

For fluid responsive sizing, use `clamp(var(--token-min), <viewport-value>, var(--token-max))`. Don't use clamp with raw rem values.
