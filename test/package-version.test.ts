import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PACKAGE_VERSION, createProgram } from '../src/cli/program.js';
it('uses the package version and exposes only the thin lifecycle', () => {
  expect(PACKAGE_VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
  expect(createProgram().commands.map((command) => command.name())).toEqual(['case', 'run', 'evaluate', 'report', 'disqualify']);
});
