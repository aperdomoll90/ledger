---
name: grid layout over sticky for fixed-frame headers and footers
description: For drawers/dialogs/dropdowns with a fixed frame, pin header and footer via grid-template-rows auto 1fr auto, never position:sticky
type: feedback
originSessionId: 06392a40-770d-4b91-b72f-740be80dc822
---
For any fixed-height container with header / body / footer zones (drawers, dialogs, modal panels, search dropdowns, sidebar shells), use `display: grid; grid-template-rows: auto 1fr auto;` on the parent and `overflow-y: auto` only on the middle row. Do NOT add `position: sticky` to the header or footer children.

**Why:** The grid track sizing already pins the header and footer in their tracks. The middle scrolls because only it has overflow. Adding sticky duplicates the layout intent, adds reflow cost, and breaks predictably when the parent is moved into a transformed or `contain`-ed ancestor. Adrian's project reaches for native CSS layout primitives over positioning tricks whenever both can do the job.

**How to apply:** Whenever a layout has a fixed-height frame with internal sections that must keep their place while content scrolls, reach for grid first. `position: sticky` stays acceptable for true sticky-on-scroll patterns inside a long flowing page (e.g. a sidebar nav that follows you down a doc), but never for "pin to top or bottom of a fixed-height frame."
