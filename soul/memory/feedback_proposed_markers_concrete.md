---
name: proposed_markers_must_carry_concrete_starters
description: In brand-system-authoring and similar doc-authoring skills, {{PROPOSED}} markers must contain actual concrete starter values, never meta-descriptions like "draft at fill time"
type: feedback
originSessionId: 56aa9d41-a85a-4fdc-a2c9-23f3818b0da1
---
When authoring docs with the three-marker system ({{PLACEHOLDER}} / {{TODO}} / {{PROPOSED}}), never write a {{PROPOSED}} marker that says "draft at fill time" or "propose value at fill time." That is a meta-marker, not a proposal.

A {{PROPOSED}} marker must contain a real, specific, reactable starter value that the stakeholder can accept, adjust, or reject. The whole point of {{PROPOSED}} over {{TODO}} is that reacting to a concrete value is faster than answering an abstract question.

This applies to wireframe / scaffold mode too, not just fill-pass mode. Adrian's "wireframe first, fill second" rule means "thin-but-real content, reviewed before deeper fill," not "structure with meta-markers everywhere."

**Why:** Adrian corrected this at §0.1 of the Starbrite design system doc (S49, 2026-04-21). A {{PROPOSED}} with "draft at fill time" asks the stakeholder to imagine a proposal that doesn't exist yet, which is the same burden as a {{TODO}} and therefore defeats the point of the PROPOSED tier.

**How to apply:** Every {{PROPOSED}} in a produced doc must be concrete. If a value cannot be defensibly inferred from source material yet, use {{TODO}} instead — don't hide indecision behind PROPOSED meta-text. Only three legitimate states for any gap: a concrete proposal, a stakeholder-gated question, or a genuine pass-through placeholder.
