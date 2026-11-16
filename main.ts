// Driver for the markdown-render-speed-02 entry.
//
// The harness starts this file with Node and hands it a directory of
// cases: cases.json holds a JSON array of { id, markdown } records.
// Every case is rendered on its own through parse() from ./parse.js and
// the HTML strings are written back, in the original case order, as a
// JSON array in html.json. Inside the grading sandbox the two
// directories are /input and /output; MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR override them for local runs.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

type Case = { id: string; markdown: string };

function renderAll(cases: Case[]): string[] {
  const html = new Array<string>(cases.length);
  for (let k = 0; k < cases.length; k++) {
    html[k] = parse(cases[k].markdown);
  }
  return html;
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const cases = JSON.parse(
    readFileSync(join(inputDir, "cases.json"), "utf8"),
  ) as Case[];
  writeFileSync(join(outputDir, "html.json"), JSON.stringify(renderAll(cases)));
}

main();
