import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeSourceRepository, git } from '../snapshot/real-git.js';

async function phase2() {
  return Promise.all([
    import('../../src/v2/workspace.js'),
    import('../../src/v2/harness.js'),
  ]).then(([workspace, harness]) => ({ ...workspace, ...harness })).catch(() => null);
}

async function roots() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yylo-benchmark-v2-phase2-'));
  const registry = path.join(root, 'private-registry');
  const attempts = path.join(root, 'attempts');
  await mkdir(registry, { recursive: true, mode: 0o700 });
  await mkdir(attempts, { recursive: true, mode: 0o700 });
  return { root, registry, attempts };
}

const terminal = (selector: string, overrides: Record<string, unknown> = {}) => ({
  status: 'success' as const,
  exit_code: 0,
  signal: null,
  session_id: `session-${selector.replace(/\W/gu, '-')}`,
  resolved_provider: selector.split('/')[0] ?? selector,
  resolved_model: selector,
  observed_provider: selector.split('/')[0] ?? selector,
  observed_model: selector,
  harness_version: 'fake-1',
  started_at: '2026-01-01T00:00:00.000Z',
  ended_at: '2026-01-01T00:00:01.000Z',
  runtime_ms: 1000,
  cost: { completeness: 'unavailable' as const, usd: null },
  process: { pid: 123, command: ['fake', selector] },
  artifacts: [],
  ...overrides,
});

