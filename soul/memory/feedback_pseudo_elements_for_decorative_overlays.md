---
name: pseudo-elements for decorative overlays (backdrops, scrims, dividers, etc.)
description: For purely visual overlay elements (backdrops, scrims, dividers, decorative shapes), use CSS pseudo-elements (::before / ::after) on the parent component, not real DOM nodes
type: feedback
originSessionId: 06392a40-770d-4b91-b72f-740be80dc822
---
For purely visual elements that have no content, no children, and no interactive behavior, use CSS pseudo-elements (`::before` / `::after`) on the parent component instead of adding real DOM nodes.

**Targets the rule applies to:** backdrops, scrims, dim layers, overlay tints, decorative gradient bands, divider rules, drop-shadow elements, glyph approximations (like the CSS-drawn magnifier circle).

**Targets the rule does NOT apply to:** elements that hold content (text, icons, images), elements that need event listeners attached, elements that JS needs to manipulate or query.

**Why:**
- Markup stays focused on semantic content; decorative overlays don't pollute the DOM tree.
- Pseudo-elements can't be accidentally targeted by JS queries that walk the tree.
- One less element for the accessibility tree to traverse.
- Pseudo-elements support `position: fixed`, `inset`, `z-index`, transitions, animations — everything a `<div>` overlay needs.
- Smaller DOM, less Liquid markup, less to keep in sync.

**Common examples:**

```css
/* Backdrop behind a drawer / modal */
.c-component::before {
  content: '';
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--color-shadow) 40%, transparent);
  opacity: 0;
  pointer-events: none;
  z-index: calc(var(--c-component-z) - 1);
  transition: opacity 300ms ease-out;
}

.c-component[data-open="true"]::before {
  opacity: 1;
  pointer-events: auto;
}
```

```css
/* Decorative divider between sections */
.c-list-item::after {
  content: '';
  display: block;
  height: 1px;
  background: var(--color-divider);
}
```

**Constraint to remember:** one `::before` and one `::after` per element. If a component needs more than two decorative pseudo-elements, factor the structure differently (more BEM children) or accept the trade-off and use real `<div>`s. But for the common case of a single backdrop or single decorative shape, the pseudo-element approach is the default.
