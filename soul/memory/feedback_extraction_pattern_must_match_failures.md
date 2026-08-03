---
name: feedback-extraction-pattern-must-match-failures
description: "A regex or selector used to gather evidence must be permissive enough to match the malformed cases, or it confirms the wrong hypothesis"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e205f680-5926-4350-af57-53caca84aaa7
  modified: 2026-07-27T21:42:07.143Z
---

When writing a regex, selector, or query to gather evidence about a suspected data problem, it must be permissive enough to match the MALFORMED cases. A pattern derived from the documented convention will only ever confirm the convention.

**Why:** on 2026-07-27 I diagnosed a Starbrite PDP gallery bug using `/files/([0-9A-Za-z_\-]+\.[0-9A-Za-z]{1,6}\.(?:jpg|png|webp))`. The `{1,6}` bound on the middle segment silently dropped every filename carrying Shopify's `_<uuid>` collision suffix, which was exactly the set carrying the defect. I showed Adrian a clean five-image list and called it the gallery; it was a subset. The fix I then wrote sorted on the raw segment and would have shipped looking correct while changing almost nothing. A reviewer caught it against the real CSV export.

**How to apply:** before drawing a conclusion from an extraction, sanity-check the match COUNT against an independent number (rendered element count, row count in an export, a total the UI states). If they disagree, the pattern is lying. Prefer running the permissive version first and narrowing after, rather than encoding the expected shape up front. Same failure shape as a `:not([attr])` selector that goes dead when the attribute spreads: an assumption baked into a matcher, failing closed and silently. See [[feedback_prefer_fallback_over_consolidation]].