describe('fSC4KN phase 2 isolated workspace and provider-agnostic harness', () => {
  it('P2-A1 creates private fresh-repository attempts with isolated roots and registry/sibling invisibility', async () => {
    const api = await phase2();
    expect(api, 'v2 workspace and harness modules must exist').not.toBeNull();
    const source = await makeSourceRepository();
    const { registry, attempts } = await roots();
    await writeFile(path.join(registry, 'secret'), 'private');
    const first = await api!.createAttemptWorkspace({ attemptId: `sha256:${'1'.repeat(64)}`, sourceRepository: source.root, baseCommit: source.commit, attemptsRoot: attempts, privateRegistryRoot: registry, excludedPaths: ['.juno_task', 'hidden-reference'] });
    const second = await api!.createAttemptWorkspace({ attemptId: `sha256:${'2'.repeat(64)}`, sourceRepository: source.root, baseCommit: source.commit, attemptsRoot: attempts, privateRegistryRoot: registry, excludedPaths: ['.juno_task', 'hidden-reference'] });
    expect(first.receipt.backend).toBe('fresh_repository');
    expect(first.receipt.isolation).toMatchObject({ git_objects: 'isolated', host_filesystem: 'trusted', sibling_discovery: 'not_exposed', private_registry: 'not_exposed' });
    expect(first.candidateEnvironment.YYLO_BENCHMARK_REGISTRY).toBeUndefined();
    expect(Object.values(first.candidateEnvironment)).not.toContain(registry);
    expect(first.assertCandidateVisible(second.repository)).toBe(false);
    expect(first.assertCandidateVisible(registry)).toBe(false);
    expect((await stat(first.repository)).mode & 0o077).toBe(0);
    await expect(api!.doctorAttemptWorkspace(first, { sourceRepository: source.root })).resolves.toMatchObject({ ok: true });
  });

  it('keeps nested own paths separate from explicit protection on creation and reload', async () => {
    const api = (await phase2())!; const source = await makeSourceRepository();
    const options = { attemptId: `sha256:${'a'.repeat(64)}` as const, sourceRepository: source.root,
      baseCommit: source.commit, attemptsRoot: path.join(source.root, 'attempts'),
      privateRegistryRoot: path.join(source.root, 'registry'), excludedPaths: ['.juno_task', 'hidden-reference'],
      inheritedEnvironment: { SOURCE_HINT: source.root, PATH: '/usr/bin:/bin' } };
    const workspace = await api.createAttemptWorkspace(options);
    expect(workspace.candidateEnvironment.SOURCE_HINT).toBeUndefined();
    const log = path.join(workspace.repository, 'own.log');
    await writeFile(log, `own path: ${workspace.repository}\n`);
    const result = await api.publishAttemptWorkspaceResult(workspace);
    await expect(api.doctorAttemptWorkspace({ ...workspace, resultManifest: result }, { sourceRepository: source.root })).resolves.toMatchObject({ ok: true });
    const loaded = await api.loadAttemptWorkspace(options);
    await expect(api.doctorAttemptWorkspace(loaded, { sourceRepository: source.root })).resolves.toMatchObject({ ok: true });
    const explicit = await api.loadAttemptWorkspace({ ...options, controllerPaths: [source.root] });
    await expect(api.doctorAttemptWorkspace(explicit, { sourceRepository: source.root })).rejects.toThrow(/prohibited reference/u);
    for (const text of [source.root, options.privateRegistryRoot, `${workspace.repository}/../../outside`, 'api_key=abcdefghijklmnop']) {
      await writeFile(log, text);
      const { captureRepositoryResult } = await import('../../src/snapshot/index.js');
      const resultManifest = await captureRepositoryResult(workspace.repository);
      await expect(api.doctorAttemptWorkspace({ ...loaded, resultManifest }, { sourceRepository: source.root })).rejects.toThrow(/prohibited reference|credential-like/u);
    }
  });

  it('P2-A2 preserves historical Git isolation from future objects, refs, remotes, alternates, worktree links, and controller routing', async () => {
    const api = await phase2();
    expect(api, 'v2 workspace and harness modules must exist').not.toBeNull();
    const source = await makeSourceRepository();
    const { registry, attempts } = await roots();
    const workspace = await api!.createAttemptWorkspace({ attemptId: `sha256:${'3'.repeat(64)}`, sourceRepository: source.root, baseCommit: source.commit, attemptsRoot: attempts, privateRegistryRoot: registry, controllerPaths: ['/private/controller'], excludedPaths: ['.juno_task', 'hidden-reference'] });
    await writeFile(path.join(source.root, 'future.txt'), 'future');
    await git(source.root, 'add', 'future.txt');
    await git(source.root, 'commit', '--quiet', '-m', 'future');
    const futureBlob = await git(source.root, 'rev-parse', 'HEAD:future.txt');
    await expect(git(workspace.repository, 'cat-file', '-e', futureBlob)).rejects.toThrow();
    await expect(api!.doctorAttemptWorkspace(workspace, { sourceRepository: source.root })).resolves.toMatchObject({ ok: true });
  });

  it('P2-A3 passes at least three opaque selectors through one harness without provider or spend admission', async () => {
    const api = await phase2();
    expect(api, 'v2 workspace and harness modules must exist').not.toBeNull();
    const run = vi.fn(async (request: { requestedModel: string }) => terminal(request.requestedModel));
    const adapter = { profileId: 'fake', version: '1', probe: async () => ({ ready: true as const }), prepare: async () => ({ prepared: true as const }), run, reconcile: async () => ({ state: 'ambiguous' as const, reason: 'unknown external effect' }) };
    const { root } = await roots();
    for (const selector of ['openai-codex/gpt-future', 'zai/glm-next', 'local:custom/alpha']) {
      const result = await api!.runHarnessAttempt({ attemptId: `sha256:${Buffer.from(selector).toString('hex').padEnd(64, '0').slice(0, 64)}`, requestedModel: selector, cwd: root, environment: {}, intentRoot: path.join(root, 'intents'), adapter });
      expect(result.requested_model).toBe(selector);
      expect(result.validity).toBe('valid');
      expect(result.cost).toEqual({ completeness: 'unavailable', usd: null });
    }
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('P2-A4 retains identity mismatch, missing session, timeout, signal, and incomplete cost as separate truth', async () => {
    const api = await phase2();
    expect(api, 'v2 workspace and harness modules must exist').not.toBeNull();
    const { root } = await roots();
    const cases = [
      [terminal('vendor/model', { observed_model: 'other/model' }), 'identity_mismatch'],
      [terminal('vendor/model', { session_id: null }), 'missing_session'],
      [terminal('vendor/model', { status: 'timeout', exit_code: null }), 'timeout'],
      [terminal('vendor/model', { status: 'failure', exit_code: null, signal: 'SIGTERM', cost: { completeness: 'partial', usd: 0.25 } }), 'signal'],
    ] as const;
    for (let index = 0; index < cases.length; index += 1) {
      const [candidate, expected] = cases[index]!;
      const adapter = { profileId: 'fake', version: '1', probe: async () => ({ ready: true as const }), prepare: async () => ({ prepared: true as const }), run: async () => candidate, reconcile: async () => ({ state: 'ambiguous' as const, reason: 'unknown' }) };
      const result = await api!.runHarnessAttempt({ attemptId: `sha256:${String(index + 4).repeat(64)}`, requestedModel: 'vendor/model', cwd: root, environment: {}, intentRoot: path.join(root, `intents-${index}`), adapter });
      expect(result.diagnostics.map((item: { code: string }) => item.code)).toContain(expected);
      if (expected === 'signal') expect(result.cost).toEqual({ completeness: 'partial', usd: 0.25 });
    }
  });

  it('P2-A5 sends the bound task and evaluator prompts through the public execution envelope and retains response bytes', async () => {
    const api = await phase2();
    expect(api, 'v2 workspace and harness modules must exist').not.toBeNull();
    const { root } = await roots();
    const executable = path.join(root, 'fake-yy.mjs');
    await writeFile(executable, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
if (prompt === 'stderr failure') { process.stderr.write('controller routing failed before dispatch'); process.exit(2); }
fs.writeFileSync(Number(process.env.YYLO_EXECUTION_EVIDENCE_FD), prompt);
process.stdout.write(JSON.stringify({schema_version:'juno_execution_envelope.v1',status:'success',session_id:'session-live-contract',provider:'vendor',model:'model',juno_version:'9.8.7',cost:{completeness:'complete',usd:0.25}}) + '\\n');
`);
    await chmod(executable, 0o700);
    const adapter = new api!.YyloPiHarnessAdapter({ executable, prompt: 'static placeholder', extraArgs: ['--no-tools'] });
    for (const [suffix, invocation, expectedPrompt] of [
      ['1', { kind: 'task', prompt: 'the exact task prompt', variables: {} }, 'the exact task prompt'],
      ['2', { kind: 'evaluator', prompt: 'the exact governed judge prompt' }, 'the exact governed judge prompt'],
    ] as const) {
      const result = await api!.runHarnessAttempt({ attemptId: `sha256:${suffix.repeat(64)}`, requestedModel: 'vendor/model', cwd: root,
        environment: { ...process.env }, invocation, intentRoot: path.join(root, `intents-${suffix}`), adapter });
      expect(result.validity).toBe('valid');
      expect(result.session_id).toBe('session-live-contract');
      expect(result.resolved_model).toBe('vendor/model');
      expect(result.observed_harness_version).toBe('9.8.7');
      expect(result.raw_output).toBe(expectedPrompt);
      expect(result.process?.command.slice(1, 3)).toEqual(['--execution-envelope', 'pi']);
      expect(result.process?.command).not.toContain('--json');
      expect(result.process!.command.indexOf('--no-tools')).toBeLessThan(result.process!.command.indexOf('-p'));
    }
    const failed = await api!.runHarnessAttempt({ attemptId: `sha256:${'3'.repeat(64)}`, requestedModel: 'vendor/model', cwd: root,
      environment: { ...process.env }, invocation: { kind: 'task', prompt: 'stderr failure' }, intentRoot: path.join(root, 'intents-3'), adapter });
    expect(failed.terminal_status).toBe('failure');
    expect(failed.raw_output).toContain('controller routing failed before dispatch');
  });

  it('P2-A5 persists intent before dispatch, reuses known terminals, and leaves ambiguous effects manual', async () => {
    const api = await phase2();
    expect(api, 'v2 workspace and harness modules must exist').not.toBeNull();
    const { root } = await roots();
    const intentRoot = path.join(root, 'intents');
    const run = vi.fn(async () => terminal('vendor/model'));
    const adapter = { profileId: 'fake', version: '1', probe: async () => ({ ready: true as const }), prepare: async () => ({ prepared: true as const }), run, reconcile: async () => ({ state: 'ambiguous' as const, reason: 'unknown external effect' }) };
    const input = { attemptId: `sha256:${'8'.repeat(64)}`, requestedModel: 'vendor/model', cwd: root, environment: {}, intentRoot, adapter };
    const first = await api!.runHarnessAttempt(input);
    const second = await api!.runHarnessAttempt(input);
    expect(first.terminal_hash).toBe(second.terminal_hash);
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(path.join(intentRoot, `${'8'.repeat(64)}.intent.json`), 'utf8')).schema_version).toBe('yylo_benchmark_harness_intent.v2');

    const ambiguousId = `sha256:${'9'.repeat(64)}`;
    await api!.writeHarnessIntentForRecovery({ attemptId: ambiguousId, requestedModel: 'vendor/model', intentRoot, harnessProfile: 'fake', harnessVersion: '1', cwd: root });
    const ambiguous = await api!.runHarnessAttempt({ ...input, attemptId: ambiguousId });
    expect(ambiguous).toMatchObject({ validity: 'invalid', recovery: 'manual', terminal_status: 'ambiguous' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
