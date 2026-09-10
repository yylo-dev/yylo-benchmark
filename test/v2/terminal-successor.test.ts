import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { canonicalHash } from '../../src/contracts/canonical.js';
import { createProgram, runCli } from '../../src/cli/program.js';
import { assertProcessTreeSupported, linuxBubblewrapArguments, runCapturedProcess } from '../../src/v2/process.js';
import { doctorV2Experiment, parseV2ExperimentPlan, reportV2Experiment, resolveV2RuntimePaths, type V2ExperimentPlan } from '../../src/v2/cli.js';
import { createAttemptWorkspace, doctorAttemptWorkspace } from '../../src/v2/workspace.js';

const execFileAsync = promisify(execFile);
const hash = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const evidence = {
  schema_version: 'yylo_benchmark_attempt_evidence.v2' as const,
  yylo_version: '2.0.0', benchmark_version: '2.0.0', attempt_id: hash('1'), plan_hash: hash('2'),
  candidate: { status: 'success' as const, exit_code: 0, signal: null, session_id: 'candidate', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:01.000Z', runtime_ms: 1000, cost: { completeness: 'not_applicable' as const, usd: null }, output: 'ok', validity: 'valid' as const, diagnostics: [] },
  identity: { harness_profile: 'candidate', requested_model: 'vendor/model', resolved_provider: 'vendor', resolved_model: 'vendor/model', observed_provider: 'vendor', observed_model: 'vendor/model', observed_harness_version: '1' },
  workspace_receipt_hash: hash('3'), workspace_manifest_hash: hash('5'), artifacts: [], evidence_hash: hash('4'),
};
const gate = { profileId: 'gate', profileVersion: '1', generation: 1, kind: 'deterministic' as const, required: true, correctnessGate: true };
const judge = { profileId: 'judge', profileVersion: '1', generation: 2, kind: 'llm_judge' as const, required: true, harnessProfile: 'unused', requestedModel: 'judge/model', systemPrompt: { inline: 'judge' }, promptTemplate: { inline: '{{evidence}}' }, rubric: { inline: 'safe' }, evidenceFields: ['candidate.status'], maxEvidenceBytes: 4096, identityVisibility: 'visible' as const, mode: 'single' as const, timeoutMs: 100, repetitions: 1, aggregation: 'all' as const, parser: { kind: 'strict_json' as const }, settings: {} };

async function cliFixture(harnessDelayMs = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yylo-terminal-successor-'));
  await mkdir(path.join(root, 'scripts'));
  const harness = path.join(root, 'scripts', 'harness.mjs');
  const grader = path.join(root, 'scripts', 'grader.mjs');
  await writeFile(harness, `import{writeFileSync}from'node:fs';import{execFileSync}from'node:child_process';const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);if(r.invocation?.prompt?.includes('mutate')){writeFileSync('task.md','candidate edit\\n');writeFileSync('candidate-added.txt','candidate add\\n');execFileSync('git',['add','--all']);execFileSync('git',['commit','--quiet','-m','candidate result']);}const now=new Date().toISOString();setTimeout(()=>process.stdout.write(JSON.stringify({status:'success',exit_code:0,signal:null,session_id:'s-'+r.attemptId,resolved_provider:'vendor',resolved_model:r.requestedModel,observed_provider:'vendor',observed_model:r.requestedModel,harness_version:'1',started_at:now,ended_at:now,runtime_ms:1,cost:{completeness:'not_applicable',usd:null},process:{pid:process.pid,command:['fixture']},artifacts:[],raw_output:r.invocation?.kind==='evaluator'?'{"verdict":"pass"}':'ok'})),${harnessDelayMs});`);
  await writeFile(grader, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({passed:true,findings:[],rawOutput:'ok'})));`);
  await writeFile(path.join(root, 'task.md'), 'task');
  await execFileAsync('git', ['init', '--quiet', '--initial-branch', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  await execFileAsync('git', ['add', '--all'], { cwd: root });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const config = { schema_version: 'yylo_benchmark_config.v2', yylo_version: '2', workspace: { attempts_root: '.benchmark/attempts', registry_root: '.benchmark/registry' }, default_candidate_harness: 'candidate', harnesses: { candidate: { kind: 'command', executable: process.execPath, arguments: [harness], timeout_ms: 1000 } }, default_evaluators: ['gate'], evaluators: { gate: { kind: 'deterministic', profile_version: '1', generation: 1, required: true, correctness_gate: true, command: [process.execPath, grader] } } };
  await writeFile(path.join(root, 'yylo-benchmark.config.json'), JSON.stringify(config));
  return root;
}
async function capture(root: string, args: string[]) { const output: string[] = []; await runCli(args, { cwd: root, stdout: (text) => output.push(text) }); return JSON.parse(output.join('')) as Record<string, any>; }

function record(profile: typeof gate, quality: 'resolved' | 'unresolved') {
  const core = { schema_version: 'yylo_benchmark_evaluation_record.v2' as const, yylo_version: evidence.yylo_version, attempt_id: evidence.attempt_id, evidence_hash: evidence.evidence_hash,
    evaluator_profile_id: profile.profileId, evaluator_generation: profile.generation, evaluator_kind: profile.kind, validity: 'valid' as const, quality, required_gate: profile.required,
    findings: [], cost: { completeness: 'not_applicable' as const, usd: null }, runtime_ms: 1, provenance_hash: canonicalHash({ profile_hash: canonicalHash(profile), evidence_hash: evidence.evidence_hash }),
    profile_hash: canonicalHash(profile), prompt_hash: null, rubric_hash: null, raw_output: quality, raw_output_hash: canonicalHash(quality), evaluator_session_ids: [], evaluator_identity: null };
  return { ...core, evaluation_id: canonicalHash(core) };
}

describe('fT49yV terminal successor contracts', () => {
  it('8lyWtv-001 excludes common ambient cloud credentials and doctor rejects the identical classes', async () => {
    const root = await cliFixture(); const commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    const external = await mkdtemp(path.join(os.tmpdir(), 'yylo-credential-boundary-'));
    const workspace = await createAttemptWorkspace({ attemptId: hash('a'), sourceRepository: root, baseCommit: commit,
      attemptsRoot: path.join(external, 'attempts'), privateRegistryRoot: path.join(external, 'registry'),
      inheritedEnvironment: { PATH: process.env.PATH, AWS_ACCESS_KEY_ID: 'access', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'session',
        GOOGLE_APPLICATION_CREDENTIALS: '/credentials.json', AZURE_CLIENT_SECRET: 'azure', SSH_AUTH_SOCK: '/agent.sock',
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials', AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/credentials',
        AWS_CONFIG_FILE: '/host/aws/config', GIT_ASKPASS: '/host/git-askpass', SSH_ASKPASS: '/host/ssh-askpass', SAFE_VALUE: 'retained' } });
    expect(workspace.candidateEnvironment).toMatchObject({ SAFE_VALUE: 'retained' });
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CLIENT_SECRET',
      'SSH_AUTH_SOCK', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONFIG_FILE', 'GIT_ASKPASS', 'SSH_ASKPASS']) {
      expect(workspace.candidateEnvironment[name]).toBeUndefined();
      await expect(doctorAttemptWorkspace({ ...workspace, candidateEnvironment: { ...workspace.candidateEnvironment, [name]: 'ambient' } }))
        .rejects.toThrow(new RegExp(`credential environment.*${name}`, 'iu'));
    }
  });

  it('qWJc7U-A1 canonicalizes arbitrary path-bearing environment values while preserving the active Node toolchain', async () => {
    const root = await cliFixture(); const commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    const external = await mkdtemp(path.join(os.tmpdir(), 'yylo-toolchain-boundary-')); const nvm = path.join(external, 'nvm');
    const bin = path.join(nvm, 'versions', 'node', 'v22', 'bin');
    const alias = path.join(external, 'source-alias'); await symlink(root, alias);
    await mkdir(path.join(root, 'child')); await mkdir(path.join(root, 'bin'));
    const childAlias = path.join(external, 'child-alias'); await symlink(path.join(root, 'child'), childAlias);
    const parentPathAlias = `${childAlias}/../bin`;
    const workspace = await createAttemptWorkspace({ attemptId: hash('b'), sourceRepository: root, baseCommit: commit,
      attemptsRoot: path.join(external, 'attempts'), privateRegistryRoot: path.join(external, 'registry'),
      inheritedEnvironment: { NVM_DIR: nvm, PATH: `${bin}${path.delimiter}${parentPathAlias}`, UNRELATED_ALIAS: path.join(root, 'intermediate', '..'), SOURCE_GLOB: `${alias}/*.secret`,
        PARENT_ALIAS: `${childAlias}/../task.md` } });
    expect(workspace.candidateEnvironment).toMatchObject({ NVM_DIR: nvm, PATH: bin });
    expect(workspace.candidateEnvironment.UNRELATED_ALIAS).toBeUndefined();
    expect(workspace.candidateEnvironment.SOURCE_GLOB).toBeUndefined();
    expect(workspace.candidateEnvironment.PARENT_ALIAS).toBeUndefined();
    await expect(doctorAttemptWorkspace(workspace, { sourceRepository: root })).resolves.toMatchObject({ ok: true });
    await expect(doctorAttemptWorkspace({ ...workspace, candidateEnvironment: { ...workspace.candidateEnvironment, SOURCE_GLOB: `${alias}/*.secret` } },
      { sourceRepository: root })).rejects.toThrow(/protected source or controller reference/iu);
    await expect(doctorAttemptWorkspace({ ...workspace, candidateEnvironment: { ...workspace.candidateEnvironment, PARENT_ALIAS: `${childAlias}/../task.md` } },
      { sourceRepository: root })).rejects.toThrow(/protected source or controller reference/iu);
    await expect(doctorAttemptWorkspace({ ...workspace, candidateEnvironment: { ...workspace.candidateEnvironment, PATH: `${bin}${path.delimiter}${parentPathAlias}` } },
      { sourceRepository: root })).rejects.toThrow(/protected source or controller reference/iu);
    const relativeTraversal = '../../../..';
    const nestedWorkspace = await createAttemptWorkspace({ attemptId: hash('c'), sourceRepository: root, baseCommit: commit,
      attemptsRoot: path.join(root, '.benchmark', 'attempts'), privateRegistryRoot: path.join(root, '.benchmark', 'registry'),
      inheritedEnvironment: { PATH: relativeTraversal } });
    expect(path.resolve(nestedWorkspace.repository, relativeTraversal)).toBe(root);
    expect(nestedWorkspace.candidateEnvironment.PATH).toBeUndefined();
    await expect(doctorAttemptWorkspace({ ...nestedWorkspace, candidateEnvironment: { ...nestedWorkspace.candidateEnvironment, PATH: relativeTraversal } },
      { sourceRepository: root })).rejects.toThrow(/relative PATH environment entry/iu);
  });

  it('qWJc7U-A3 keeps every candidate-owned Linux process root writable under the read-only host bind', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yylo-bwrap-roots-')); const repository = path.join(root, 'repository');
    const home = path.join(root, 'home'); const temporary = path.join(root, 'tmp'); const cache = path.join(root, 'cache'); const config = path.join(root, 'config');
    const protectedRoot = path.join(root, 'protected');
    for (const directory of [repository, home, temporary, cache, config, protectedRoot]) await mkdir(directory);
    const argv = linuxBubblewrapArguments('/usr/bin/node', ['candidate.mjs'], { cwd: repository,
      environment: { HOME: home, TMPDIR: temporary, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: config } }, [protectedRoot]);
    expect(argv.join('\0')).toContain(`--bind\0${repository}\0${repository}`);
    for (const directory of [home, temporary, cache, config]) {
      const canonical = await realpath(directory); expect(argv.join('\0')).toContain(`--bind\0${canonical}\0${canonical}`);
    }
    expect(argv.join('\0')).toContain(`--tmpfs\0${protectedRoot}`);
    expect(argv.slice(-6)).toEqual([repository, '/usr/bin/env', '-u', 'PWD', '/usr/bin/node', 'candidate.mjs']);
  });

  it('8lyWtv-002 rejects zero attempts and duplicate attempt identities in plans, doctor, and report', async () => {
    const root = await cliFixture(); const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/a', '--output', 'plan.json']) as unknown as V2ExperimentPlan;
    const forged = (attempts: V2ExperimentPlan['attempts']): V2ExperimentPlan => {
      const { plan_hash: _claimed, ...core } = plan;
      return { ...core, attempts, plan_hash: canonicalHash({ ...core, attempts }) };
    };
    for (const invalid of [forged([]), forged([plan.attempts[0]!, plan.attempts[0]!])]) {
      expect(() => parseV2ExperimentPlan(invalid)).toThrow(/at least one attempt|duplicate planned attempt identity/iu);
      await expect(doctorV2Experiment({ cwd: root, plan: invalid })).rejects.toThrow(/at least one attempt|duplicate planned attempt identity/iu);
      await expect(reportV2Experiment({ cwd: root, plan: invalid })).rejects.toThrow(/at least one attempt|duplicate planned attempt identity/iu);
    }
  });

  it('8lyWtv-003 rejects symbolic/detached HEAD drift at an unchanged commit across every retained-chain consumer', async () => {
    const root = await cliFixture(); await writeFile(path.join(root, 'task.md'), 'mutate repository');
    await execFileAsync('git', ['add', 'task.md'], { cwd: root }); await execFileAsync('git', ['commit', '--quiet', '-m', 'mutating case'], { cwd: root });
    const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/a', '--output', 'plan.json']); await capture(root, ['run', '--plan', 'plan.json']);
    const repository = (await resolveV2RuntimePaths({ cwd: root, plan: plan as never, attemptIndex: 0 })).repository;
    const before = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
    await execFileAsync('git', ['checkout', '--quiet', '--detach', 'HEAD'], { cwd: repository });
    expect((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()).toBe(before);
    for (const args of [['run', '--plan', 'plan.json'], ['recover', '--plan', 'plan.json'], ['doctor', '--plan', 'plan.json'],
      ['report', '--plan', 'plan.json'], ['regrade', '--plan', 'plan.json', '--profile', 'gate']]) {
      await expect(capture(root, args)).rejects.toThrow(/post-execution repository\/workspace drift/iu);
    }
  });

  it('fT49yV-A1 binds intentional edited, added, and committed repository results through reuse, recovery, doctor, report, and re-evaluation', async () => {
    const root = await cliFixture(); await writeFile(path.join(root, 'task.md'), 'mutate repository');
    await execFileAsync('git', ['add', 'task.md'], { cwd: root }); await execFileAsync('git', ['commit', '--quiet', '-m', 'mutating case'], { cwd: root });
    const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/a', '--output', 'plan.json']);
    await capture(root, ['run', '--plan', 'plan.json']);
    await expect(capture(root, ['run', '--plan', 'plan.json'])).resolves.toMatchObject({ reused_terminal_count: 1 });
    await expect(capture(root, ['recover', '--plan', 'plan.json'])).resolves.toMatchObject({ reused_terminal_count: 1 });
    await expect(capture(root, ['doctor', '--plan', 'plan.json'])).resolves.toMatchObject({ ok: true, candidate_dispatch_count: 1 });
    await expect(capture(root, ['report', '--plan', 'plan.json'])).resolves.toMatchObject({ evidence_count: 1 });
    await expect(capture(root, ['regrade', '--plan', 'plan.json', '--profile', 'gate'])).resolves.toMatchObject({ evaluator_dispatch_count: 1 });
    const repository = (await resolveV2RuntimePaths({ cwd: root, plan: plan as never, attemptIndex: 0 })).repository;
    expect(await readFile(path.join(repository, 'task.md'), 'utf8')).toBe('candidate edit\n');
    expect(await readFile(path.join(repository, 'candidate-added.txt'), 'utf8')).toBe('candidate add\n');
    await writeFile(path.join(repository, 'later-drift.txt'), 'not bound');
    for (const args of [['run', '--plan', 'plan.json'], ['recover', '--plan', 'plan.json'], ['doctor', '--plan', 'plan.json'], ['report', '--plan', 'plan.json'], ['regrade', '--plan', 'plan.json', '--profile', 'gate']]) {
      await expect(capture(root, args)).rejects.toThrow(/post-execution.*drift|repository\/workspace drift/iu);
    }
  });

  it('qWJc7U-A2 retains explicitly configured trusted workspace roots', async () => {
    const root = await cliFixture(); const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/a', '--output', 'plan.json']);
    const runtime = await resolveV2RuntimePaths({ cwd: root, plan: plan as never, attemptIndex: 0 });
    expect(runtime.attemptsRoot).toBe(path.join(root, '.benchmark', 'attempts'));
    expect(runtime.registry).toBe(path.join(root, '.benchmark', 'registry'));
  });

  it('fT49yV-A2 makes doctor and report reject every incomplete planned state/workspace/intent/terminal/evidence chain', async () => {
    const cases = ['state', 'workspace', 'result-workspace', 'intent', 'terminal', 'evidence'] as const;
    for (const missing of cases) {
      const root = await cliFixture(); const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/a,vendor/b', '--output', 'plan.json']);
      await capture(root, ['run', '--plan', 'plan.json']); const attempt = plan.attempts[1]; const digest = attempt.attempt_id.slice(7);
      const runtime = await resolveV2RuntimePaths({ cwd: root, plan: plan as never, attemptIndex: 1 });
      const stateFile = path.join(runtime.registry, 'v2', 'runs', plan.experiment_id.slice(7), `${digest}.json`);
      if (missing === 'state') await rm(stateFile);
      else if (missing === 'workspace') await rm(path.join(runtime.workspaceRoot, '.workspace.json'));
      else if (missing === 'result-workspace') await rm(path.join(runtime.workspaceRoot, '.result-workspace.json'));
      else if (missing === 'intent' || missing === 'terminal') await rm(path.join(runtime.intents, `${digest}.${missing}.json`));
      else {
        const state = JSON.parse(await readFile(stateFile, 'utf8')); delete state.evidence; delete state.state_hash; state.state_hash = canonicalHash(state); await writeFile(stateFile, JSON.stringify(state));
      }
      await expect(capture(root, ['doctor', '--plan', 'plan.json']), missing).rejects.toThrow();
      await expect(capture(root, ['report', '--plan', 'plan.json']), missing).rejects.toThrow();
    }
  });
  it('Gwu1KD-A1 retains required deterministic failures across selective re-evaluation', async () => {
    const api = await import('../../src/v2/evaluators.js');
    const result = await api.reevaluateAttempt({ evidence, caseKind: 'task', existingRecords: [record(gate, 'unresolved')], profiles: [gate, judge], composition: { kind: 'explicit', profileIds: ['judge'], aggregation: 'all' }, deterministicEvaluators: {}, judgeAdapters: { unused: { profileId: 'unused', version: '1', probe: async () => ({ ready: true }), prepare: async () => ({ prepared: true }), reconcile: async () => ({ state: 'ambiguous', reason: 'none' }), run: async () => ({ status: 'success', exit_code: 0, signal: null, session_id: 'judge', resolved_provider: 'judge', resolved_model: 'judge/model', observed_provider: 'judge', observed_model: 'judge/model', harness_version: '1', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:00.001Z', runtime_ms: 1, cost: { completeness: 'not_applicable', usd: null }, process: { pid: 1, command: ['judge'] }, artifacts: [], raw_output: '{"verdict":"pass"}' }) } }, intentRoot: path.join(await mkdtemp(path.join(os.tmpdir(), 'judge-')), 'intent'), cwd: process.cwd() });
    expect(result.quality).toBe('unresolved');
    expect(result.required_gate_failures).toEqual(['gate']);
  });

  it('l9V5Xy-A0 keeps a historical required gate failure effective across a passing same-ID generation', async () => {
    const api = await import('../../src/v2/evaluators.js'); const nextGate = { ...gate, generation: 2 };
    const result = await api.reevaluateAttempt({ evidence, caseKind: 'task', existingRecords: [record(gate, 'unresolved')], profiles: [nextGate],
      composition: { kind: 'explicit', profileIds: ['gate'], aggregation: 'all' }, deterministicEvaluators: { gate: async () => ({ passed: true, findings: [], rawOutput: 'pass' }) },
      judgeAdapters: {}, intentRoot: path.join(await mkdtemp(path.join(os.tmpdir(), 'gate-next-')), 'intent'), cwd: process.cwd() });
    expect(result).toMatchObject({ quality: 'unresolved', required_gate_failures: ['gate'] });
  });

  it('Gwu1KD-A2 rejects cross-attempt replay of otherwise hash-valid retained state', async () => {
    const root = await cliFixture();
    const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/a,vendor/b', '--output', 'plan.json']);
    await capture(root, ['run', '--plan', 'plan.json']);
    const runtime = await resolveV2RuntimePaths({ cwd: root, plan: plan as never, attemptIndex: 0 });
    const registry = path.join(runtime.registry, 'v2', 'runs', plan.experiment_id.slice(7));
    const first = path.join(registry, `${plan.attempts[0].attempt_id.slice(7)}.json`);
    const second = path.join(registry, `${plan.attempts[1].attempt_id.slice(7)}.json`);
    await writeFile(second, await readFile(first));
    await expect(capture(root, ['doctor', '--plan', 'plan.json'])).rejects.toThrow(/identity|attempt|replay|linkage/iu);
  });

  it('Gwu1KD-A3 classifies malformed deterministic protocol output as invalid infrastructure truth', async () => {
    const api = await import('../../src/v2/evaluators.js');
    const malformed = await api.evaluateAttempt({ evidence, caseKind: 'task', profiles: [gate], composition: { kind: 'all_required' }, deterministicEvaluators: { gate: async () => ({ passed: 'yes', findings: [], rawOutput: 'malformed' } as never) }, judgeAdapters: {}, intentRoot: path.join(await mkdtemp(path.join(os.tmpdir(), 'malformed-')), 'intent'), cwd: process.cwd() });
    expect(malformed).toMatchObject({ quality: 'unknown', validity: 'invalid' });
    expect(malformed.records[0]).toMatchObject({ validity: 'invalid', quality: 'unknown' });
  });

  it('Gwu1KD-A4 bounds TERM-resistant descendant trees with process-group KILL and reap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'timeout-tree-')); const pidFile = path.join(root, 'descendant.pid');
    const script = path.join(root, 'resist.mjs');
    await writeFile(script, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(process.argv[2],String(c.pid));setTimeout(()=>process.exit(0),5000);setInterval(()=>{},1000);`);
    // Leave enough startup budget for a loaded release-suite host while still
    // proving the TERM-resistant tree is force-killed well before natural exit.
    const started = Date.now(); const result = await runCapturedProcess(process.execPath, [script, pidFile], { cwd: root, environment: process.env, timeoutMs: 1000, termGraceMs: 100 });
    expect(result.timedOut).toBe(true); expect(Date.now() - started).toBeLessThan(3000);
    const descendant = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(descendant, 0)).toThrow();
    expect(() => assertProcessTreeSupported('win32')).toThrow(/unsupported on Windows.*refusing dispatch/iu);
  });

  it('Gwu1KD-A5 reports measured millisecond attempt/evaluator/aggregate runtime provenance without merging costs', async () => {
    const root = await cliFixture(80); await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/a', '--output', 'plan.json']); await capture(root, ['run', '--plan', 'plan.json']);
    const report = await capture(root, ['report', '--plan', 'plan.json']);
    expect(report.runtime).toMatchObject({ unit: 'milliseconds', provenance: 'measured_wall_clock' });
    expect(report.runtime.attempts[0]).toMatchObject({ runtime_ms: expect.any(Number), evidence_hash: expect.stringMatching(/^sha256:/u) });
    expect(report.runtime.attempts[0].runtime_ms).toBeGreaterThanOrEqual(50);
    expect(report.runtime.evaluators[0]).toMatchObject({ runtime_ms: expect.any(Number), evaluation_id: expect.stringMatching(/^sha256:/u) });
    expect(report.runtime.aggregate).toMatchObject({ candidate: { count: 1, total_ms: expect.any(Number) }, evaluators: { count: 1, total_ms: expect.any(Number) } });
    expect(report).toHaveProperty('candidate_cost'); expect(report).toHaveProperty('judge_cost');
  });

  it('l9V5Xy-A1 appends immutable-plan-bound generations under one stable evaluator profile ID', async () => {
    const root = await cliFixture(); const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/a', '--output', 'plan.json']);
    await capture(root, ['run', '--plan', 'plan.json']);
    const second = await capture(root, ['regrade', '--plan', 'plan.json', '--profile', 'gate']);
    const third = await capture(root, ['regrade', '--plan', 'plan.json', '--profile', 'gate']);
    expect(second.attempts[0].evaluation_records.filter((item: any) => item.evaluator_profile_id === 'gate').map((item: any) => item.evaluator_generation)).toEqual([1, 2]);
    expect(third.attempts[0].evaluation_records.filter((item: any) => item.evaluator_profile_id === 'gate').map((item: any) => item.evaluator_generation)).toEqual([1, 2, 3]);
  });

  it('l9V5Xy-A2 rejects workspace and retained-terminal drift before doctor, report, or reuse', async () => {
    const workspaceRoot = await cliFixture(); const workspacePlan = await capture(workspaceRoot, ['plan', '--task', 'task.md', '--models', 'vendor/a', '--output', 'plan.json']);
    await capture(workspaceRoot, ['run', '--plan', 'plan.json']);
    const workspaceRuntime = await resolveV2RuntimePaths({ cwd: workspaceRoot, plan: workspacePlan as never, attemptIndex: 0 });
    await writeFile(path.join(workspaceRuntime.repository, 'drift.txt'), 'drift');
    await expect(capture(workspaceRoot, ['doctor', '--plan', 'plan.json'])).rejects.toThrow(/workspace|snapshot|drift|untracked|baseline/iu);

    const terminalRoot = await cliFixture(); const terminalPlan = await capture(terminalRoot, ['plan', '--task', 'task.md', '--models', 'vendor/a', '--output', 'plan.json']);
    await capture(terminalRoot, ['run', '--plan', 'plan.json']); const terminalDigest = terminalPlan.attempts[0].attempt_id.slice(7);
    const terminalRuntime = await resolveV2RuntimePaths({ cwd: terminalRoot, plan: terminalPlan as never, attemptIndex: 0 });
    await rm(path.join(terminalRuntime.intents, `${terminalDigest}.terminal.json`));
    await expect(capture(terminalRoot, ['report', '--plan', 'plan.json'])).rejects.toThrow(/terminal.*missing/iu);
  });

  it('Gwu1KD-R1 forwards every structured Workflow Runner variable canonically and losslessly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-vars-')); const argvFile = path.join(root, 'argv.json');
    const workflow = path.join(root, 'flow.yaml'); const runner = path.join(root, 'runner.mjs');
    await writeFile(workflow, 'name: fixture\n');
    await writeFile(runner, `#!/usr/bin/env node\nimport{writeFileSync}from'node:fs';writeFileSync(process.env.ARGV_FILE,JSON.stringify(process.argv.slice(2)));process.stdout.write('session_id=workflow-vars\\n');`);
    await chmod(runner, 0o755);
    const { WorkflowRunnerHarnessAdapter } = await import('../../src/v2/adapters.js');
    const adapter = new WorkflowRunnerHarnessAdapter({ profileId: 'arbitrary-workflow-profile', executable: runner, timeoutMs: 1000 });
    const { YyloPiHarnessAdapter } = await import('../../src/v2/harness.js');
    expect(adapter.profileId).toBe('arbitrary-workflow-profile');
    expect(new YyloPiHarnessAdapter({ profileId: 'init-generated-candidate', prompt: 'offline' }).profileId).toBe('init-generated-candidate');
    await adapter.run({ attemptId: hash('9'), requestedModel: 'vendor/model', cwd: root, environment: { ...process.env, ARGV_FILE: argvFile },
      invocation: { kind: 'workflow', workflow_path: 'flow.yaml', variables: { payload: { z: [1, true], mode: 'safe' }, labels: ['a', 'b'], enabled: true, count: 3, empty: null, text: 'plain' }, selected_scope: [] } });
    expect(JSON.parse(await readFile(argvFile, 'utf8'))).toEqual(['--workflow', 'flow.yaml', '--var', 'payload={"mode":"safe","z":[1,true]}', '--var', 'labels=["a","b"]', '--var', 'enabled=true', '--var', 'count=3', '--var', 'empty=null', '--var', 'text=plain']);
  });
});
