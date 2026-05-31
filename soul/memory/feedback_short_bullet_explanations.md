---
name: explain code in short bullets, not walkthroughs
description: When explaining what newly written code does, prefer 3-5 short bullets with a one-line "net effect" close. Avoid section-by-section narrative walkthroughs unless explicitly asked
type: feedback
originSessionId: 06392a40-770d-4b91-b72f-740be80dc822
---
When Adrian asks "explain what this does" about code, respond in a **short bulleted form**: 3-5 bullets at most, each one line. Lead each bullet with the name of the behavior or concept ("Debounce (250ms):", "AbortController:", "Open/close gate:"), then a single short sentence on what it does and why. Close with a one-line "net effect" or example.

**Why:** The longer walkthrough format (per-block explanation, per-function detail, t=ms tables) is too dense to skim. Adrian retains the short version, not the long one. He learned the input-handler pattern from the 4-bullet version after the 200-line walkthrough went straight past him.

**How to apply:**
- Default to bullets when explaining a small chunk of code.
- One line per bullet — no sub-points, no nested lists.
- The "why" is the strongest selling point of each behavior; keep that, drop the implementation specifics.
- Reserve walkthrough-style explanations for cases where Adrian explicitly asks for line-by-line detail or for tutoring sessions on new concepts he hasn't seen before.
- After the bullets, one closing line on the net visible effect or a tiny example. Stop there.
