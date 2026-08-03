---
name: feedback-invoice-email-template
description: "Standard Starbrite invoice email: no hours/rate/total in the body, one plain-language paragraph of what the week covered"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 286edb85-9bd4-4d81-9cf5-9ed2e5f22f1d
  modified: 2026-08-03T16:59:36.698Z
---

Standard shape for invoice emails, set 2026-08-03 on SB-2026-014. Five parts, nothing else:

1. `Hi Turner, Kouri,`
2. `Attached is invoice {NUMBER} for the week of {Month DD} through {Month DD}.` No hours, no rate, no total. Those live in the attached invoice only.
3. One paragraph of what the week covered, in plain language a non-developer reads without stopping. Name the outcome, not the mechanism. Group the parts of a single feature in parentheses rather than listing them as separate items.
4. `A full breakdown by day is included in the invoice.`
5. `Happy to walk through any of it on Thursday.` (the standing Thursday 2:30 PM client call)

Then the standard signature per [[feedback-email-signature]].

**Why:** the dollar figure repeated in the body makes the email read as a demand for money rather than a report of work delivered. The invoice already states it, so restating it adds nothing and changes the tone. Adrian removed it explicitly.

**How to apply:** keep legal questions, decisions needed from the client, and anything contentious OUT of the invoice email; raise those on the Thursday call instead, where they can actually be discussed. Write the summary paragraph at the reading level of the [[feedback-invoice-email-plain-language]] standard: no vendor jargon, no internal component names, no acronyms. Routing is Turner + Kouri, Bob as needed, per [[Starbrite project contacts]].

**Canonical example (SB-2026-014):**

```
Hi Turner, Kouri,

Attached is invoice SB-2026-014 for the week of July 27 through July 31.

This week covered the enhanced product content block for product detail pages
(before-and-after slider, image carousel, expert testimonials and video section),
a fix for the production category pages that were showing no products, a feature
flag system so unfinished work can ship without being visible to shoppers, and
cookie consent handling for the Bazaarvoice review widgets, which is now live and
verified on the production site.

A full breakdown by day is included in the invoice.

Happy to walk through any of it on Thursday.

Best,
Adrian Perdomo
Perdomo Studio
```
