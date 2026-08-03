---
name: feedback_no_verbose_comments
description: Do not write verbose multi-line explanatory comments in code; keep comments terse or omit them
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6405a0d9-cd8b-4873-bbe8-87aea5b2f080
---

Do NOT add multi-line explanatory comments to code, even for non-obvious "why". Adrian has asked repeatedly and finds them code bloat. A 5-6 line comment explaining a CSS technique (paint-order, cqi, preserveAspectRatio, etc.) is exactly the bloat he means. Keep the mechanism explanation in the chat message, not the file.

**Why:** verbose comments bloat the file and read as AI-generated padding. He wants clean, terse source.

**How to apply:** default to NO comment. If a line is genuinely cryptic, at most a short single-line note (a few words). Never a paragraph. Put the teaching/rationale in the conversation response instead. This strengthens [[feedback_no_obvious_comments]] and [[feedback_short_bullet_explanations]] (keep explanations in chat, short).
