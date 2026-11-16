# markdown-render-speed-02 — a faster drop-in for marked

[![competition](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02/)
[![rank](https://make.fun/badge/markdown-render-speed-02/hdr2804/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02/)
[![reward](https://make.fun/badge/markdown-render-speed-02/hdr2804/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02/)

My entry for the [markdown-render-speed-02](https://make.fun/c/markdown-render-speed-02/) competition on [make.fun](https://make.fun/).

`parse.js` is a dependency-free ES module whose `parse(markdown)` returns, for every input, exactly the HTML that marked 18.1.3's `marked.parse` returns with default options (GFM on, breaks off, pedantic off): the full CommonMark 0.31.2 block and inline grammar plus GFM tables, task lists, strikethrough and extended autolinks, reproduced behaviour for behaviour — delimiter-run emphasis resolution with the rule of three, reference links with case-folded labels, raw HTML blocks of every CommonMark type, nested lists and block quotes with lazy continuation, setext/table ambiguity, hard breaks, entities and escapes.

`main.ts` is the harness driver: it reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), renders each one with `parse()`, and writes the HTML strings as a JSON array to `/output/html.json` (or `$MAKEFUN_OUTPUT_DIR`).

## How it works

- A line-oriented block parser (indentation tracked in true tab columns) builds a small block tree; block quotes and list items gather their lines first — honouring group boundaries, lazy continuation and content-indent rules — and then recurse.
- A single-pass inline scanner emits text, pre-rendered and delimiter nodes; emphasis is resolved afterwards with a forward balance scan that mirrors marked's flanking, multiple-of-three and skip-span rules, over a masked copy of the text that hides code spans, escapes and reference-link text.
- `parse()` is pure per call: all state (link definitions, raw-text mode, autolink suppression) is created fresh for every document.
- Speed comes from plain-text run fast paths (block level and inside the scanner), first-character dispatch in the block parser, single-pass escaping, and memoized tail probes while gathering block quotes.

## Verification

Against the practice set the entry is byte-for-byte identical to marked on all 720 cases (680 spec examples and 40 generated documents), and it stayed identical on five further generator instances drawn from other seeds (3,600 more cases) and on roughly 150,000 adversarial fuzz documents mixing nested emphasis, reference links, entities, tables, task lists, raw HTML, nested lists/quotes, CRLF, tabs and missing final newlines.
