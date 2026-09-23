import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { prepareCase, freshDirectory, json } from '../v2/workspace.js';
import { runAttempt } from '../v2/adapters.js';
import { evaluate } from '../v2/evaluators.js';
import { AssessmentSchema, EvaluatorSchema, TreatmentSchema } from '../v2/contracts.js';
import { disqualify, draftLedgerCase, report, table } from '../v2/cli.js';

declare const __YYLO_BENCHMARK_PACKAGE_VERSION__: string | undefined;
export const PACKAGE_VERSION = typeof __YYLO_BENCHMARK_PACKAGE_VERSION__ === 'string' ? __YYLO_BENCHMARK_PACKAGE_VERSION__ : '0.0.0-unbuilt';
export function createProgram(options: { cwd?: string; stdout?: (text: string) => void } = {}): Command {
  const cwd = options.cwd ?? process.cwd(); const out = options.stdout ?? ((text: string) => process.stdout.write(text));
  const print = (value: unknown) => out(`${JSON.stringify(value)}\n`);
  const resolve = (value: string) => path.resolve(cwd, value);
  const program = new Command().name('yylo-benchmark').version(PACKAGE_VERSION)
    .description('Thin trusted-host task/workflow experiments and independent evaluations');
  const cases = program.command('case').description('Prepare a reviewed answer-free reusable case');
  cases.command('draft').requiredOption('--ledger-task <id>').option('--ledger-executable <path>', 'YYLO executable', 'yy')
    .action(async (opts: { ledgerTask: string; ledgerExecutable: string }) => print(await draftLedgerCase(opts.ledgerTask, cwd, opts.ledgerExecutable)));
  cases.command('create').requiredOption('--source <path>').requiredOption('--base <ref>').requiredOption('--prompt <file>')
    .requiredOption('--output <directory>').option('--reviewed', 'Confirm original requirements, historical base and answer exclusions were reviewed')
    .option('--reference <ref>').option('--ledger-task <id>').option('--workflow <tracked-path>')
    .option('--exclude <path>', 'Exclude answer-bearing source paths; repeatable', (value: string, prior: string[]) => [...prior, value], [])
    .option('--include <path>', 'Explicitly reviewed source subtree overriding default exclusions; repeatable', (value: string, prior: string[]) => [...prior, value], [])
    .action(async (opts: { source: string; base: string; prompt: string; output: string; reviewed?: boolean; reference?: string; ledgerTask?: string; workflow?: string; exclude: string[]; include: string[] }) => {
      if (opts.ledgerTask) await draftLedgerCase(opts.ledgerTask, cwd);
      print(await prepareCase({ source: resolve(opts.source), base: opts.base, prompt: await readFile(resolve(opts.prompt), 'utf8'), output: resolve(opts.output), reviewed: opts.reviewed === true,
        ...(opts.reference ? { reference: opts.reference } : {}), ...(opts.ledgerTask ? { ledgerTaskId: opts.ledgerTask } : {}),
        ...(opts.workflow ? { workflow: opts.workflow } : {}), exclude: opts.exclude, include: opts.include }));
    });
  program.command('run').requiredOption('--case <directory>').requiredOption('--treatment <json>', 'Treatment JSON file; repeat for comparisons', (value: string, prior: string[]) => [...prior, value], [])
    .requiredOption('--output <new-directory>').option('--attempts <count>', 'Explicit repetitions per treatment', '1')
    .action(async (opts: { case: string; treatment: string[]; output: string; attempts: string }) => {
      const count = Number(opts.attempts); if (!Number.isSafeInteger(count) || count < 1) throw new Error('attempts must be a positive integer');
      const treatments = await Promise.all(opts.treatment.map(async (file) => TreatmentSchema.parse(await json(resolve(file)))));
      if (!treatments.length || new Set(treatments.map((item) => item.name)).size !== treatments.length) throw new Error('treatment names must be present and unique');
      const root = await freshDirectory(resolve(opts.output));
      for (const [index, treatment] of treatments.entries()) for (let repetition = 1; repetition <= count; repetition++) {
        const result = await runAttempt({ caseDirectory: resolve(opts.case), output: path.join(root, `${index + 1}-${repetition}`), treatment });
        print(result);
        if (result.execution.diagnostic === 'cancelled' || result.execution.diagnostic?.includes('settlement could not be confirmed')) {
          throw new Error('experiment stopped after cancellation or unconfirmed cleanup; retained attempts preserved, no further variants dispatched');
        }
      }
    });
  program.command('evaluate').requiredOption('--attempt <directory>').requiredOption('--evaluator <json>').option('--assessment <json>', 'Human assessment file')
    .action(async (opts: { attempt: string; evaluator: string; assessment?: string }) => {
      const evaluator = EvaluatorSchema.parse(await json(resolve(opts.evaluator)));
      print(await evaluate({ attemptDirectory: resolve(opts.attempt), evaluator,
        ...(opts.assessment ? { assessment: AssessmentSchema.parse(await json(resolve(opts.assessment))) } : {}) }));
    });
  program.command('report').requiredOption('--root <directory>', 'Experiment or individual attempt directory').option('--table', 'Print a Markdown comparison table')
    .action(async (opts: { root: string; table?: boolean }) => { const rows = await report(resolve(opts.root)); if (opts.table) out(`${table(rows)}\n`); else print(rows); });
  program.command('disqualify').requiredOption('--attempt <directory>').requiredOption('--reason <text>')
    .action(async (opts: { attempt: string; reason: string }) => { await disqualify(resolve(opts.attempt), opts.reason); print({ disqualified: true, reason: opts.reason }); });
  return program;
}
export async function runCli(argv: readonly string[], options: { cwd?: string; stdout?: (text: string) => void } = {}): Promise<void> {
  await createProgram(options).parseAsync([...argv], { from: 'user' });
}
