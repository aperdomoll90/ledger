---
name: announce-before-editing
description: Announce and get approval before making edits; never extend one approval to another scope
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cfe4098f-6747-4c7b-a44c-1456e620da6f
---

Reading, searching, querying, and analysis: proceed freely. But before making any file or code EDIT, state plainly what is about to change and where, and wait, do not edit-then-report. One approval covers only the exact change approved: approval for "the button" is NOT approval for the Lambda, the theme, the DB, or any other file/system. A new file or a different system is a new ask. Changes to client / production systems (e.g. the Starbrite store-finder Lambda in AWS account 618763541994, client Shopify theme) are ALWAYS an explicit ask, never inferred from a vague "yes."

**Why:** Adrian was frustrated (2026-06-24) that changes were made without asking or acknowledging: a Shopify button edit was made before the plan was explained (he had to ask for the plan after it was already done), and the store-finder Lambda query was changed off a vague "yes lets do it" that had followed a button-only approval. Both extended a narrow approval onto a different/higher-stakes scope.

**How to apply:** Default to announcing edits before doing them. Distinguish read-only work (fine to proceed) from mutations (announce first). When an instruction like "yes do it" is ambiguous about scope, confirm which files/systems it covers before editing. Relates to [[feedback_doc_changes_require_approval]] and [[feedback_simplest_solution_no_looping]].
