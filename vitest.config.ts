import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { contentionBudgetMs } from './test/support/contention.js';

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

export default defineConfig({
  // Keep source-run tests on the same build-time version identity as dist so
  // the package-version guard proves the real published pipeline.
  define: { __YYLO_BENCHMARK_PACKAGE_VERSION__: JSON.stringify(packageVersion) },
  test: {
    // Real-Git acceptance cases can exceed Vitest's five-second default under
    // shared-host contention, turning ambient load into phantom candidate
    // failures. Budgets scale with measured load (clamped to [1,4]): exact
    // base on a quiet machine, bounded growth when oversubscribed.
    testTimeout: contentionBudgetMs(30_000),
    hookTimeout: contentionBudgetMs(30_000),
    // Security-boundary cases materialize and execute immutable interpreter
    // copies. Serialize files so concurrent filesystem/process stress cannot
    // turn the release gate into transient Linux ETXTBSY/pipe-reset failures.
    maxWorkers: 1,
    minWorkers: 1,
    // This lane is a merge-queue admission lane: refuse network sockets so
    // registry/API latency can never become candidate evidence.
    setupFiles: ['./test/support/contention.ts'],
  },
});
