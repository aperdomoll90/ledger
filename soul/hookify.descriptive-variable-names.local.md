---
name: require-descriptive-variable-names
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.tsx?$
  - field: new_text
    operator: regex_match
    pattern: (?:const|let|var)\s+[a-z]\s*[=;,)]|(?:const|let|var)\s+(?:pct|avg|cnt|num|len|idx|val|tmp|ret|res|arr|obj|str|fn|cb|el|ev|buf|cur|acc|prev|src|dst|msg|err|req|rsp)\s*[=;,)]|(?:map|filter|reduce|find|some|every|forEach|flatMap)\(\s*(?:\(?\s*[a-z]\s*\)?|[a-z])\s*=>|(?:map|filter|reduce|find|some|every|forEach|flatMap)\(\s*(?:\(?\s*(?:pct|avg|cnt|num|len|idx|val|tmp|ret|res|arr|obj|str|fn|cb|el|ev|buf|cur|acc|prev|src|dst|msg|err|req|rsp)\s*\)?|(?:pct|avg|cnt|num|len|idx|val|tmp|ret|res|arr|obj|str|fn|cb|el|ev|buf|cur|acc|prev|src|dst|msg|err|req|rsp))\s*=>|\(\s*[a-z]\s*,|\,\s*[a-z]\s*\)\s*=>|\(\s*(?:pct|avg|cnt|num|len|idx|val|tmp|ret|res|arr|obj|str|fn|cb|el|ev|buf|cur|acc|prev|src|dst|msg|err|req|rsp)\s*,|\,\s*(?:pct|avg|cnt|num|len|idx|val|tmp|ret|res|arr|obj|str|fn|cb|el|ev|buf|cur|acc|prev|src|dst|msg|err|req|rsp)\s*\)\s*=>|\(\s*[a-z]\s*:\s*\w
---

**Non-descriptive variable name detected in TypeScript.**

The reader shouldn't need to translate your variable name into what it actually means. Use names that communicate intent.

**Single-letter violations:**

| Bad   | Good                         |
|-------|------------------------------|
| `r`   | `result`                     |
| `m`   | `miss`, `metric`             |
| `n`   | `node`, `count`              |
| `s`   | `score`, `status`            |
| `e`   | `error`, `event` (never `e`) |
| `i`   | `index` (never `i`)          |
| `d`   | `doc`, `data`                |

**Abbreviation violations:**

| Bad    | Good            |
|--------|-----------------|
| `pct`  | `percentage`    |
| `avg`  | `average`       |
| `cnt`  | `count`         |
| `num`  | `number`        |
| `len`  | `length`        |
| `idx`  | `index`         |
| `val`  | `value`         |
| `tmp`  | `temporary`     |
| `ret`  | `returnValue`   |
| `res`  | `result`        |
| `arr`  | `items`, `list` |
| `obj`  | name the thing  |
| `str`  | name the thing  |
| `fn`   | name the thing  |
| `cb`   | `callback`      |
| `el`   | `element`       |
| `ev`   | `event`         |
| `buf`  | `buffer`        |
| `cur`  | `current`       |
| `acc`  | `accumulator`   |
| `prev` | `previous`      |
| `src`  | `source`        |
| `dst`  | `destination`   |
| `msg`  | `message`       |
| `err`  | `error`         |
| `req`  | `request`       |
| `rsp`  | `response`      |

**Note:** Abbreviations as *prefixes* of longer names are fine — `avgResponseTimeMs`, `prevRun`, `errMessage` are descriptive.

**User preferences:**
- Loop iterators: always `index`, never `i`
- Event handlers: always `event`, never `e`
- Catch blocks: always `error`, never `e`
- Unused parameters: use `_` prefix with a name: `_unused`

Rewrite with descriptive names that make the code readable without tracing back to the source.
