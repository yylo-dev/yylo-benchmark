import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Option, type Command } from 'commander';
import { canonicalJson } from '../contracts/canonical.js';
import {
  createV2ExperimentPlan,
  defaultV2Config,
  doctorV2Experiment,
  parseVariables,
  readV2Plan,
  reevaluateV2Experiment,
  reportV2Experiment,
  runV2Experiment,
  writeV2Plan,
} from '../v2/cli.js';
import { registerGovernedWorkflowCommands } from './governed.js';
import {
  COMMAND_API_VERSION,
  type CommandContext,
  type CommandDefinition,
  type CommandPhase,
  type CommandRegistry,
} from './registry.js';

function definition(
  commandPath: readonly [string, ...string[]],
  description: string,
  phase: CommandPhase,
  configure: (command: Command, context: CommandContext) => void,
): CommandDefinition {
  return { api_version: COMMAND_API_VERSION, path: commandPath, description, phase, available: true, configure };
}

function collect(value: string, previous: string[]): string[] { return [...previous, value]; }
function selectors(value: string): string[] { return value.split(',').map((item) => item.trim()).filter(Boolean); }

const init = definition(['init'], 'Write a minimal flexible v2 configuration', 'foundation', (command, context) => {
  command.option('--stdout', 'Print configuration without writing it').action(async (options: { stdout?: boolean }) => {
    const contents = `${canonicalJson(defaultV2Config())}\n`;
    if (options.stdout === true) context.writeStdout(contents);
    else {
      const destination = path.join(context.cwd, 'yylo-benchmark.config.json');
      await writeFile(destination, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      context.writeStdout(`${destination}\n`);
    }
  });
});

const plan = definition(['plan'], 'Create an immutable v2 task or workflow experiment plan', 'control-plane', (command, context) => {
  command.addOption(new Option('--task <path>', 'Tracked task prompt file').conflicts('workflow'))
    .addOption(new Option('--workflow <path>', 'Tracked Workflow Runner YAML passed through unchanged').conflicts('task'))
    .requiredOption('--models <selectors>', 'Comma-separated opaque model selectors')
    .option('--attempts <count>', 'Attempts per selector', '1')
    .option('--harness <profile>', 'Candidate harness profile')
    .option('--evaluator <profile>', 'Evaluator profile; repeatable', collect, [])
    .option('--var <key=value>', 'Case variable; repeatable', collect, [])
    .option('--controlled-model-variable <name>', 'Workflow variable controlled by the model matrix')
    .option('--output <path>', 'Write the immutable plan')
    .option('--dry-run', 'Compatibility alias: planning is always zero-dispatch')
    .action(async (options: { task?: string; workflow?: string; models: string; attempts: string; harness?: string; evaluator: string[]; var: string[]; controlledModelVariable?: string; output?: string }) => {
      const result = await createV2ExperimentPlan({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }),
        benchmarkVersion: command.parent?.version() ?? '0.0.0-unbuilt', ...(options.task === undefined ? {} : { task: options.task }),
        ...(options.workflow === undefined ? {} : { workflow: options.workflow }), models: selectors(options.models), attempts: Number(options.attempts),
        ...(options.harness === undefined ? {} : { harness: options.harness }), variables: parseVariables(options.var),
        ...(options.controlledModelVariable === undefined ? {} : { controlledModelVariable: options.controlledModelVariable }),
        ...(options.evaluator.length === 0 ? {} : { evaluatorIds: options.evaluator }) });
      if (options.output !== undefined) await writeV2Plan(context.cwd, options.output, result);
      context.writeStdout(`${canonicalJson(result)}\n`);
    });
});

const run = definition(['run'], 'Execute isolated v2 attempts and configured evaluators', 'execution', (command, context) => {
  command.requiredOption('--plan <path>').option('--dry-run', 'Verify the immutable plan with zero dispatch')
    .action(async (options: { plan: string; dryRun?: boolean }) => {
      const planValue = await readV2Plan(context.cwd, options.plan);
      const result = await runV2Experiment({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }), plan: planValue,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }) });
      context.writeStdout(`${canonicalJson(result)}\n`);
    });
});

const recover = definition(['recover'], 'Reuse retained terminals and reconcile missing v2 work safely', 'execution', (command, context) => {
  command.requiredOption('--plan <path>').option('--dry-run', 'Verify recovery inputs with zero dispatch')
    .action(async (options: { plan: string; dryRun?: boolean }) => {
      const planValue = await readV2Plan(context.cwd, options.plan);
      const result = await runV2Experiment({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }), plan: planValue,
        recovery: true, ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }) });
      context.writeStdout(`${canonicalJson(result)}\n`);
    });
});

function reevaluation(name: 'regrade' | 'rejudge', description: string): CommandDefinition {
  return definition([name], description, 'execution', (command, context) => {
    command.requiredOption('--plan <path>').requiredOption('--profile <id>').action(async (options: { plan: string; profile: string }) => {
      const planValue = await readV2Plan(context.cwd, options.plan);
      const result = await reevaluateV2Experiment({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }),
        plan: planValue, profileId: options.profile, kind: name });
      context.writeStdout(`${canonicalJson(result)}\n`);
    });
  });
}

const doctor = definition(['doctor'], 'Verify v2 plan, attempt, evidence, and evaluation linkage', 'execution', (command, context) => {
  command.requiredOption('--plan <path>').action(async (options: { plan: string }) => {
    const planValue = await readV2Plan(context.cwd, options.plan);
    context.writeStdout(`${canonicalJson(await doctorV2Experiment({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }), plan: planValue }))}\n`);
  });
});

const report = definition(['report'], 'Derive a provenance-bound v2 reliability and economics report', 'longitudinal', (command, context) => {
  command.requiredOption('--plan <path>').action(async (options: { plan: string }) => {
    const planValue = await readV2Plan(context.cwd, options.plan);
    context.writeStdout(`${canonicalJson(await reportV2Experiment({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }), plan: planValue }))}\n`);
  });
});

export const BUILTIN_COMMANDS: readonly CommandDefinition[] = Object.freeze([
  init,
  plan,
  run,
  recover,
  reevaluation('regrade', 'Append deterministic evaluation over retained candidate evidence'),
  reevaluation('rejudge', 'Append LLM evaluation over retained candidate evidence'),
  doctor,
  report,
]);

export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const command of BUILTIN_COMMANDS) registry.registerBuiltin(command);
  registerGovernedWorkflowCommands(registry);
}
