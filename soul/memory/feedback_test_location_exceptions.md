---
name: test-location-exceptions
description: CLAUDE.md says tests live next to source (foo.ts → foo.test.ts). Exception: npm libraries that have packaging/path conflicts when tests are inline; for those, tests stay in a top-level ./tests/ folder. Currently applies to the Ledger repo.
type: feedback
originSessionId: a26d5284-835f-4a3c-9916-031a1a007742
---
The default rule is tests live next to source: `src/lib/foo.ts` becomes `src/lib/foo.test.ts`.

**Exception:** repos that are published as npm libraries can keep tests in a top-level `./tests/` folder when inline tests cause packaging conflicts (publish glob picks up tests, build output paths collide, dist layout breaks, etc).

**Currently applies to:**

- `~/repos/ledger/` (npm package `@aperdomoll90/ledger-ai`). Reason: inline tests created path conflicts with the library's public surface. All tests live in `~/repos/ledger/tests/`.

**Why:** Adrian explicitly called this out as an intentional repo-specific deviation, not drift from the rule.

**How to apply:**

- For new tests in Ledger: put them in `~/repos/ledger/tests/<name>.test.ts`, matching the existing pattern.
- For new tests in any other repo: default to next-to-source. Only deviate if you discover a similar packaging conflict, and even then ask Adrian first.
- If a future repo also turns out to be a published library with similar conflicts, ask whether to add it to this exception list.
