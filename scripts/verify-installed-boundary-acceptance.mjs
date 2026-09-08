#!/usr/bin/env node
// Installed-public-CLI synthetic acceptance for the reviewed workflow boundary.
//
// Proves a real consumer of the installed `yylo-benchmark` package can go from
// project setup through plan, dry-run, zero-dispatch boundary readiness,
// synthetic dispatch/reconcile/recovery, and blinded governed judging without
// authoring launcher code, holding credentials, or dispatching any provider.
//
// usage: node verify-installed-boundary-acceptance.mjs --benchmark <installed yylo-benchmark> [--delegate <installed yy>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const benchmark = args.get('--benchmark');
const delegate = args.get('--delegate');
const normalYy = args.get('--normal-yy') === '1';
const junoVersion = args.get('--juno-version') ?? '0.0.0-acceptance';
if (!benchmark) {
  process.stderr.write('usage: node verify-installed-boundary-acceptance.mjs --benchmark <installed yylo-benchmark> [--delegate <installed yy>] [--normal-yy 1] [--juno-version <version>]\n');
  process.exit(2);
}

const temporary = await mkdtemp(path.join(tmpdir(), 'yylo-benchmark-boundary-acceptance-'));
const project = path.join(temporary, 'project');

function execute(executable, commandArgs, cwd = project, extraEnvironment = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^YYLO_BENCHMARK_(?:AUTH|REGISTRY|WORK_ROOT|BOUNDARY|JUNO)/u.test(key) && !/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/u.test(key)));
  env.PATH = `${path.dirname(path.resolve(benchmark))}${path.delimiter}${env.PATH ?? ''}`;
  Object.assign(env, extraEnvironment);
  const result = spawnSync(executable, commandArgs, { cwd, env, encoding: 'utf8', input: '', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(`${executable} ${commandArgs.join(' ')} failed (${result.error?.message ?? result.status ?? result.signal}): ${result.stderr || result.stdout}`);
  }
  return result;
}
function json(result) { return JSON.parse(result.stdout); }
function same(actual, wanted, label) {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} mismatch: ${JSON.stringify({ actual, wanted })}`);
}
function sha256(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

// A minimal read-only stand-in YYLO executable proves the boundary's exact
// identity checks without any provider or credential.
const fakeYy = path.join(temporary, 'fake-yy');
await writeFile(fakeYy, `#!/bin/sh
case "$1" in
  --version) echo "${junoVersion}"; exit 0 ;;
esac
printf 'unexpected invocation: %s\\n' "$*"
exit 3
`);
await chmod(fakeYy, 0o755);
// --normal-yy proves the identity surface against the real installed wrapper
// (PATH-resolved `yy`) instead of the stand-in: the boundary must probe the
// normal launcher successfully under the benchmark parent's environment.
let identityExecutable = fakeYy;
let identityVersion = junoVersion;
if (normalYy) {
  const resolved = spawnSync('sh', ['-c', 'command -v yy'], { encoding: 'utf8' });
  if (resolved.status !== 0 || !resolved.stdout.trim()) throw new Error('--normal-yy 1 requires a real `yy` executable on PATH');
  identityExecutable = resolved.stdout.trim();
  const probed = spawnSync(identityExecutable, ['--version'], { encoding: 'utf8', timeout: 60_000 });
  if (probed.status !== 0 || !/^\d+\.\d+\.\d+/.test(probed.stdout.trim())) throw new Error(`normal yy identity probe failed (${probed.status}): ${probed.stderr}`);
  identityVersion = probed.stdout.trim();
}
const identityEnvironment = { YYLO_BENCHMARK_JUNO_EXECUTABLE: identityExecutable, YYLO_BENCHMARK_JUNO_VERSION: identityVersion };

try {
  await mkdir(project, { recursive: true });
  execute('git', ['init', '-b', 'acceptance'], project);
  execute('git', ['config', 'user.email', 'acceptance@example.test'], project);
  execute('git', ['config', 'user.name', 'Acceptance'], project);
  await mkdir(path.join(project, 'scripts'), { recursive: true });
  await mkdir(path.join(project, '.juno_task', 'workflows'), { recursive: true });
  await mkdir(path.join(project, '.juno_task', 'specs', 'benchmark'), { recursive: true });
  await writeFile(path.join(project, 'scripts', 'track.py'), 'import sys\nprint("track argv:", sys.argv[1:])\n');
  await writeFile(path.join(project, 'yylo-benchmark.config.json'), JSON.stringify({
    schema_version: 'juno_benchmark_config.v1', repository_id: 'boundary-acceptance',
    model_aliases: { ':mini': 'openai-codex/gpt-5.6-terra' },
  }));
  await writeFile(path.join(project, '.juno_task/workflows/daily_product_ops.yaml'), `schema_version: 2
