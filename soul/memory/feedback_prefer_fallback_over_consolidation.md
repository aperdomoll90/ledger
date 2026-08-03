---
name: feedback-prefer-fallback-over-consolidation
description: "On customer-facing critical paths, Adrian chooses keeping a native fallback engine over consolidating onto one third-party dependency"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e205f680-5926-4350-af57-53caca84aaa7
  modified: 2026-07-27T21:02:21.028Z
---

When a customer-facing critical path (category navigation, search, checkout) depends on a third-party service, Adrian's instinct is to keep the platform-native implementation alive as a fallback rather than consolidate onto the single dependency. In the 2026-07-27 Starbrite PLP work I recommended retiring Shopify's native Search & Discovery filtering because the half-migrated state was incoherent; he asked "should we just keep it as a fallback if searchanise fails?" and that was the better call.

**Why:** consolidation optimizes for tidiness, redundancy optimizes for the customer still being able to shop at 2am when a vendor's API is down. He weighs the second higher. In that case the vendor had already failed three distinct ways on the project (`EMPTY_API_KEY`, `ENGINE_REMOVED`, `SEARCH_DATA_NOT_IMPORTED`), so the base rate was not hypothetical.

**How to apply:** when I catch myself recommending "one system should own this" for anything a customer touches, present the redundancy option alongside it and cost it honestly rather than dismissing it as complexity. Check first whether an arbitration seam already exists; in that case it did, which made the fallback far cheaper than I estimated. And when adding a second implementation next to an existing one, audit *every* existing arbitration point, not just the obvious one: scoping that audit to clicks alone left the Back button and the mobile Apply button firing both engines at once. See [[feedback_production_grade_solutions]].
