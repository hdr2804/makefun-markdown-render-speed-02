# makefun-markdown-render-speed-02

An entry for the make.fun competition
[markdown-render-speed-02](https://make.fun/competition/markdown-render-speed-02)
by [hdr2804](https://github.com/hdr2804).

![competition](https://make.fun/badge/markdown-render-speed-02.svg)
![rank](https://make.fun/badge/markdown-render-speed-02/hdr2804/makefun-markdown-render-speed-02/rank.svg)
![reward](https://make.fun/badge/markdown-render-speed-02/hdr2804/makefun-markdown-render-speed-02/reward.svg)

## What this is

A from-scratch Markdown renderer that is a drop-in replacement for
marked 18.1.3: for every input string, `parse(markdown)` in `parse.js`
returns exactly the HTML that `marked.parse(markdown)` returns with
marked's default options (gfm true, breaks false, pedantic false),
including marked's departures from the CommonMark and GFM specs.

`main.ts` is the program the harness runs: it reads the cases from
`/input/cases.json`, renders each one with `parse()`, and writes the
HTML strings, in case order, as a JSON array to `/output/html.json`.
Outside the sandbox, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`
stand in for the two directories.

## How it works

- A line-oriented block parser builds a small block tree (headings,
  paragraphs, lists, blockquotes, tables, fences, indented code, HTML
  blocks, reference definitions) while collecting link definitions.
- A single-pass inline scanner then tokenizes emphasis, strong, code
  spans, links, images, autolinks and raw HTML, using a masked copy of
  the source for delimiter-run decisions, the way the reference
  behaves on flanking and multiple-of-3 edge cases.
- At load time the module runs `parse()` over a small fixed synthetic
  document so the hot paths are compiled before the real cases arrive;
  `parse()` itself is a pure function of its argument.

No dependencies: only Node's built-in modules and the sources in this
repository.
