---
name: skip-ceremony-when-pattern-exists
description: "When the codebase already implements the pattern, skip brainstorming/spec/plan and mirror it directly"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 24ff0c87-93c3-4dfa-98f1-22dbf4e6534b
  modified: 2026-07-21T20:20:56.545Z
---

When a request is "do X here the way we already do it elsewhere," skip the brainstorming -> spec -> writing-plans chain. Research the existing implementation, state the approach in a few lines, and build it.

**Why:** On the Star Tron landing animation (2026-07-21) I ran full brainstorming, wrote a spec doc, got approval on it, then started writing-plans, for what was applying the theme's existing `u-animation-*` / `revealOnScroll` pattern to five more sections. Adrian: "way too much brainstorming for such a simple action that is quite literally already implemented elsewhere just need to do the same." The superpowers skills default to the full chain regardless of scope, and CLAUDE.md's workflow sequence reinforces it, so the ceremony has to be actively cut short.

**How to apply:** Gate on novelty, not size. Full chain when the approach is genuinely undecided (new system, competing designs, unclear requirements). Direct implementation when a canonical in-repo implementation exists and the ask is to match it. The research step still happens (read the existing pattern properly, it is what prevents guessing) and so does verification, only the design-deliberation stages are dropped. Announcing "mirroring the pattern in <file>" is enough of a design statement. Sibling of [[feedback_simplest_solution_no_looping]] and [[feedback_reference_html_wins]]; those govern scope of the fix, this one governs scope of the process.

Corollary from the same session: build the element inventory by reading the markup, not by grepping class names. `grep -oE 'class="c-[a-z-]+'` flattens the DOM, turning parent-child pairs into peers, and misses classes passed across a `{% render %}` boundary. On animation work that distinction is the whole job, since transforms compose down the tree.
