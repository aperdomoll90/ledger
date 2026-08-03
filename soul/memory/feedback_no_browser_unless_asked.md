---
name: no-browser-unless-asked
description: Never launch or drive the browser (Chrome DevTools MCP) on my own initiative; only when Adrian explicitly tells me to
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0f4d8ac6-cb48-41c4-8024-529f65e6d2b7
---

Never open or use the browser / Chrome DevTools MCP (navigate_page, take_screenshot, take_snapshot, evaluate_script, lighthouse_audit, resize_page, etc.) on my own initiative. Only use it when Adrian explicitly asks for it in that message, e.g. "open the browser", "screenshot it", "verify in the browser", "run an audit on <url>", "check it live".

**Why:** it takes over his actual browser session and is intrusive/unwanted. He does the visual checking himself. Me opening it unprompted (e.g. to verify a CSS change or a new section) is exactly what he does not want, even when the dev server is already running.

**How to apply:** when I'd normally want to browser-verify a change, STOP. Verify instead via `npm run check` (theme-check), `npx stylelint`, `npm run lint`, and reading the code; then report status and, if visual confirmation matters, ask Adrian to look or wait for him to ask me to. Do not treat "the dev server is up" or "I just made a visual change" as license to open the browser. Relates to [[feedback_announce_before_editing]] and [[feedback_simplest_solution_no_looping]].
