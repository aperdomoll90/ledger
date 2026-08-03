---
name: no-theme-push-adrian-handles
description: "Never run shopify theme push / deploys; Adrian pushes himself. Build, verify, then signal \"ready to push\"."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6597cf20-f764-4888-b844-78e2bda1d7aa
---

Do NOT run `shopify theme push` (`npm run push`, `npm run push:preprod`, `--allow-live`, etc.) or any deploy. Adrian pushes himself, same as commits ([[commit-rules]]). Stated 2026-06-29 (after I pushed preprod on his explicit one-time request, he then said "ill push myself just let me know when is ready").

**Why:** pushes are visible/live actions Adrian owns. preprod theme 191060640112 is the live staging theme; pushing overwrites it. He wants control over when that happens.

**How to apply:** finish the work, run `npm run check` / `lint:css` / `lint:js` to verify clean, then tell him plainly "ready to push" (and which command, e.g. `npm run push:preprod`). Let him run it. Only push if he explicitly says "push it" for that specific instance, and even then prefer handing off.
