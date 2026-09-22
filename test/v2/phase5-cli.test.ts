import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createProgram, runCli } from '../../src/cli/program.js';
import { canonicalHash } from '../../src/contracts/canonical.js';
import { resolveV2RuntimePaths, runV2Experiment } from '../../src/v2/cli.js';

const execFileAsync = promisify(execFile);
async function api() { return import('../../src/v2/cli.js').catch(() => null); }

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yylo-benchmark-v2-cli-'));
  await mkdir(path.join(root, 'scripts'));
  const harness = path.join(root, 'scripts', 'harness.mjs');
  await writeFile(harness, `const request=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON); const judge=request.invocation?.kind==='evaluator'; const now='2026-01-01T00:00:00.000Z'; process.stdout.write(JSON.stringify({status:'success',exit_code:0,signal:null,session_id:(judge?'judge-':'candidate-')+request.requestedModel,resolved_provider:request.requestedModel.split('/')[0],resolved_model:request.requestedModel,observed_provider:request.requestedModel.split('/')[0],observed_model:request.requestedModel,harness_version:'fixture-1',started_at:now,ended_at:now,runtime_ms:1,cost:{completeness:'not_applicable',usd:null},process:{pid:process.pid,command:['fixture']},artifacts:[],raw_output:judge?JSON.stringify({verdict:'pass'}):'candidate ok'}));`);
  const grader = path.join(root, 'scripts', 'grader.mjs');
  await writeFile(grader, `process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({passed:true,findings:[],rawOutput:'checks pass'})));`);
  await writeFile(path.join(root, 'workflow.yaml'), `name: passthrough\nworking_directory: nested\nenvironment: {SAFE: yes}\nsteps:\n  - id: arbitrary\n    executable: node\n    argv: [node, script.mjs]\n  - id: managed\n    managed_agent: {prompt: work}\n`);
  await writeFile(path.join(root, 'task.md'), 'repair the fixture');
  await execFileAsync('git', ['init', '--quiet', '--initial-branch', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  await execFileAsync('git', ['add', '--all'], { cwd: root });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const config = {
    schema_version: 'yylo_benchmark_config.v2', yylo_version: '0.2.1',
    workspace: { attempts_root: '.benchmark/attempts', registry_root: '.benchmark/registry' },
    default_candidate_harness: 'candidate',
    harnesses: {
      candidate: { kind: 'command', executable: process.execPath, arguments: [harness], timeout_ms: 5000 },
      judge: { kind: 'command', executable: process.execPath, arguments: [harness], timeout_ms: 5000 },
    },
    default_evaluators: ['checks', 'judge-v1'],
    evaluators: {
      checks: { kind: 'deterministic', profile_version: '1', generation: 1, required: true, correctness_gate: true, command: [process.execPath, grader] },
      'checks-v2': { kind: 'deterministic', profile_version: '1', generation: 2, required: true, correctness_gate: true, command: [process.execPath, grader] },
      'judge-v1': { kind: 'llm_judge', profile_version: '1', generation: 1, required: true, harness_profile: 'judge', requested_model: 'judge-vendor/model-j', system_prompt: 'judge', prompt_template: '{{evidence}}\\n{{rubric}}', rubric: 'correct', evidence_fields: ['candidate.status', 'artifacts', 'identity'], max_evidence_bytes: 4096, identity_visibility: 'blinded', mode: 'single', timeout_ms: 5000, repetitions: 1, aggregation: 'majority', parser: 'strict_json', settings: {} },
      'judge-v2': { kind: 'llm_judge', profile_version: '1', generation: 2, required: true, harness_profile: 'judge', requested_model: 'another-vendor/model-k', system_prompt: 'judge again', prompt_template: '{{evidence}}\\n{{rubric}}', rubric: 'correct', evidence_fields: ['candidate.status'], max_evidence_bytes: 4096, identity_visibility: 'visible', mode: 'single', timeout_ms: 5000, repetitions: 1, aggregation: 'majority', parser: 'strict_json', settings: {} },
    },
  };
  await writeFile(path.join(root, 'yylo-benchmark.config.json'), JSON.stringify(config));
  return root;
}

async function capture(root: string, args: string[]): Promise<Record<string, any>> {
  const output: string[] = [];
  await runCli(args, { cwd: root, stdout: (text) => output.push(text) });
  return JSON.parse(output.join('')) as Record<string, any>;
}

describe('f922O3 phase 5 v2 CLI cutover and restrictive v1 retirement', () => {
  it('validates and plan-binds optional deterministic budgets without changing omitted legacy profiles', async () => {
    const root = await fixture(); const module = (await api())!;
    const configPath = path.join(root, 'yylo-benchmark.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const old = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'old.json']);
    expect(old.evaluator_profiles[0]).not.toHaveProperty('timeoutMs');
    for (const value of [0, -1, 1.5, '600000', null]) {
      config.evaluators.checks.timeout_ms = value; await writeFile(configPath, JSON.stringify(config));
      await expect(module.loadV2Config(root)).rejects.toThrow(/timeout_ms/u);
    }
    config.evaluators.checks.timeout_ms = 600000; await writeFile(configPath, JSON.stringify(config));
    const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'new.json']);
    expect(plan.evaluator_profiles[0].timeoutMs).toBe(600000);
    expect(plan.plan_hash).not.toBe(old.plan_hash);
    config.evaluators.checks.timeout_ms = 600001; await writeFile(configPath, JSON.stringify(config));
    await expect(capture(root, ['run', '--plan', 'new.json', '--dry-run'])).rejects.toThrow(/config/u);
  });

  it('accepts a valid deterministic command beyond the legacy sixty-second ceiling', async () => {
    const root = await fixture(); const configPath = path.join(root, 'yylo-benchmark.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.evaluators.checks.timeout_ms = 90000;
    config.evaluators.checks.command = [process.execPath, '-e',
      'process.stdin.resume();setTimeout(()=>process.stdout.write(JSON.stringify({passed:true,findings:[],rawOutput:"long check"})),61000)'];
    await writeFile(configPath, JSON.stringify(config));
    await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
    const run = await capture(root, ['run', '--plan', 'plan.json']);
    expect(run.attempts[0].evaluation.records[0]).toMatchObject({ validity: 'valid', quality: 'resolved' });
    expect(run.attempts[0].evaluation.records[0].runtime_ms).toBeGreaterThan(60000);
  }, 110000);

  it('uses the explicit deterministic budget and skips judges on its timeout', async () => {
    const root = await fixture(); const configPath = path.join(root, 'yylo-benchmark.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.evaluators.checks.timeout_ms = 25;
    config.evaluators.checks.command = [process.execPath, '-e', 'setTimeout(()=>{},1000)'];
    await writeFile(configPath, JSON.stringify(config));
    await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
    const run = await capture(root, ['run', '--plan', 'plan.json']);
    expect(run.attempts[0].evaluation.records[0]).toMatchObject({ validity: 'invalid', quality: 'unknown',
      findings: [{ message: 'deterministic evaluator timed out' }] });
    expect(run.attempts[0].evaluation.records[1].findings[0].code).toBe('judge_not_dispatched');
  });

  it('P5-A1 exposes plan/run/recover/regrade/rejudge/doctor/report with v2 help and no spend, provider, boundary, policy-sidecar, or overlay options', async () => {
    expect(await api(), 'v2 CLI module must exist').not.toBeNull();
    let help = '';
    createProgram().configureOutput({ writeOut: (text) => { help += text; } }).outputHelp();
    for (const command of ['plan', 'run', 'recover', 'regrade', 'rejudge', 'doctor', 'report']) expect(help).toMatch(new RegExp(`\\b${command}\\b`, 'u'));
    expect(help).not.toMatch(/authorization|max-usd|spend|steps-file|boundary|provider allowlist|overlay/iu);
  });

  it('P5-A2 runs task and arbitrary workflow plans through isolated v2 evidence/evaluators with yylo_version and cost-only economics', async () => {
    expect(await api(), 'v2 CLI module must exist').not.toBeNull();
    const root = await fixture();
    const workflowPlan = await capture(root, ['plan', '--workflow', 'workflow.yaml', '--models', 'vendor-a/model-1,vendor-b/model-2', '--controlled-model-variable', 'candidate_model', '--output', 'workflow-plan.json']);
    expect(workflowPlan).toMatchObject({ schema_version: 'yylo_benchmark_experiment_plan.v2', yylo_version: '0.2.1', comparison_kind: 'model_only' });
    expect(JSON.stringify(workflowPlan)).not.toContain('juno_version');
    expect(JSON.stringify(workflowPlan)).not.toMatch(/authorization|max_usd|spend/iu);
    const run = await capture(root, ['run', '--plan', 'workflow-plan.json']);
    expect(run).toMatchObject({ schema_version: 'yylo_benchmark_run_receipt.v2', candidate_dispatch_count: 2 });
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts[0].evidence.schema_version).toBe('yylo_benchmark_attempt_evidence.v2');
    expect(run.attempts[0].evaluation.quality).toBe('resolved');
    const taskPlan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor-c/model-3', '--output', 'task-plan.json']);
    expect(taskPlan.attempts[0].case.kind).toBe('task');
  });

  it('binds command-harness terminal truth to measured nonzero exits and signals', async () => {
    for (const outcome of ['nonzero', 'signal'] as const) {
      const root = await fixture();
      const harness = path.join(root, 'scripts', `contradictory-${outcome}.mjs`);
      await writeFile(harness, `const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);const now=new Date().toISOString();const terminal={status:'success',exit_code:0,signal:null,session_id:'claimed-success',resolved_provider:'vendor',resolved_model:r.requestedModel,observed_provider:'vendor',observed_model:r.requestedModel,harness_version:'fixture-1',started_at:now,ended_at:now,runtime_ms:1,cost:{completeness:'not_applicable',usd:null},process:{pid:1,command:['claimed']},artifacts:[],raw_output:'claimed success'};process.stdout.write(JSON.stringify(terminal),()=>{${outcome === 'signal' ? "process.kill(process.pid,'SIGTERM')" : 'process.exit(42)'}});`);
      const configPath = path.join(root, 'yylo-benchmark.config.json');
      const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
      config.harnesses.candidate.arguments = [harness];
      await writeFile(configPath, JSON.stringify(config));
      const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
      const run = await capture(root, ['run', '--plan', 'plan.json']);
      expect(run.attempts[0].evidence.candidate).toMatchObject({ status: 'failure', exit_code: outcome === 'nonzero' ? 42 : null,
        signal: outcome === 'signal' ? 'SIGTERM' : null });
      expect(run.attempts[0].evidence.candidate.process).not.toMatchObject({ pid: 1, command: ['claimed'] });
    }
  });

  it('publishes invalid terminal and evidence truth for malformed command-harness output', async () => {
    const payloads = [
      { source: `const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);process.stdout.write(JSON.stringify({status:'success',cost:{completeness:'not_applicable',usd:null},artifacts:[],raw_output:'omitted identity'}));`, status: 'success' },
      { source: `const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);process.stdout.write(JSON.stringify({status:'unsupported',exit_code:0,signal:null,session_id:'candidate-session',resolved_provider:'vendor',resolved_model:r.requestedModel,observed_provider:'vendor',observed_model:r.requestedModel,harness_version:'fixture-1',cost:{completeness:'not_applicable',usd:null},artifacts:[],raw_output:'unsupported status'}));`, status: 'invalid' },
      { source: `process.stdout.write('{not-json');`, status: 'invalid' },
      { source: `const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);const t={status:'unsupported',session_id:'candidate-session',resolved_provider:'vendor',resolved_model:r.requestedModel,observed_provider:'vendor',observed_model:r.requestedModel,harness_version:'fixture-1',cost:{completeness:'not_applicable',usd:null},artifacts:[]};process.stdout.write(JSON.stringify(t),()=>process.exit(42));`, status: 'failure' },
      { source: `const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);const t={status:'unsupported',session_id:'candidate-session',resolved_provider:'vendor',resolved_model:r.requestedModel,observed_provider:'vendor',observed_model:r.requestedModel,harness_version:'fixture-1',cost:{completeness:'not_applicable',usd:null},artifacts:[]};process.stdout.write(JSON.stringify(t),()=>process.kill(process.pid,'SIGTERM'));`, status: 'failure' },
      { source: `const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);process.stdout.write(JSON.stringify({status:'success',session_id:'candidate-session',sessionId:'unsupported-alias',resolved_provider:'vendor',resolved_model:r.requestedModel,observed_provider:'vendor',observed_model:r.requestedModel,harness_version:'fixture-1',cost:{completeness:'not_applicable',usd:null},artifacts:[]}));`, status: 'success' },
      { source: `const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);process.stdout.write(JSON.stringify({status:'success',measured_status:'failure',session_id:'candidate-session',resolved_provider:'vendor',resolved_model:r.requestedModel,observed_provider:'vendor',observed_model:r.requestedModel,harness_version:'fixture-1',cost:{completeness:'not_applicable',usd:null},artifacts:[]}));`, status: 'success' },
      { source: `const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);process.stdout.write(JSON.stringify({status:'success',session_id:'candidate-session',resolved_provider:'vendor',resolved_model:r.requestedModel,observed_provider:'vendor',observed_model:r.requestedModel,harness_version:'fixture-1',cost:{completeness:'not_applicable',usd:null},artifacts:[{role:'result',sha256:'sha256:'+('a'.repeat(64)),size:1,unsupported:true}]}));`, status: 'success' },
    ];
    for (const [index, payload] of payloads.entries()) {
      const root = await fixture(); const harness = path.join(root, 'scripts', `malformed-${index}.mjs`);
      await writeFile(harness, payload.source);
      const configPath = path.join(root, 'yylo-benchmark.config.json');
      const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
      config.harnesses.candidate.arguments = [harness]; await writeFile(configPath, JSON.stringify(config));
      const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
      const run = await capture(root, ['run', '--plan', 'plan.json']);
      expect(run.attempts[0].evidence.candidate).toMatchObject({ status: 'invalid', validity: 'invalid' });
      expect(run.attempts[0].evidence.candidate.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'malformed_protocol_field' }),
      ]));
      expect(run.attempts[0].evaluation).toMatchObject({ validity: 'invalid', quality: 'unknown' });
      const runtime = await resolveV2RuntimePaths({ cwd: root, plan: plan as never, attemptIndex: 0 });
      const terminal = JSON.parse(await readFile(path.join(runtime.intents, `${plan.attempts[0].attempt_id.slice(7)}.terminal.json`), 'utf8')) as Record<string, unknown>;
      expect(terminal).toMatchObject({ terminal_status: payload.status, validity: 'invalid' });
      expect(terminal.terminal_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
  });

  it('rejects every malformed nested attempt before dry-run success or fresh dispatch', async () => {
    const root = await fixture();
    const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
    const rebuild = (mutate: (attempt: Record<string, any>) => void, rehashAttempt = true) => {
      const attempt = structuredClone(plan.attempts[0]) as Record<string, any>;
      mutate(attempt);
      if (rehashAttempt) { const { plan_hash: _attemptHash, ...attemptCore } = attempt; attempt.plan_hash = canonicalHash(attemptCore); }
      const { plan_hash: _planHash, ...planCore } = plan;
      const attempts = [attempt];
      return { ...planCore, attempts, plan_hash: canonicalHash({ ...planCore, attempts }) } as never;
    };
    const malformed = [
      rebuild((attempt) => { attempt.requested_model = 'vendor/changed'; }),
      rebuild((attempt) => { attempt.case.source.commit = '0'.repeat(40); }),
      rebuild((attempt) => { attempt.evaluators[0].config_hash = `sha256:${'0'.repeat(64)}`; }),
      rebuild((attempt) => { attempt.requested_model = 'vendor/changed-with-stale-hash'; }, false),
      rebuild((attempt) => { attempt.case.normalized_input.prompt = 'forged prompt'; }),
      rebuild((attempt) => { attempt.case.source.candidate_manifest_hash = `sha256:${'1'.repeat(64)}`; }),
    ];
    for (const candidate of malformed) {
      await expect(runV2Experiment({ cwd: root, plan: candidate, dryRun: true })).rejects.toThrow(/attempt plan|attempt evaluator|candidate manifest/iu);
      await expect(runV2Experiment({ cwd: root, plan: candidate })).rejects.toThrow(/attempt plan|attempt evaluator|candidate manifest/iu);
    }
    const { plan_hash: _outerHash, ...outerCore } = plan;
    const mismatched = { ...outerCore, case_kind: 'workflow', plan_hash: canonicalHash({ ...outerCore, case_kind: 'workflow' }) } as never;
    await expect(runV2Experiment({ cwd: root, plan: mismatched, dryRun: true })).rejects.toThrow(/attempt plan identity/iu);
  });

  it('rejects source commit/tree drift before a dry run or candidate dispatch', async () => {
    const root = await fixture(); const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
    await writeFile(path.join(root, 'source-drift.txt'), 'drift'); await execFileAsync('git', ['add', 'source-drift.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'source drift'], { cwd: root });
    await expect(runV2Experiment({ cwd: root, plan: plan as never, dryRun: true })).rejects.toThrow(/actual source commit\/tree/iu);
    await expect(runV2Experiment({ cwd: root, plan: plan as never })).rejects.toThrow(/actual source commit\/tree/iu);
  });

  it('re-derives the selected evaluators and complete model/attempt matrix from direct-call plans', async () => {
    const root = await fixture(); const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/a,vendor/b', '--attempts', '2', '--output', 'plan.json']);
    const forge = (changes: Record<string, unknown>) => {
      const { plan_hash: _claimed, ...core } = plan; const forgedCore = { ...core, ...changes };
      return { ...forgedCore, plan_hash: canonicalHash(forgedCore) } as never;
    };
    for (const forged of [forge({ evaluator_profiles: [] }), forge({ attempts: plan.attempts.slice(0, 2) })]) {
      await expect(runV2Experiment({ cwd: root, plan: forged, dryRun: true })).rejects.toThrow(/experiment.*(?:evaluator|identity|matrix)|attempt.*evaluator/iu);
      await expect(runV2Experiment({ cwd: root, plan: forged })).rejects.toThrow(/experiment.*(?:evaluator|identity|matrix)|attempt.*evaluator/iu);
    }
  });

  it('rejects duplicate evaluator selections before planning or dispatch', async () => {
    const root = await fixture(); const module = await api();
    await expect(module!.createV2ExperimentPlan({ cwd: root, benchmarkVersion: 'test', task: 'task.md', models: ['vendor/model'], attempts: 1,
      evaluatorIds: ['checks', 'checks'] })).rejects.toThrow(/evaluator profile\/generation must be unique/iu);
  });

  it('re-derives tracked case, repository, and nested version provenance before dry-run or dispatch', async () => {
    const root = await fixture(); const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
    const rehashAttempt = (attempt: Record<string, any>, changes: Record<string, unknown>) => {
      const { plan_hash: _claimed, ...core } = { ...attempt, ...changes };
      return { ...core, plan_hash: canonicalHash(core) };
    };
    const rehashOuter = (changes: Record<string, unknown>) => {
      const { plan_hash: _claimed, ...core } = { ...plan, ...changes };
      return { ...core, plan_hash: canonicalHash(core) } as never;
    };
    const normalized = { ...plan.attempts[0].case.normalized_input, prompt: 'substituted prompt' };
    const forgedCase = { ...plan.attempts[0].case, normalized_input: normalized, normalized_input_hash: canonicalHash(normalized) };
    const attemptId = canonicalHash({ experiment_id: plan.attempts[0].experiment_id, case_hash: forgedCase.normalized_input_hash,
      attempt_index: plan.attempts[0].attempt_index, harness_profile: plan.attempts[0].harness_profile, requested_model: plan.attempts[0].requested_model });
    const promptAttempt = rehashAttempt(plan.attempts[0], { case: forgedCase, attempt_id: attemptId });
    const repository = 'https://example.invalid/unrelated.git';
    const repositoryAttempt = rehashAttempt(plan.attempts[0], { case: { ...plan.attempts[0].case,
      source: { ...plan.attempts[0].case.source, repository } } });
    const caseVersionAttempt = rehashAttempt(plan.attempts[0], { case: { ...plan.attempts[0].case, yylo_version: 'forged-version' } });
    for (const forged of [rehashOuter({ attempts: [promptAttempt] }),
      rehashOuter({ source_repository: repository, attempts: [repositoryAttempt] }),
      rehashOuter({ attempts: [caseVersionAttempt] }),
      rehashOuter({ yylo_version: 'forged-version' }), rehashOuter({ benchmark_version: 'forged-version' })]) {
      await expect(runV2Experiment({ cwd: root, plan: forged, dryRun: true })).rejects.toThrow(/tracked source case|actual source repository|attempt plan identity/iu);
      await expect(runV2Experiment({ cwd: root, plan: forged })).rejects.toThrow(/tracked source case|actual source repository|attempt plan identity/iu);
    }
  });

  it('binds the selected config path, complete exclusions, and actual candidate manifest into the workspace receipt', async () => {
    const root = await fixture(); const original = await readFile(path.join(root, 'yylo-benchmark.config.json'));
    await writeFile(path.join(root, 'identical-config.json'), original);
    const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
    await expect(runV2Experiment({ cwd: root, configPath: 'identical-config.json', plan: plan as never, dryRun: true })).rejects.toThrow(/config path drifted/iu);
    const run = await runV2Experiment({ cwd: root, plan: plan as never }); expect(run.candidate_dispatch_count).toBe(1);
    const runtime = await resolveV2RuntimePaths({ cwd: root, plan: plan as never, attemptIndex: 0 });
    const retained = JSON.parse(await readFile(path.join(runtime.workspaceRoot, '.workspace.json'), 'utf8')) as Record<string, any>;
    expect(plan.snapshot_exclusions).toContain('yylo-benchmark.config.json');
    expect(retained.snapshot.excluded_paths).toEqual(plan.snapshot_exclusions);
    expect(retained.receipt.candidate_manifest_hash).toBe(plan.attempts[0].case.source.candidate_manifest_hash);
  });

  it('keeps generated-default candidate roots and environment outside source and private control topology', async () => {
    const root = await fixture();
    const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'yylo-topology-probe-'));
    const harness = path.join(probeRoot, 'topology-probe.mjs');
    const siblingHint = path.join(probeRoot, 'sibling-hint');
    await writeFile(harness, `import{existsSync,readFileSync,readdirSync}from'node:fs';import path from'node:path';const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);const hint=${JSON.stringify(siblingHint)};let sibling=null;let readable=0;if(existsSync(hint)){sibling=readFileSync(hint,'utf8');try{readdirSync(sibling);readable=1}catch{}}const probe={cwd:process.cwd(),pwd:process.env.PWD??null,oldpwd:process.env.OLDPWD??null,initCwd:process.env.INIT_CWD??null,projectRoot:process.env.PROJECT_ROOT??null,controllerRoot:process.env.CONTROLLER_ROOT??null,registryPath:process.env.REGISTRY_PATH??null,pathLeaksSource:(process.env.PATH??'').includes(process.env.EXPECTED_SOURCE??'never'),sourceRoute:existsSync(path.resolve(process.cwd(),'../../../../.juno_task')),registryRoute:existsSync(path.resolve(process.cwd(),'../../../registry')),siblingDiscovered:sibling!==null,siblingReadable:readable};const now=new Date().toISOString();process.stdout.write(JSON.stringify({status:'success',exit_code:0,signal:null,session_id:'probe',resolved_provider:'vendor',resolved_model:r.requestedModel,observed_provider:'vendor',observed_model:r.requestedModel,harness_version:'fixture-1',started_at:now,ended_at:now,runtime_ms:1,cost:{completeness:'not_applicable',usd:null},process:{pid:process.pid,command:['probe']},artifacts:[],raw_output:JSON.stringify(probe)}));`);
    const configPath = path.join(root, 'yylo-benchmark.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    config.workspace = { attempts_root: '.yylo-benchmark/attempts', registry_root: '.yylo-benchmark/registry' };
    config.harnesses.candidate.arguments = [harness];
    await writeFile(configPath, JSON.stringify(config));
    const controller = await mkdtemp(path.join(os.tmpdir(), 'yylo-controller-root-'));
    const namespace = canonicalHash({ source_repository: await realpath(root), attempts_root: config.workspace.attempts_root,
      registry_root: config.workspace.registry_root }).slice(7);
    const registry = path.join(os.homedir(), '.local', 'state', 'yylo-benchmark', 'registry', namespace);
    const previous = { PROJECT_ROOT: process.env.PROJECT_ROOT, CONTROLLER_ROOT: process.env.CONTROLLER_ROOT, REGISTRY_PATH: process.env.REGISTRY_PATH,
      EXPECTED_SOURCE: process.env.EXPECTED_SOURCE, PATH: process.env.PATH };
    try {
      process.env.PROJECT_ROOT = root; process.env.CONTROLLER_ROOT = controller; process.env.REGISTRY_PATH = registry; process.env.EXPECTED_SOURCE = root;
      process.env.PATH = `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${previous.PATH ?? ''}`;
      const firstPlan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/one', '--output', 'plan-one.json']);
      const firstRun = await capture(root, ['run', '--plan', 'plan-one.json']);
      const firstCandidate = firstRun.attempts[0].evidence.candidate;
      // Some hardened Linux hosts install bubblewrap but disable the user
      // namespace it requires. That must remain a diagnosed, fail-closed result,
      // never a reason to dispatch the probe without filesystem isolation.
      if (process.platform === 'linux' && firstCandidate.status !== 'success') {
        expect(firstCandidate).toMatchObject({ exit_code: 1, status: 'invalid', validity: 'invalid' });
        expect(firstCandidate.output).toMatch(/bwrap:.*permission denied/iu);
        return;
      }
      expect(firstCandidate, JSON.stringify(firstCandidate)).toMatchObject({ exit_code: 0, status: 'success' });
      const first = JSON.parse(firstCandidate.output) as Record<string, any>;
      // Cross-run fixture coordination belongs to the trusted test parent. The
      // candidate sandbox must never gain write access to this external path.
      await writeFile(siblingHint, path.resolve(first.cwd, '..'));
      const alias = path.join(probeRoot, 'source-alias'); await symlink(root, alias);
      const secondPlan = await capture(alias, ['plan', '--task', 'task.md', '--models', 'vendor/two', '--output', 'plan-two.json']);
      const secondRun = await capture(alias, ['run', '--plan', 'plan-two.json']);
      const secondCandidate = secondRun.attempts[0].evidence.candidate;
      expect(secondCandidate, JSON.stringify(secondCandidate.diagnostics)).toMatchObject({ exit_code: 0, status: 'success' });
      expect(firstPlan.experiment_id).not.toBe(secondPlan.experiment_id);
      const second = JSON.parse(secondCandidate.output) as Record<string, any>;
      expect(first).toMatchObject({ pwd: null, oldpwd: null, initCwd: null, projectRoot: null, controllerRoot: null, registryPath: null,
        pathLeaksSource: false, sourceRoute: false, registryRoute: false, siblingDiscovered: false, siblingReadable: 0 });
      expect(path.resolve(first.cwd)).not.toContain(path.resolve(root));
      expect(second.siblingDiscovered).toBe(true);
      expect(second.siblingReadable).toBe(0);
    } finally {
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });

  it('retains bounded command-harness stderr when launch or protocol output fails', async () => {
    const root = await fixture();
    const harness = path.join(root, 'scripts', 'stderr-failure.mjs');
    // Exit from the write callback: process.exit() drops queued pipe bytes past
    // the 64KiB kernel buffer, which would bypass the truncation path under test.
    await writeFile(harness, `process.stderr.write('sandbox launch denied: '+''.padEnd(96*1024,'x'),()=>process.exit(1));`);
    const configPath = path.join(root, 'yylo-benchmark.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    config.harnesses.candidate.arguments = [harness];
    await writeFile(configPath, JSON.stringify(config));
    const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/one', '--output', 'stderr-plan.json']);
    const run = await capture(root, ['run', '--plan', 'stderr-plan.json']);
    const candidate = run.attempts[0].evidence.candidate;
    expect(candidate).toMatchObject({ exit_code: 1, status: 'invalid', validity: 'invalid' });
    expect(Buffer.byteLength(candidate.output, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(candidate.output).toMatch(/^sandbox launch denied: .*\[command harness diagnostic truncated\]\n$/su);
  });

  it('P5-A3 recovers known terminals and appends regrade/rejudge generations without candidate redispatch', async () => {
    expect(await api(), 'v2 CLI module must exist').not.toBeNull();
    const root = await fixture();
    const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
    await capture(root, ['run', '--plan', 'plan.json']);
    // Crash window: workspace, intent, and hash-valid terminal are durable, but state publication is absent.
    const runtime = await resolveV2RuntimePaths({ cwd: root, plan: plan as never, attemptIndex: 0 });
    await rm(path.join(runtime.registry, 'v2', 'runs', plan.experiment_id.slice(7), `${plan.attempts[0].attempt_id.slice(7)}.json`));
    const recovered = await capture(root, ['recover', '--plan', 'plan.json']);
    expect(recovered).toMatchObject({ candidate_dispatch_count: 0, reused_terminal_count: 1, ambiguous_count: 0 });
    const regraded = await capture(root, ['regrade', '--plan', 'plan.json', '--profile', 'checks-v2']);
    expect(regraded).toMatchObject({ candidate_dispatch_count: 0, evaluator_dispatch_count: 1 });
    const rejudged = await capture(root, ['rejudge', '--plan', 'plan.json', '--profile', 'judge-v2']);
    expect(rejudged).toMatchObject({ candidate_dispatch_count: 0, evaluator_dispatch_count: 1 });
    expect(rejudged.attempts[0].evaluation_records.map((item: { evaluator_generation: number }) => item.evaluator_generation)).toContain(2);
  });

  it('P5-A4 doctor and report retain provenance, evaluator generations, invalidity, candidate/judge cost, and comparison classification', async () => {
    expect(await api(), 'v2 CLI module must exist').not.toBeNull();
    const root = await fixture();
    await capture(root, ['plan', '--workflow', 'workflow.yaml', '--models', 'vendor/model', '--output', 'plan.json']);
    await capture(root, ['run', '--plan', 'plan.json']);
    const doctor = await capture(root, ['doctor', '--plan', 'plan.json']);
    expect(doctor).toMatchObject({ schema_version: 'yylo_benchmark_doctor.v2', ok: true, candidate_dispatch_count: 1, ambiguous_count: 0 });
    const report = await capture(root, ['report', '--plan', 'plan.json']);
    expect(report).toMatchObject({ schema_version: 'yylo_benchmark_report.v2', comparison_kind: 'agent_system', evidence_count: 1, valid_resolved: 1, valid_unresolved: 0 });
    expect(report.valid_resolved + report.valid_unresolved + report.unknown_quality).toBe(report.evidence_count);
    expect(report).toHaveProperty('candidate_cost');
    expect(report).toHaveProperty('judge_cost');
    expect(report.provenance.evaluation_ids.length).toBeGreaterThan(0);
  });

  it('P5-A5 standalone and delegated argv/cwd/streams/exits remain package-independent and the packed CLI supports no-dispatch help/plan/doctor', async () => {
    const module = await api();
    expect(module, 'v2 CLI module must exist').not.toBeNull();
    expect(module!.V2_CLI_SCHEMA_VERSION).toBe('yylo_benchmark_cli.v2');
    const builtins = await readFile(path.join(process.cwd(), 'src', 'cli', 'builtins.ts'), 'utf8');
    expect(builtins).not.toMatch(/TaskExecutionAuthorization|createWorkflowPlanFromProject|workflowBoundary|BOUNDARY_SUPPORTED_PROVIDERS|--steps-file|--max-usd/iu);
  });
});
