#!/usr/bin/env node
import { runCli } from './cli/program.js';
runCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`yylo-benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
