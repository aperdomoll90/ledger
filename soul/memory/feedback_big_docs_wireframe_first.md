---
name: Big docs: wireframe first, fill second
description: For long documents, write the skeleton/wireframe in one pass, then fill sections in a second pass. One-shot writes cause Claude to loop/freeze.
type: feedback
originSessionId: 5ae21354-8923-438d-a2c0-9c225d1aac72
---
Rule: When a document is going to be long (more than ~500 words or more than 3-4 top-level sections), always write the wireframe first: frontmatter, TOC, section headers with one-line purposes, and any table-of-contents or navigation. Stop. Let Adrian approve or adjust the structure. Then fill sections in a second pass.

Why: Writing long docs in a single pass causes Claude to get stuck in generation loops and occasionally freeze mid-document. Staged writing (wireframe then fill) avoids this failure mode entirely and also gives Adrian a structural review checkpoint before content commitment. Observed during brand-system-authoring research-guide.md Phase 1 where the 2-stage approach worked cleanly; recurring instruction because it applies to every long doc, not just that one.

How to apply: Before writing any doc longer than ~500 words, propose a 2-stage plan explicitly. Stage 1: scaffold (frontmatter + TOC + all section headers + stubs). Stage 2: fill. If producing multiple long docs in sequence, scaffold each one before filling any. Do not batch-fill multiple docs in one pass.
