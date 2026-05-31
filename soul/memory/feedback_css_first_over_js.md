---
name: prefer CSS over JS whenever both can do the job
description: When implementing UI behavior (animations, visibility toggles, state-driven styling), use CSS as the default. Reach for JS only when CSS genuinely can't express the behavior
type: feedback
originSessionId: 06392a40-770d-4b91-b72f-740be80dc822
---
When implementing UI behavior — animations, visibility toggles, state-driven styling, hover effects, focus rings, transitions, layout shifts — **default to CSS**. JS only when CSS can't express the behavior at all.

**Why:**
- CSS is declarative, faster to read, runs on the compositor (60fps animations without main-thread cost).
- JS for purely-visual behavior bloats the controller with state that CSS already tracks via attributes/classes.
- CSS-driven UI degrades gracefully (works even if JS fails to load); JS-driven UI doesn't.

**How to apply:**
- For visibility toggles tied to state: use `[data-open="true"]` + CSS rules instead of `element.hidden = true/false` in JS.
- For animations tied to state changes: CSS `transition` or `animation` on the relevant property, triggered by the same `[data-*]` attribute the rest of the component already uses. No `requestAnimationFrame` orchestration in JS.
- For staggered reveals: per-element `transition-delay` in CSS (set inline via `style.setProperty('--index', i)` from JS if the count is dynamic). Don't run a JS loop with `setTimeout`.
- For hover/focus/active styles: pseudo-classes (`:hover`, `:focus`, `:focus-within`, `:active`), never JS event listeners.
- For responsive behavior: `@media` queries, never `window.innerWidth` checks in JS.
- For "show this when that is hovered": adjacent-sibling or `:has()` selectors, never JS event delegation.

**JS keeps:**
- Data fetching and async coordination (the actual search call, AbortController).
- Event handlers that must run logic (input event → debounce → adapter call).
- DOM mutation that depends on response data (rendering result list items).
- Attribute toggles that drive CSS state (set `data-open="true"`; let CSS animate from there).

**The rule:** if the only thing JS would do is "add a class" or "toggle visibility", that's a CSS job. Set the attribute once from JS; let CSS do the rest.
