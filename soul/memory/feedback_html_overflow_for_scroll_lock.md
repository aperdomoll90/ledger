---
name: feedback-html-overflow-for-scroll-lock
description: "body-only overflow lock is a silent no-op; html is the default scroll container in modern browsers, so lock both"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9f9ef73a-af32-445d-9ab8-0c4bc05ba20a
---

For background scroll-lock when opening a modal / drawer / overlay, ALWAYS set `overflow: hidden` on BOTH `document.documentElement` (`<html>`) and `document.body`. Body-only is silently wrong.

**Why:** in modern browsers (post-2010-ish) `<html>` is the default scroll container, not `<body>`. The pattern of `document.body.style.overflow = 'hidden'` is a fossil from older browsers and now silently does nothing. Discovered on Starbrite PLP drawer (2026-06-17 S52): the JS had been setting body.overflow since shipped, and the page kept scrolling behind the drawer the whole time.

**How to apply:**

JS path (always do both):
```js
document.documentElement.style.overflow = open ? 'hidden' : '';
document.body.style.overflow = open ? 'hidden' : '';
```

CSS-only path (belt-and-suspenders, requires `:has()`):
```css
:root:has(.some-element[data-open='true']),
body:has(.some-element[data-open='true']) {
  overflow: hidden;
}
```

Also applies to: `position: fixed` on html/body for iOS Safari touch scroll-bubbling, but that's a separate stronger fix. For desktop + Chrome mobile-emulation, plain overflow on both elements works.
