---
name: class_rename_search_js_too
description: When renaming CSS class names across a codebase, search both static markup AND JavaScript strings (className =, innerHTML, template literals). Static-markup-only sweeps leave orphan references in JS-generated elements.
type: feedback
originSessionId: 9f3a101e-dfc1-4c08-90ce-38aa04e3d72e
---
When refactoring class names in any codebase, a `grep` of static markup (HTML class attributes, JSX `className=`) is not sufficient. JavaScript code that creates DOM elements at runtime holds class names as string literals in:

- `el.className = '...'`
- `el.innerHTML = '<div class="...">...</div>'`
- `document.createElement(...)` followed by `.classList.add('...')`
- React / Vue / Svelte template strings and JSX expressions
- Any string that gets assembled into HTML

A rename script that operates only on static class attributes will silently leave these orphan references unchanged, and they will fail to pick up the new CSS rules.

**Why:** This bit twice during the Starbrite PLP refactor (Session 67, 2026-05-07). First time: `c-fp__product` markup orphaned after renaming to `c-featured-product__product`. Second time: chip-creation JS still emitted `<span class="chip">` and `<span class="x">` after the static markup rename swept `.chip` to `.c-product-grid__chip` and `.x` to `.c-product-grid__chip-dismiss`. Both were caught at visual review, not at the rename step.

**How to apply:** Before declaring any class-rename refactor done, grep the OLD name across the whole file (or repo) and inspect every match. JS template strings, string concatenation, and dynamic class assignment will not match a CSS-attribute-scoped regex but will be caught by a plain text search. For multi-file refactors, run a final `rg '<old-name>'` (or equivalent) across the whole tree.
