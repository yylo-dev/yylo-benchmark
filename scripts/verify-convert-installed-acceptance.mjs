#!/usr/bin/env node
import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const repository = args.get('--repository');
const benchmark = args.get('--benchmark');
const delegate = args.get('--delegate');
if (!repository || !benchmark) {
  process.stderr.write('usage: node verify-convert-installed-acceptance.mjs --repository <Convert git checkout> --benchmark <installed yylo-benchmark> [--delegate <installed yy>]\n');
  process.exit(2);
}

const fixtureRoot = path.join(packageRoot, 'fixtures', 'convert-2026-08-12');
const expected = JSON.parse(await readFile(path.join(fixtureRoot, 'expected.json'), 'utf8'));
const temporary = await mkdtemp(path.join(tmpdir(), 'yylo-benchmark-convert-acceptance-'));
const project = path.join(temporary, 'project');
const planPath = path.join(project, 'historical-plan.json');

function execute(executable, commandArgs, cwd = project, extraEnvironment = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^YYLO_BENCHMARK_(?:AUTH|REGISTRY|WORK_ROOT)/u.test(key) && !/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/u.test(key)));
  env.PATH = `${path.dirname(path.resolve(benchmark))}${path.delimiter}${env.PATH ?? ''}`;
  Object.assign(env, extraEnvironment);
  const result = spawnSync(executable, commandArgs, { cwd, env, encoding: 'utf8', input: '', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(`${executable} ${commandArgs.join(' ')} failed (${result.error?.message ?? result.status ?? result.signal}): ${result.stderr || result.stdout}`);
  }
  return result;
}
function json(result) { return JSON.parse(result.stdout); }
function same(actual, wanted, label) {
  try { deepStrictEqual(actual, wanted); }
  catch { throw new Error(`${label} mismatch: ${JSON.stringify({ actual, wanted })}`); }
}
function sha256(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

try {
  execute('git', ['clone', '--shared', '--no-checkout', path.resolve(repository), project], temporary);
  execute('git', ['checkout', '--detach', expected.historical_source_commit]);
  await mkdir(path.join(project, '.juno_task'), { recursive: true });
  await writeFile(path.join(project, '.juno_task', 'config.json'), JSON.stringify({ workflowModels: [':sol', ':mini', ':luna', 'zai/glm-5.2'] }));
  await writeFile(path.join(project, 'yylo-benchmark.config.json'), JSON.stringify({
    schema_version: 'juno_benchmark_config.v1', repository_id: 'convert_IF_chat',
    model_aliases: { ':sol': 'openai-codex/gpt-5.6-sol', ':mini': 'openai-codex/gpt-5.6-terra', ':luna': 'openai-codex/gpt-5.6-luna' },
  }));
  const policyPath = path.join(project, 'convert-2026-08-12.policy.yaml');
  await cp(path.join(fixtureRoot, 'policy.yaml'), policyPath);
  const rubric = await readFile(path.join(fixtureRoot, 'rubric.md'));
  if (sha256(rubric) !== expected.judge.rubric_hash) throw new Error('packaged governed rubric hash mismatch');

  const planArgs = ['workflow', 'plan', '--workflow', expected.workflow_path, '--steps-file', path.basename(policyPath),
    '--steps', expected.selected_step_ids.join(','), '--models', ':sol,:mini,:luna,zai/glm-5.2', '--var', `run_date=${expected.historical_date}`, '--attempts', '1', '--dry-run'];
  const standalonePlanResult = execute(benchmark, planArgs); const plan = json(standalonePlanResult);
  await writeFile(planPath, `${standalonePlanResult.stdout.trim()}\n`, { mode: 0o600 });
  same(plan.source, {
    repository_id: 'convert_IF_chat', source_ref: expected.historical_source_ref, source_commit: expected.historical_source_commit,
    workflow_path: expected.workflow_path, raw_sha256: expected.workflow_raw_sha256, semantics_sha256: expected.workflow_semantics_sha256,
  }, 'historical source identity');
  same(plan.selected_step_ids, expected.selected_step_ids, 'historical stable step selection');
  same(plan.models, expected.models, 'exact model identities');
  same(plan.model_dispatch_step_ids, expected.injection_step_ids, 'canonical model-dispatch classification');
  if (plan.spend_limits !== undefined) throw new Error('workflow plan must not carry spend limits; cost is observational evidence only');
  same(plan.policy.judge, expected.judge, 'governed judge');
  if (plan.normalized_workflow.steps.length !== expected.current_step_count) throw new Error('historical 13-of-17 distinction is invalid');
  const sourceCommands = new Map(plan.normalized_workflow.steps.map((step) => [step.id, step.command]));
  same(plan.policy.deterministic_commands.map((item) => item.step_id), expected.deterministic_step_ids, 'deterministic command policy');
  for (const compiled of plan.compiled_workflows) {
    same(compiled.injected_step_ids, expected.injection_step_ids, `injection points for ${compiled.model}`);
    const compiledWorkflow = JSON.parse(JSON.stringify((await import('yaml')).parse(Buffer.from(compiled.workflow_bytes_base64, 'base64').toString('utf8'))));
    for (const stepId of expected.deterministic_step_ids) {
      same(compiledWorkflow.steps.find((step) => step.id === stepId).command, sourceCommands.get(stepId), `deterministic argv for ${compiled.model}/${stepId}`);
    }
  }
  same(plan.execution_order.map((item) => `${item.model}:${item.attempt}:${item.step_id}`),
    expected.models.flatMap((model) => expected.selected_step_ids.map((step) => `${model}:1:${step}`)), 'strict sequential execution order');

  const comparisonPlanPath = path.join(project, 'aug-19-comparison-plan.json');
  const comparisonArgs = ['workflow', 'plan', '--workflow', expected.workflow_path, '--steps-file', path.basename(policyPath),
    '--steps', expected.selected_step_ids.join(','), '--models', ':mini,zai/glm-5.3', '--var', `run_date=${expected.requested_comparison_date}`, '--attempts', '1', '--dry-run'];
  const comparisonPlanResult = execute(benchmark, comparisonArgs); const comparisonPlan = json(comparisonPlanResult);
  await writeFile(comparisonPlanPath, `${comparisonPlanResult.stdout.trim()}\n`, { mode: 0o600 });
  same(comparisonPlan.models, expected.requested_comparison_models, 'Aug. 19 arbitrary exact model identities');
  same(comparisonPlan.model_dispatch_step_ids, expected.injection_step_ids, 'Aug. 19 model injection points');
  if (comparisonPlan.workflow_model_policy.workflow_models.includes('zai/glm-5.3')) throw new Error('exact model unexpectedly required a workflowModels catalog entry');
  const comparisonDryRun = json(execute(benchmark, ['workflow', 'run', '--plan', path.basename(comparisonPlanPath), '--steps-file', path.basename(policyPath), '--dry-run']));
  same(comparisonDryRun.estimate_availability, [
    { model: 'openai-codex/gpt-5.6-terra', status: 'available' },
    { model: 'zai/glm-5.3', status: 'unavailable' },
  ], 'Aug. 19 estimate availability');
  if (comparisonDryRun.estimated_totals !== null) throw new Error('partial estimate overrides must not produce a false complete total');

  const operations = [
    ['workflow', 'run', '--plan', path.basename(planPath), '--steps-file', path.basename(policyPath), '--dry-run'],
    ['workflow', 'recover', '--plan', path.basename(planPath), '--steps-file', path.basename(policyPath), '--dry-run'],
    ['workflow', 'rejudge', '--plan', path.basename(planPath), '--steps-file', path.basename(policyPath), '--dry-run'],
  ];
  const standalone = operations.map((operation) => execute(benchmark, operation));
  if (delegate) {
    const delegatedPlan = execute(delegate, ['benchmark', ...planArgs]);
    if (delegatedPlan.stdout !== standalonePlanResult.stdout || delegatedPlan.stderr !== standalonePlanResult.stderr) throw new Error('delegated historical plan differs from standalone');
    const delegatedComparison = execute(delegate, ['benchmark', ...comparisonArgs]);
    if (delegatedComparison.stdout !== comparisonPlanResult.stdout || delegatedComparison.stderr !== comparisonPlanResult.stderr) throw new Error('delegated Aug. 19 arbitrary-model plan differs from standalone');
    operations.forEach((operation, index) => {
      const delegated = execute(delegate, ['benchmark', ...operation]);
      if (delegated.stdout !== standalone[index].stdout || delegated.stderr !== standalone[index].stderr) throw new Error(`delegated ${operation[0]} differs from standalone`);
    });
  }

  const dryRun = json(standalone[0]);
  if (dryRun.dispatch_count !== expected.dispatch_expected || dryRun.production_models_sequential !== true) throw new Error('installed dry-run dispatch/sequential contract failed');
  if ('authorization' in dryRun) throw new Error('dry-run must not report spend authorization; grants were removed in favor of observational cost');
  same(dryRun.cost_tracking, { mode: 'best_effort', unavailable_is_valid: true }, 'observational cost tracking');
  same(dryRun.models, expected.models, 'dry-run models');
  same(dryRun.selected_step_ids, expected.selected_step_ids, 'dry-run selected steps');
  same(dryRun.judge, expected.judge, 'dry-run judge');
  same(dryRun.required_resources.map((item) => `${item.type}:${item.id}`).sort(), [...expected.resources].sort(), 'typed resources');
  same(dryRun.estimated_totals, { usd: expected.estimated_total_usd, runtime_ms: expected.estimated_total_runtime_ms }, 'estimates');
  same(dryRun.immutable_hashes, { plan: plan.plan_id, workflow_raw: expected.workflow_raw_sha256,
    workflow_semantics: expected.workflow_semantics_sha256, policy_raw: plan.policy_raw_sha256,
    policy_semantics: plan.policy_semantics_sha256, variables: plan.variables_hash }, 'immutable hashes');
  if (json(standalone[1]).dispatch_count !== 0 || json(standalone[2]).candidate_dispatch_count !== 0 || json(standalone[2]).judge_dispatch_count !== 0) throw new Error('recover/rejudge dry-run dispatched work');

  // Installed-consumer dogfood gate (D0tTNr): the tracked Convert Daily Ops
  // workflow, all 13 stable steps, normal `yy` identity probing, and synthetic
  // transport prove setup -> readiness -> plan -> dry-run -> first dispatch ->
  // terminal -> recover with zero provider dispatch and no ambiguity. The
  // registry is isolated under the temporary root so the read-only assertions
  // above stay exact.
  {
    const registry = path.join(temporary, 'synthetic-registry');
    const gateEnvironment = extra => ({ YYLO_BENCHMARK_REGISTRY: registry, ...extra });
    const gate = (argv, extra = {}) => execute(benchmark, argv, project, gateEnvironment(extra));
    const delegatedGate = (argv, extra = {}) => execute(delegate, ['benchmark', ...argv], project, gateEnvironment(extra));
    const setup = json(gate(['workflow', 'setup', '--synthetic']));
    const boundaryEnvironment = {
      YYLO_BENCHMARK_WORKFLOW_BOUNDARY: setup.environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY,
      YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256: setup.environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256,
    };
    const readiness = json(gate(['workflow', 'readiness', '--models', ':mini,zai/glm-5.3'], boundaryEnvironment));
    if (readiness.dispatch_count !== 0) throw new Error('synthetic readiness dispatched work');
    if (readiness.yylo.executable !== 'yy') throw new Error(`synthetic readiness must probe the normal yy launcher, saw ${readiness.yylo.executable}`);
    const gatePlanArgs = ['workflow', 'plan', '--workflow', expected.workflow_path, '--steps-file', path.basename(policyPath),
      '--steps', expected.selected_step_ids.join(','), '--models', ':mini,zai/glm-5.3', '--var', `run_date=${expected.requested_comparison_date}`, '--attempts', '1', '--output', 'synthetic-plan.json', '--dry-run'];
    const gatePlan = json(gate(gatePlanArgs, boundaryEnvironment));
    if (gatePlan.selected_step_ids.length !== expected.selected_step_ids.length) throw new Error('synthetic gate must select the full 13-step tracked workflow');
    const gateDryRun = json(gate(['workflow', 'run', '--plan', 'synthetic-plan.json', '--steps-file', path.basename(policyPath), '--dry-run'], boundaryEnvironment));
    if (gateDryRun.dispatch_count !== 0) throw new Error('synthetic gate dry-run dispatched work');
    const gateRun = json(gate(['workflow', 'run', '--plan', 'synthetic-plan.json', '--steps-file', path.basename(policyPath)], boundaryEnvironment));
    if (gateRun.recovered !== false || gateRun.terminals.length !== expected.selected_step_ids.length * expected.requested_comparison_models.length) {
      throw new Error(`synthetic gate run terminal contract failed (recovered ${gateRun.recovered}, terminals ${gateRun.terminals.length})`);
    }
    for (const terminal of gateRun.terminals) {
      if (!terminal.result.runner_run_id.startsWith('synthetic-run-')) throw new Error('synthetic gate dispatched a real provider child');
    }
    const gateRerun = json(gate(['workflow', 'run', '--plan', 'synthetic-plan.json', '--steps-file', path.basename(policyPath)], boundaryEnvironment));
    if (gateRerun.recovered !== true) throw new Error('synthetic gate duplicate-dispatch guard failed');
    const gateRecover = json(gate(['workflow', 'recover', '--plan', 'synthetic-plan.json', '--steps-file', path.basename(policyPath)], boundaryEnvironment));
    if (gateRecover.recovered !== true) throw new Error('synthetic gate recovery without duplicate execution failed');
    if (delegate) {
      const delegatedPlan = delegatedGate(gatePlanArgs.filter((_, index) => gatePlanArgs[index] !== '--output' && gatePlanArgs[index - 1] !== '--output'), boundaryEnvironment);
      if (delegatedPlan.status !== 0) throw new Error('delegated synthetic gate plan failed');
    }
  }
  // Installed-consumer live-stub transport gate (Jf1TaD): a recording
  // normal-shaped `yy` stub proves the reviewed boundary requests exactly one
  // benchmark-owned --execution-envelope in the root position and propagates
  // the canonical child correlation; a completed child without a valid
  // envelope yields a retained harness-failure terminal with no blind
  // redispatch, and the exact consumer doctor command verifies the workflow
  // experiment from retained registry evidence. Zero provider dispatch.
  {
    const stubProject = path.join(temporary, 'stub-project');
    await mkdir(path.join(stubProject, '.juno_task'), { recursive: true });
    await writeFile(path.join(stubProject, '.juno_task', 'config.json'), JSON.stringify({ workflowModels: [':mini', 'zai/glm-5.3'] }));
    await writeFile(path.join(stubProject, 'yylo-benchmark.config.json'), JSON.stringify({
      schema_version: 'juno_benchmark_config.v1', repository_id: 'convert_IF_chat',
      model_aliases: { ':mini': 'openai-codex/gpt-5.6-terra' },
    }));
    const stubPolicyPath = path.join(stubProject, 'convert-2026-08-12.policy.yaml');
    await cp(path.join(fixtureRoot, 'policy.yaml'), stubPolicyPath);
    await cp(path.join(project, expected.workflow_path), path.join(stubProject, 'workflow.yaml'));
    // Deterministic policy validation requires the tracked Python scripts the
    // policy binds, even when only the first model step is selected.
    const policyDocument = JSON.parse(await readFile(stubPolicyPath, 'utf8'));
    for (const deterministic of policyDocument.deterministic_commands ?? []) {
      const destination = path.join(stubProject, deterministic.script);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(project, deterministic.script), destination);
    }
    execute('git', ['init', '-b', 'stub-fixture'], stubProject);
    execute('git', ['config', 'user.email', 'stub@example.test'], stubProject);
    execute('git', ['config', 'user.name', 'Stub'], stubProject);
    execute('git', ['add', 'workflow.yaml', 'convert-2026-08-12.policy.yaml', 'scripts'], stubProject);
    execute('git', ['commit', '-m', 'stub fixture'], stubProject);
    const stubYy = path.join(temporary, 'stub-yy');
    await writeFile(stubYy, `#!/bin/sh
if [ -n "$YY_STUB_RECORD" ]; then
  {
    printf 'argv:'
    for argument in "$@"; do printf ' <%s>' "$argument"; done
    printf '\\n'
    printf 'correlation: child=%s run=%s step=%s surface=%s\\n' "$YYLO_INVOCATION_CHILD" "$YYLO_WORKFLOW_RUN_ID" "$YYLO_WORKFLOW_STEP_ID" "$YYLO_LAUNCH_SURFACE"
  } >> "$YY_STUB_RECORD"
fi
case "$1" in
  --version) echo "9.9.9"; exit 0 ;;
esac
printf 'run\\n' >> "$YY_STUB_RUNS"
transport=""
model=""
prompt=""
prev=""
for argument in "$@"; do
  if [ "$argument" = "--execution-envelope" ]; then transport=1; fi
  if [ "$prev" = "--model" ]; then model="$argument"; fi
  prompt="$argument"
  prev="$argument"
done
if [ -z "$transport" ]; then printf 'Judging the blinded candidate.\\nVERDICT: PASS\\n'; exit 0; fi
case "$YY_STUB_MODE" in
  failure)
    printf 'controller-resolver: retired rollback controller is read-only; run writes from the registered metadata controller\\n' >&2
    exit 99
    ;;
esac
case "$model" in :mini) model="openai-codex/gpt-5.6-terra" ;; esac
provider="\${model%%/*}"
name="\${model#*/}"
printf '{"schema_version":"juno_execution_envelope.v1","status":"success","session_id":"sess-stub-1","provider":"%s","model":"%s","juno_version":"9.9.9","cost":{"completeness":"complete","usd":0.42}}\\n' "$provider" "$name"
exit 0
`, { mode: 0o755 });
    const stubEnvironment = (extra = {}) => ({
      YYLO_BENCHMARK_JUNO_EXECUTABLE: stubYy,
      YYLO_BENCHMARK_JUNO_VERSION: '9.9.9',
      OPENAI_CODEX_TOKEN: 'fixture-stub-token-0123456789',
      ...extra,
    });
    const stubGate = (argv, registry, extra = {}) => execute(benchmark, argv, stubProject,
      stubEnvironment({ YYLO_BENCHMARK_REGISTRY: registry, ...extra }));
    const stubPlanArgs = ['workflow', 'plan', '--workflow', 'workflow.yaml', '--steps-file', path.basename(stubPolicyPath),
      '--steps', 'purchases', '--models', ':mini', '--var', `run_date=${expected.requested_comparison_date}`,
      '--attempts', '1', '--output', 'stub-plan.json', '--dry-run'];

    // Mode A: a valid stub envelope yields a normal terminal and the executed
    // argv proves exactly one benchmark-owned envelope flag in the root
    // position plus the canonical child correlation identity.
    const registryA = path.join(temporary, 'stub-registry-envelope');
    const recordA = path.join(temporary, 'stub-record-envelope.log');
    const runsA = path.join(temporary, 'stub-runs-envelope.log');
    const setupA = json(stubGate(['workflow', 'setup'], registryA));
    const boundaryEnvironment = {
      YYLO_BENCHMARK_WORKFLOW_BOUNDARY: setupA.environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY,
      YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256: setupA.environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256,
    };
    const readinessA = json(stubGate(['workflow', 'readiness', '--models', ':mini'], registryA, boundaryEnvironment));
    if (readinessA.dispatch_count !== 0) throw new Error('live-stub readiness dispatched work');
    const stubPlan = json(stubGate(stubPlanArgs, registryA, boundaryEnvironment));
    const dryRunA = json(stubGate(['workflow', 'run', '--plan', 'stub-plan.json', '--steps-file', path.basename(stubPolicyPath), '--dry-run'], registryA, boundaryEnvironment));
    if (dryRunA.dispatch_count !== 0) throw new Error('live-stub dry-run dispatched work');
    const runA = json(stubGate(['workflow', 'run', '--plan', 'stub-plan.json', '--steps-file', path.basename(stubPolicyPath)], registryA,
      { ...boundaryEnvironment, YY_STUB_RECORD: recordA, YY_STUB_RUNS: runsA }));
    if (runA.recovered !== false || runA.terminals.length !== 1) throw new Error('live-stub envelope run terminal contract failed');
    if (runA.terminals[0].result.status !== 'success' || runA.terminals[0].result.observed_model !== 'openai-codex/gpt-5.6-terra') {
      throw new Error(`live-stub envelope terminal failed: ${JSON.stringify(runA.terminals[0].result)}`);
    }
    const linesA = (await readFile(recordA, 'utf8')).split('\n').filter(Boolean);
    const dispatchedArgv = linesA.filter((line) => line.startsWith('argv:') && line.includes('--model') && !line.includes('<--version>'));
    const candidateArgv = dispatchedArgv.filter((line) => line.includes('--execution-envelope'));
    const judgeArgv = dispatchedArgv.filter((line) => !line.includes('--execution-envelope'));
    if (candidateArgv.length !== 1) throw new Error(`live-stub run must carry exactly one envelope-flagged candidate argv, saw ${candidateArgv.length}`);
    if (judgeArgv.length !== 1) throw new Error(`live-stub run must judge once without the transport flag, saw ${judgeArgv.length}`);
    const candidateArguments = candidateArgv[0].slice('argv:'.length).trim().split(' <').map((item) => item.replace(/>$/u, '').replace(/^</u, ''));
    if (candidateArguments[0] !== '--execution-envelope' || candidateArguments[1] !== 'pi' || candidateArguments[2] !== '--model' || candidateArguments[3] !== ':mini') {
      throw new Error(`live-stub executed argv is not the benchmark-owned root-position envelope form: ${candidateArgv[0]}`);
    }
    if (candidateArguments.filter((item) => item === '--execution-envelope').length !== 1) throw new Error('live-stub executed argv carries more than one envelope flag');
    const correlation = linesA.find((line) => line.startsWith('correlation:') && line.includes(`run=${stubPlan.plan_id}`));
    if (!correlation || !correlation.includes('child=1') || !correlation.includes('step=purchases') || !correlation.includes('surface=yylo-benchmark')) {
      throw new Error(`live-stub child correlation identity is missing or wrong: ${correlation ?? 'none'}`);
    }

    // Mode B: a completed child without a valid envelope yields a retained
    // harness-failure terminal; recovery never redispatches it, and the exact
    // consumer doctor command verifies the experiment from retained evidence.
    const registryB = path.join(temporary, 'stub-registry-failure');
    const runsB = path.join(temporary, 'stub-runs-failure.log');
    const setupB = json(stubGate(['workflow', 'setup'], registryB));
    const boundaryB = {
      YYLO_BENCHMARK_WORKFLOW_BOUNDARY: setupB.environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY,
      YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256: setupB.environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256,
    };
    const planB = json(stubGate(stubPlanArgs.filter((_, index) => stubPlanArgs[index] !== '--output' && stubPlanArgs[index - 1] !== '--output'), registryB, boundaryB));
    if (planB.plan_id !== stubPlan.plan_id) throw new Error('live-stub plans drifted between transport modes');
    const failureEnvironment = { ...boundaryB, YY_STUB_RUNS: runsB, YY_STUB_MODE: 'failure' };
    const runB = json(stubGate(['workflow', 'run', '--plan', 'stub-plan.json', '--steps-file', path.basename(stubPolicyPath)], registryB, failureEnvironment));
    if (runB.terminals.length !== 1 || runB.terminals[0].result.status !== 'failure' || runB.terminals[0].result.effect !== 'completed') {
      throw new Error(`live-stub harness-failure terminal contract failed: ${JSON.stringify(runB.terminals)}`);
    }
    if ((await readFile(runsB, 'utf8')).split('\n').filter(Boolean).length !== 2) throw new Error('live-stub failure mode must run exactly one candidate child plus one judge child');
    const rerunB = json(stubGate(['workflow', 'run', '--plan', 'stub-plan.json', '--steps-file', path.basename(stubPolicyPath)], registryB, failureEnvironment));
    if (rerunB.recovered !== true) throw new Error('live-stub duplicate-dispatch guard failed');
    if ((await readFile(runsB, 'utf8')).split('\n').filter(Boolean).length !== 2) throw new Error('recovery redispatched a completed harness failure');
    const recoverB = json(stubGate(['workflow', 'recover', '--plan', 'stub-plan.json', '--steps-file', path.basename(stubPolicyPath)], registryB, failureEnvironment));
    if (recoverB.recovered !== true) throw new Error('live-stub recovery without duplicate execution failed');
    const doctorB = json(stubGate(['doctor', `workflow-${stubPlan.plan_id.slice(7)}`], registryB, boundaryB));
    if (doctorB.ok !== true || doctorB.dispatchIntents !== 1 || doctorB.terminals !== 1
      || doctorB.harnessFailureTerminals !== 1 || doctorB.ambiguousDispatches !== 0) {
      throw new Error(`live-stub consumer doctor command failed its integrity contract: ${JSON.stringify(doctorB)}`);
    }
  }
  try { await stat(path.join(project, '.juno_task', 'artifacts')); throw new Error('read-only installed acceptance created retained artifacts'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  process.stdout.write(`${JSON.stringify({ schema_version: 'juno_benchmark_convert_installed_acceptance.v1', plan_id: plan.plan_id, dispatch_count: 0, source_commit: expected.historical_source_commit })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
