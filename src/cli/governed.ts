import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { canonicalJson, sha256Hex } from '../contracts/canonical.js';
import { CONFIG_SCHEMA_VERSION, loadConfig } from '../config/index.js';
import { doctorWorkflowExperiment } from '../doctor/index.js';
import { PersistentTypedResourceLocks } from '../execution/resource-lock.js';
import { createWorkflowPlanFromProject, discoverJunoVersion } from '../planning/cli.js';
import { parseBenchmarkPlan, type BenchmarkPlan } from '../planning/index.js';
import { ImmutableArtifactRegistry } from '../registry/index.js';
import { createReviewedWorkflowBoundary, executeWorkflowPlan, workflowBoundaryOptionsFromEnvironment } from '../workflow/runtime.js';
import { buildWorkflowExperimentReport, readWorkflowEvidenceReceipts, rejudgeRetainedWorkflowStep, storeWorkflowExperimentReport, workflowReceiptNeedsRejudge } from '../workflow/evidence.js';
import { generateBoundaryReadiness, installReviewedBoundary, BOUNDARY_SUPPORTED_PROVIDERS, loadBoundarySetup } from '../boundary/index.js';
import { loadBenchmarkEnvironment, prepareBenchmarkEnvironment, verifyBenchmarkEnvironment } from '../environment/index.js';
import { COMMAND_API_VERSION, type CommandContext, type CommandDefinition, type CommandPhase, type CommandRegistry } from './registry.js';