workflow_id: boundary-acceptance
variables:
  run_date: '1970-01-01'
steps:
  - id: analyze
    command:
      - yy
      - pi
      - |
        Analyze the $(run_date) snapshot without rewriting this prompt

        Context:
        - multiline prompt with blank lines
          and deeper continuation indentation
        Finish with one line.
  - id: compute
    command: [env, PYTHONPATH=., python3, scripts/track.py, "--date", "$(run_date)"]
  - id: review
    command: [yy, pi, "Review the retained evidence"]
  - id: summary
    command: [yy, pi, "Excluded summary"]
`);
  const rubricBytes = 'Accept only independently supported resolved work.';
  await writeFile(path.join(project, '.juno_task/specs/benchmark/daily-ops-policy.yaml'), JSON.stringify({
    schema_version: 'juno_benchmark_workflow_policy.v1',
    judge: { judge_id: 'governed-binary', judge_version: '1', model: 'openai-codex/gpt-5.6-sol', rubric_hash: sha256(rubricBytes), rubric: rubricBytes },
    authorization: { authorization_id: 'acceptance', production: true, spend: true },
    recovery: { ambiguous_effect: 'manual', max_recovery_attempts: 1 },
    redaction: { secret_patterns: ['TOKEN'], retain_prompts: false },
    deterministic_commands: [{ step_id: 'compute', executable: 'env', environment: [{ name: 'PYTHONPATH', value: '.' }], interpreter: 'python3', script: 'scripts/track.py', working_directory: '.' }],
    steps: [
      { step_id: 'analyze', scoring_id: 'analyze-score', side_effect: 'production', resources: [], limits: { timeout_ms: 10_000, max_usd: 1 }, authorization: 'production_and_spend', recovery: 'manual', redaction: { patterns: [], retain_prompt: false } },
      { step_id: 'compute', scoring_id: 'compute-score', side_effect: 'none', resources: [], limits: { timeout_ms: 10_000, max_usd: 0 }, authorization: 'none', recovery: 'retry_safe', redaction: { patterns: [], retain_prompt: false } },
      { step_id: 'review', scoring_id: 'review-score', side_effect: 'production', resources: [], limits: { timeout_ms: 10_000, max_usd: 1 }, authorization: 'production_and_spend', recovery: 'manual', redaction: { patterns: [], retain_prompt: false } },
      { step_id: 'summary', scoring_id: 'summary-score', side_effect: 'none', resources: [], limits: { timeout_ms: 10_000, max_usd: 1 }, authorization: 'none', recovery: 'manual', redaction: { patterns: [], retain_prompt: false } },
    ],
  }));
  execute('git', ['add', '.juno_task/workflows/daily_product_ops.yaml', '.juno_task/specs/benchmark/daily-ops-policy.yaml', 'scripts/track.py', 'yylo-benchmark.config.json'], project);
  execute('git', ['commit', '-m', 'acceptance fixture'], project);

  const setup = json(execute(benchmark, ['workflow', 'setup', '--synthetic'], project, identityEnvironment));
  if (setup.schema_version !== 'juno_benchmark_boundary_setup_receipt.v1') throw new Error('setup receipt schema is invalid');
  const installedBytes = await readFile(setup.environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY);
  if (sha256(installedBytes) !== `sha256:${setup.environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256}`) throw new Error('installed boundary bytes do not match the pinned digest');
  if (JSON.stringify(setup).includes('TOKEN') || JSON.stringify(setup).includes('API_KEY')) throw new Error('setup receipt leaked credential-shaped material');
  const boundaryEnvironment = {
    YYLO_BENCHMARK_WORKFLOW_BOUNDARY: setup.environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY,
    YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256: setup.environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256,
  };

  const readiness = json(execute(benchmark, ['workflow', 'readiness', '--models', ':mini,zai/glm-5.3'], project, { ...identityEnvironment, ...boundaryEnvironment }));
  same(readiness.dispatch_count, 0, 'readiness dispatch count');
  same(readiness.transport ?? readiness.boundary.transport, 'synthetic', 'readiness transport');
  same(readiness.providers, ['openai-codex', 'zai'], 'readiness providers');
  same(readiness.models.map((item) => item.model), ['openai-codex/gpt-5.6-terra', 'zai/glm-5.3'], 'readiness exact models');
  same(readiness.yylo.version, identityVersion, 'readiness YYLO version binding');
  if (JSON.stringify(readiness).includes('TOKEN') || JSON.stringify(readiness).includes('API_KEY')) throw new Error('readiness receipt leaked credential-shaped material');

  const planArgs = ['workflow', 'plan', '--workflow', '.juno_task/workflows/daily_product_ops.yaml', '--steps-file', '.juno_task/specs/benchmark/daily-ops-policy.yaml', '--steps', 'analyze,compute,review', '--models', ':mini,zai/glm-5.3', '--var', 'run_date=2026-08-19', '--output', 'plan.json', '--dry-run'];
  const plan = json(execute(benchmark, planArgs, project, { ...identityEnvironment, ...boundaryEnvironment }));
  // Delegate parity compares a fresh no-output invocation so exclusive plan
  // outputs from the first run cannot collide.
  const parityArgs = [];
  for (let index = 0; index < planArgs.length; index += 1) {
    if (planArgs[index] === '--output') { index += 1; continue; }
    parityArgs.push(planArgs[index]);
  }
  same(plan.selected_step_ids, ['analyze', 'compute', 'review'], 'selected steps');
  same(plan.execution_order.length, 6, 'three-step two-model matrix');
  if (plan.execution_order.some((item) => item.step_id === 'summary')) throw new Error('excluded summary step entered execution order');
  same(plan.models, ['openai-codex/gpt-5.6-terra', 'zai/glm-5.3'], 'exact models');
  same(plan.runtime_binding.juno_version, identityVersion, 'plan YYLO version');
  same(plan.runtime_binding.boundary.sha256, `sha256:${boundaryEnvironment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256}`, 'plan boundary binding');

  const dryRun = json(execute(benchmark, ['workflow', 'run', '--plan', 'plan.json', '--steps-file', '.juno_task/specs/benchmark/daily-ops-policy.yaml', '--dry-run'], project, { ...identityEnvironment, ...boundaryEnvironment }));
  same(dryRun.dispatch_count, 0, 'dry-run dispatch count');

  const run = json(execute(benchmark, ['workflow', 'run', '--plan', 'plan.json', '--steps-file', '.juno_task/specs/benchmark/daily-ops-policy.yaml'], project, { ...identityEnvironment, ...boundaryEnvironment }));
  same(run.plan_id, plan.plan_id, 'run plan binding');
  same(run.recovered, false, 'fresh run recovery');
  same(run.terminals.length, 6, 'ordered step terminals');
  same(run.judge_dispatch_count, 6, 'independent initial governed judgments');
  for (const terminal of run.terminals) {
    same(terminal.result.observed_model.split('/')[0], terminal.result.observed_provider, 'terminal identity composition');
    if (!terminal.result.runner_run_id.startsWith('synthetic-run-')) throw new Error('synthetic terminal was not labeled');
  }

  const rerun = json(execute(benchmark, ['workflow', 'run', '--plan', 'plan.json', '--steps-file', '.juno_task/specs/benchmark/daily-ops-policy.yaml'], project, { ...identityEnvironment, ...boundaryEnvironment }));
  same(rerun.recovered, true, 'duplicate dispatch guard');
  const recover = json(execute(benchmark, ['workflow', 'recover', '--plan', 'plan.json', '--steps-file', '.juno_task/specs/benchmark/daily-ops-policy.yaml'], project, { ...identityEnvironment, ...boundaryEnvironment }));
  same(recover.recovered, true, 'recovery without duplicate execution');

  const rejudge = json(execute(benchmark, ['workflow', 'rejudge', '--plan', 'plan.json', '--steps-file', '.juno_task/specs/benchmark/daily-ops-policy.yaml'], project, { ...identityEnvironment, ...boundaryEnvironment }));
  same(rejudge.candidate_dispatch_count, 0, 'rejudge candidate dispatch');
  same(rejudge.judge_dispatch_count, 0, 'valid retained judgments reused without duplicate judge dispatch');
  same(rejudge.boundary.sha256, `sha256:${boundaryEnvironment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256}`, 'rejudge boundary identity');
  const doctor = json(execute(benchmark, ['workflow', 'doctor', '--plan', 'plan.json', '--steps-file', '.juno_task/specs/benchmark/daily-ops-policy.yaml'], project, { ...identityEnvironment, ...boundaryEnvironment }));
  same(doctor.ok, true, 'governed doctor result');
  same(doctor.terminals, 6, 'doctor terminal count');
  const report = json(execute(benchmark, ['workflow', 'report', '--plan', 'plan.json'], project, { ...identityEnvironment, ...boundaryEnvironment }));
  same(report.receipt_count, 6, 'report receipt count');
  same(report.comparison.map((item) => item.step_id), ['analyze', 'compute', 'review'], 'report canonical selected steps');

  // A hash-consistent but unparsable compiled workflow must be rejected by the
  // boundary's own reader before any durable dispatch intent: no journal file
  // may exist and reconcile must report proven_not_dispatched, so a validation
  // failure before child spawn never becomes ambiguous manual recovery.
  {
    const stateRoot = path.join(project, '.juno_task', 'artifacts', 'yylo-benchmark', 'boundary-state');
    const bytes = Buffer.from('steps: [ {id: broken\n', 'utf8');
    const invalidInvocation = {
      dispatch_id: `sha256:${'e'.repeat(64)}`, invocation_hash: `sha256:${'f'.repeat(64)}`,
      plan_id: `sha256:${'1'.repeat(64)}`, model: 'openai-codex/gpt-5.6-terra', provider: 'openai-codex',
      attempt: 1, step_id: 'analyze', workflow_sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      workflow_bytes_base64: bytes.toString('base64'), variables: {}, timeout_ms: 10_000,
      deterministic_command: null, juno_version: identityVersion,
    };
    const driveBoundary = async (operation, invocation) => {
      const requestFile = path.join(temporary, `invalid-${operation}-request.json`);
      await writeFile(requestFile, `${JSON.stringify({ invocation })}\n`, { mode: 0o600 });
      const descriptor = openSync(requestFile, 'r');
      try {
        return spawnSync(process.execPath, ['--input-type=module', '-', operation, '--protocol', 'juno_benchmark_workflow_process_boundary.v1'],
          { input: installedBytes, env: { ...process.env, ...boundaryEnvironment, YYLO_BENCHMARK_BOUNDARY_STATE_ROOT: stateRoot }, stdio: ['pipe', 'pipe', 'pipe', descriptor], timeout: 60_000 });
      } finally { closeSync(descriptor); }
    };
    const rejection = await driveBoundary('dispatch', invalidInvocation);
    if (rejection.status !== 1) throw new Error(`unparsable compiled bytes were not rejected (exit ${rejection.status})`);
    const rejectionDocument = JSON.parse(rejection.stdout.toString());
    if (rejectionDocument.schema_version !== 'juno_benchmark_boundary_error.v1' || !/cannot be parsed/u.test(rejectionDocument.message)) {
      throw new Error(`unparsable compiled bytes rejection was not the parser contract: ${rejection.stdout}`);
    }
    const journals = await readdir(stateRoot).catch(() => []);
    const invalidHex = 'e'.repeat(64);
    if (journals.includes(`dispatch-${invalidHex}.intent.json`)) throw new Error('validation rejection left a durable dispatch intent for the rejected dispatch identity');
    const reconcile = await driveBoundary('reconcile', invalidInvocation);
    if (reconcile.status !== 0 || JSON.parse(reconcile.stdout.toString()).state !== 'proven_not_dispatched') {
      throw new Error(`validation rejection did not reconcile as proven_not_dispatched: ${reconcile.stdout}`);
    }
  }

  // Synthetic transport spawned no step children: the deterministic tracked
  // script never executed, proving zero external effect.
  try { await stat(path.join(project, 'track-ran.txt')); throw new Error('synthetic acceptance executed a step child'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }

  if (delegate) {
    const delegated = execute(delegate, ['benchmark', ...parityArgs], project, { ...identityEnvironment, ...boundaryEnvironment });
    const standalone = execute(benchmark, parityArgs, project, { ...identityEnvironment, ...boundaryEnvironment });
    if (delegated.stdout !== standalone.stdout || delegated.stderr !== standalone.stderr) throw new Error('delegated plan differs from standalone');
  }

  process.stdout.write(`${JSON.stringify({ schema_version: 'juno_benchmark_boundary_installed_acceptance.v1', plan_id: plan.plan_id, dispatch_count: 0, provider_dispatch_count: 0, boundary_sha256: `sha256:${boundaryEnvironment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256}` })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
