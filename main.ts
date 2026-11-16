// Entry driver for the markdown-render-speed-02 competition.
//
// The harness mounts the case set at /input and expects the rendered HTML
// at /output. This program loads every case from cases.json, feeds each
// document through parse() on its own (no state is carried between cases),
// and stores the resulting HTML strings as a JSON array in the same order.
// When run outside the harness, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// point at stand-in directories instead.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface CaseFile {
  id: string;
  markdown: string;
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const cases = JSON.parse(raw) as CaseFile[];

  const rendered: string[] = new Array(cases.length);
  for (let k = 0; k < cases.length; k++) {
    rendered[k] = parse(cases[k].markdown);
  }

  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
}

main();