function definition(pathname: readonly [string, ...string[]], description: string, phase: CommandPhase,
  configure: (command: Command, context: CommandContext) => void): CommandDefinition {
  return { api_version: COMMAND_API_VERSION, path: pathname, description, phase, available: true, configure };
}
function collect(value: string, previous: string[]): string[] { return [...previous, value]; }
function selectors(value: string): string[] { return value.split(',').map((item) => item.trim()).filter(Boolean); }
function variables(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error(`workflow variable must use key=value syntax: ${value}`);
    const key = value.slice(0, separator);
    if (result[key] !== undefined) throw new Error(`duplicate workflow variable: ${key}`);
    result[key] = value.slice(separator + 1);
  }
  return result;
}
async function readJson(pathname: string, label: string): Promise<unknown> {
  try { return JSON.parse(await readFile(pathname, 'utf8')) as unknown; }
  catch (error) { throw new Error(`cannot read ${label} ${pathname}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function readWorkflowPlan(context: CommandContext, pathname: string): Promise<Extract<BenchmarkPlan, { schema_version: 'juno_benchmark_workflow_plan.v2' }>> {
  const absolute = path.resolve(context.cwd, pathname);
  let parsed: BenchmarkPlan;
  try { parsed = parseBenchmarkPlan(await readJson(absolute, 'governed workflow plan')); }
  catch (error) { throw new Error(`malformed governed workflow plan ${absolute}: ${error instanceof Error ? error.message : String(error)}`); }
  if (parsed.schema_version !== 'juno_benchmark_workflow_plan.v2') throw new Error('governed workflow commands require a juno_benchmark_workflow_plan.v2 plan');
  return parsed;
}
async function loadedPreparedConfig(context: CommandContext) {
  const loaded = await loadConfig({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (loaded.config.environment.python !== undefined) {
    await verifyBenchmarkEnvironment(loaded); await loadBenchmarkEnvironment(loaded);
  } else await loadBenchmarkEnvironment(loaded).catch((error) => {
    if (!(error instanceof Error) || !error.message.includes('canonical .env.yylo is missing')) throw error;
  });
  return loaded;
}
function storage(context: CommandContext): { registry: ImmutableArtifactRegistry; locks: PersistentTypedResourceLocks } {
  const root = process.env['YYLO_BENCHMARK_REGISTRY']?.trim() || path.join(context.cwd, '.juno_task', 'artifacts', 'yylo-benchmark');
  return { registry: new ImmutableArtifactRegistry(root), locks: new PersistentTypedResourceLocks({ root: path.join(root, 'locks') }) };
}
async function boundary(context: CommandContext) {
  const options = workflowBoundaryOptionsFromEnvironment();
  if (options === null) throw new Error('live governed workflow execution requires YYLO_BENCHMARK_WORKFLOW_BOUNDARY and YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256');
  const setup = await loadBoundarySetup(context.cwd).catch(() => null);
  if (setup !== null && setup.boundary.path === options.module) {
    const ambient = process.env['YYLO_BENCHMARK_BOUNDARY_SYNTHETIC'] === '1';
    if (setup.synthetic && !ambient) process.env['YYLO_BENCHMARK_BOUNDARY_SYNTHETIC'] = '1';
    if (!setup.synthetic && ambient) throw new Error('synthetic transport is ambient but setup binds live transport; rerun workflow setup --synthetic explicitly');
  }
  return createReviewedWorkflowBoundary(options);
}

const setup = definition(['workflow', 'setup'], 'Install the reviewed governed boundary and bind its private registry', 'foundation', (command, context) => {
  command.option('--providers <names>', `Comma-separated boundary providers (default: ${BOUNDARY_SUPPORTED_PROVIDERS.join(',')})`)
    .option('--synthetic', 'Use synthetic transport for installed acceptance without credentials').action(async (options: { providers?: string; synthetic?: boolean }) => {
      const loaded = await loadConfig({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
      const preparation = await prepareBenchmarkEnvironment(loaded);
      const receipt = await installReviewedBoundary({ projectRoot: loaded.projectRoot,
        providers: options.providers === undefined ? [...BOUNDARY_SUPPORTED_PROVIDERS] : selectors(options.providers), synthetic: options.synthetic === true });
      context.writeStdout(`${canonicalJson({ ...receipt, preparation, configuration_lane: 'governed_workflow' })}\n`);
    });
});

const readiness = definition(['workflow', 'readiness'], 'Probe exact identities and authentication with zero dispatch', 'control-plane', (command, context) => {
  command.requiredOption('--models <selectors>').action(async (options: { models: string }) => {
    const loaded = await loadedPreparedConfig(context);
    const models = selectors(options.models).map((selector) => {
      const model = selector.startsWith(':') ? loaded.config.model_aliases[selector] : selector;
      if (model === undefined) throw new Error(`model alias ${selector} has no exact binding in model_aliases`);
      if (!/^[^:/\s\x00-\x1f\x7f]+\/[^:/\s\x00-\x1f\x7f]+$/u.test(model)) throw new Error(`model ${selector} does not resolve to an exact provider/model identity`);
      return { selector, model, provider: model.slice(0, model.indexOf('/')) };
    });
    if (models.length === 0 || new Set(models.map((item) => item.model)).size !== models.length) throw new Error('model selectors must be non-empty and resolve to distinct exact models');
    const junoVersion = await discoverJunoVersion(loaded.projectRoot);
    const { receipt } = await generateBoundaryReadiness({ projectRoot: loaded.projectRoot, models, junoVersion,
      junoExecutable: process.env['YYLO_BENCHMARK_JUNO_EXECUTABLE']?.trim() || 'yy' });
    context.writeStdout(`${canonicalJson(receipt)}\n`);
  });
});

const plan = definition(['workflow', 'plan'], 'Create an immutable selected-step governed workflow plan', 'control-plane', (command, context) => {
  command.requiredOption('--workflow <path>', 'Tracked project-owned Workflow Runner YAML')
    .requiredOption('--models <selectors>').requiredOption('--steps-file <path>', 'Tracked governed policy sidecar')
    .option('--steps <ids>', 'Comma-separated canonical step IDs').option('--var <key=value>', 'Bind a workflow variable', collect, [])
    .option('--attempts <count>', 'Attempts per model and step', '1').option('--output <path>').option('--dry-run', 'Planning is always zero-dispatch')
    .action(async (options: { workflow: string; models: string; stepsFile: string; steps?: string; var: string[]; attempts: string; output?: string }) => {
      await loadedPreparedConfig(context);
      const result = await createWorkflowPlanFromProject({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }),
        workflowPath: options.workflow, policyPath: options.stepsFile, models: selectors(options.models), attempts: Number(options.attempts), variables: variables(options.var),
        ...(options.steps === undefined ? {} : { selectedStepIds: selectors(options.steps) }) });
      if (options.output !== undefined) await writeFile(path.resolve(context.cwd, options.output), `${canonicalJson(result)}\n`, { flag: 'wx', mode: 0o600 });
      context.writeStdout(`${canonicalJson({ ...result, dispatch_count: 0 })}\n`);
    });
});

function execution(name: 'run' | 'recover'): CommandDefinition {
  return definition(['workflow', name], `${name === 'run' ? 'Execute' : 'Recover'} an immutable governed workflow plan`, 'execution', (command, context) => {
    command.requiredOption('--plan <path>').requiredOption('--steps-file <path>').option('--dry-run', 'Verify all bindings with zero dispatch')
      .action(async (options: { plan: string; stepsFile: string; dryRun?: boolean }) => {
        await loadedPreparedConfig(context); const planValue = await readWorkflowPlan(context, options.plan); const retained = storage(context);
        const reviewed = options.dryRun === true ? undefined : await boundary(context);
        const result = await executeWorkflowPlan({ plan: planValue, projectRoot: context.cwd, policyPath: options.stepsFile,
          registry: retained.registry, locks: retained.locks, ...(name === 'recover' ? { recovery: true } : {}),
          ...(reviewed === undefined ? { dryRun: true as const } : { dispatcher: reviewed.dispatcher, judge: reviewed.judge, boundaryIdentity: reviewed.identity }) });
        context.writeStdout(`${canonicalJson(name === 'recover' ? { operation: name, ...result } : result)}\n`);
      });
  });
}

const rejudge = definition(['workflow', 'rejudge'], 'Rejudge retained steps without candidate dispatch', 'execution', (command, context) => {
  command.requiredOption('--plan <path>').requiredOption('--steps-file <path>').option('--judge <selector>').option('--rubric-file <path>').option('--dry-run')
    .action(async (options: { plan: string; stepsFile: string; judge?: string; rubricFile?: string; dryRun?: boolean }) => {
      await loadedPreparedConfig(context); const planValue = await readWorkflowPlan(context, options.plan); const retained = storage(context);
      const verified = await executeWorkflowPlan({ plan: planValue, projectRoot: context.cwd, policyPath: options.stepsFile, registry: retained.registry, locks: retained.locks, dryRun: true });
      if (!('immutable_hashes' in verified)) throw new Error('workflow rejudge verification unexpectedly entered execution');
      const requested = options.judge ?? planValue.policy.judge.model;
      const resolved = requested === planValue.policy.judge.model ? requested : Object.entries(planValue.model_selectors).find(([, selector]) => selector === requested)?.[0];
      if (resolved !== planValue.policy.judge.model) throw new Error('requested workflow judge does not match the immutable governed judge policy');
      const rubric = options.rubricFile === undefined ? (planValue.policy.judge as { rubric?: string }).rubric : await readFile(path.resolve(context.cwd, options.rubricFile), 'utf8');
      if (rubric === undefined || `sha256:${sha256Hex(Buffer.from(rubric, 'utf8'))}` !== planValue.policy.judge.rubric_hash) throw new Error('workflow rejudge rubric bytes are missing or do not match rubric_hash');
      if (options.dryRun === true) {
        context.writeStdout(`${canonicalJson({ schema_version: 'juno_benchmark_workflow_rejudge_dry_run.v1', plan_id: planValue.plan_id,
          candidate_dispatch_count: 0, judge_dispatch_count: 0, requested_judge: requested, immutable_hashes: verified.immutable_hashes })}\n`); return;
      }
      const reviewed = await boundary(context); const experimentId = `workflow-${planValue.plan_id.slice(7)}`;
      const receipts = await readWorkflowEvidenceReceipts(retained.registry, experimentId);
      if (receipts.length !== planValue.execution_order.length) throw new Error('workflow rejudge requires a complete retained receipt set');
      const judgements = [];
      for (const receipt of receipts) if (await workflowReceiptNeedsRejudge(retained.registry, experimentId, receipt)) {
        judgements.push(await rejudgeRetainedWorkflowStep({ registry: retained.registry, experimentId, receipt, trustedReceiptHash: receipt.receipt_hash,
          expectedPolicySemanticsHash: planValue.policy_semantics_sha256 as `sha256:${string}`, judge: planValue.policy.judge, runner: reviewed.judge,
          locks: retained.locks, plan: planValue, rubricBytes: rubric }));
      }
      const report = await storeWorkflowExperimentReport(retained.registry, planValue);
      context.writeStdout(`${canonicalJson({ schema_version: 'juno_benchmark_workflow_rejudge.v1', plan_id: planValue.plan_id,
        candidate_dispatch_count: 0, judge_dispatch_count: judgements.length, requested_judge: requested, boundary: reviewed.identity, judgements, report })}\n`);
    });
});

const doctor = definition(['workflow', 'doctor'], 'Verify governed plan, intents, terminals, sessions, judges, and recovery', 'execution', (command, context) => {
  command.requiredOption('--plan <path>').requiredOption('--steps-file <path>').action(async (options: { plan: string; stepsFile: string }) => {
    await loadedPreparedConfig(context); const planValue = await readWorkflowPlan(context, options.plan); const retained = storage(context);
    await executeWorkflowPlan({ plan: planValue, projectRoot: context.cwd, policyPath: options.stepsFile, registry: retained.registry, locks: retained.locks, dryRun: true });
    context.writeStdout(`${canonicalJson(await doctorWorkflowExperiment(retained.registry, `workflow-${planValue.plan_id.slice(7)}`))}\n`);
  });
});

const report = definition(['workflow', 'report'], 'Build a per-step governed model comparison', 'longitudinal', (command, context) => {
  command.requiredOption('--plan <path>').action(async (options: { plan: string }) => {
    const planValue = await readWorkflowPlan(context, options.plan); const result = await buildWorkflowExperimentReport(storage(context).registry, planValue);
    context.writeStdout(`${canonicalJson(result)}\n`);
  });
});

const migrate = definition(['workflow', 'migrate-config'], 'Diagnose configuration lanes without schema-string migration', 'foundation', (command, context) => {
  command.option('--input <path>', 'Configuration to inspect', 'yylo-benchmark.config.json').option('--output <path>', 'Write a governed template to a new path')
    .action(async (options: { input: string; output?: string }) => {
      const source = path.resolve(context.cwd, options.input); const value = await readJson(source, 'benchmark configuration');
      const schema = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['schema_version'] : undefined;
      if (schema === CONFIG_SCHEMA_VERSION) {
        context.writeStdout(`${canonicalJson({ schema_version: 'yylo_benchmark_config_migration_diagnostic.v1', source,
          detected_lane: 'governed_workflow', action: 'none', message: 'This configuration already belongs to the governed workflow lane. Use yylo-benchmark workflow ...; do not change schema_version.' })}\n`); return;
      }
      if (schema !== 'yylo_benchmark_config.v2') throw new Error(`unsupported benchmark configuration schema ${String(schema)}; no file was changed`);
      if (options.output === undefined) {
        context.writeStdout(`${canonicalJson({ schema_version: 'yylo_benchmark_config_migration_diagnostic.v1', source,
          detected_lane: 'isolated_v2', action: 'explicit_output_required', message: 'Isolated-v2 and governed-workflow configurations are separate contracts. Re-run with --output to create a reviewed governed template; the source will not be overwritten.' })}\n`); return;
      }
      const destination = path.resolve(context.cwd, options.output);
      const template = { schema_version: CONFIG_SCHEMA_VERSION, repository_id: 'root', kanban: { arguments: [] }, model_aliases: {},
        environment: { env_file: '.env.yylo', legacy_env_file: '.env.juno' }, grader_profiles: {} };
      await writeFile(destination, `${canonicalJson(template)}\n`, { flag: 'wx', mode: 0o600 });
      context.writeStdout(`${canonicalJson({ schema_version: 'yylo_benchmark_config_migration_receipt.v1', source, destination,
        source_lane: 'isolated_v2', destination_lane: 'governed_workflow', overwritten: false, review_required: true })}\n`);
    });
});

export const GOVERNED_WORKFLOW_COMMANDS: readonly CommandDefinition[] = Object.freeze([
  setup, readiness, plan, execution('run'), execution('recover'), rejudge, doctor, report, migrate,
]);
export function registerGovernedWorkflowCommands(registry: CommandRegistry): void {
  for (const command of GOVERNED_WORKFLOW_COMMANDS) registry.registerBuiltin(command);
}
