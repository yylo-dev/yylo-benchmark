import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createProgram, runCli } from '../../src/cli/program.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'governed-workflow-cli-'));
  await mkdir(path.join(root, '.juno_task', 'workflows'), { recursive: true });
  await mkdir(path.join(root, '.juno_task', 'specs', 'benchmark'), { recursive: true });
  const workflow = `schema_version: 2
workflow_id: daily-ops-consumer
steps:
  - id: first
    command: [yy, pi, "First task"]
  - id: second
    command: [yy, pi, "Second task"]
  - id: third
    command: [yy, pi, "Third task"]
  - id: summary
    command: [yy, pi, "Summarize"]
`;
  const rubricBytes = 'Accept only evidence-supported resolved work.';
  const rubricHash = `sha256:${createHash('sha256').update(rubricBytes).digest('hex')}`;
  const step = (id: string) => ({ step_id: id, scoring_id: `${id}-score`, side_effect: 'production',
    resources: [{ type: 'production', id: 'DAILY_OPS', access: 'exclusive' }], limits: { timeout_ms: 5000, max_usd: 1 },
    authorization: 'production_and_spend', recovery: 'manual', redaction: { patterns: ['SECRET'], retain_prompt: false } });
  const policy = { schema_version: 'juno_benchmark_workflow_policy.v1',
    judge: { judge_id: 'governed-sol', judge_version: '1', model: 'openai-codex/gpt-5.6-sol', rubric_hash: rubricHash, rubric: rubricBytes },
    authorization: { authorization_id: 'consumer-owned', production: true, spend: true },
    recovery: { ambiguous_effect: 'manual', max_recovery_attempts: 1 }, redaction: { secret_patterns: ['SECRET'], retain_prompts: false },
    estimates: { models: [
      { model: 'zai/glm-alpha', candidate_usd: 1, judge_usd: 0.25, runtime_ms: 1000 },
      { model: 'zai/glm-beta', candidate_usd: 1, judge_usd: 0.25, runtime_ms: 1000 },
    ] }, steps: ['first', 'second', 'third', 'summary'].map(step) };
  await writeFile(path.join(root, '.juno_task', 'workflows', 'daily_product_ops.yaml'), workflow);
  await writeFile(path.join(root, '.juno_task', 'specs', 'benchmark', 'daily-ops-policy.json'), JSON.stringify(policy));
  await writeFile(path.join(root, 'yylo-benchmark.config.json'), JSON.stringify({ schema_version: 'juno_benchmark_config.v1', repository_id: 'consumer',
    model_aliases: {}, environment: { env_file: '.env.yylo', legacy_env_file: '.env.juno' } }));
  execFileSync('git', ['init', '--quiet', '--initial-branch', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', '.juno_task/workflows', '.juno_task/specs/benchmark'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'consumer workflow'], { cwd: root });
  return root;
}

async function capture(root: string, args: string[]): Promise<Record<string, any>> {
  const output: string[] = [];
  await runCli(args, { cwd: root, stdout: (text) => output.push(text) });
  return JSON.parse(output.join('')) as Record<string, any>;
}

describe('public governed workflow CLI lane', () => {
  it('keeps isolated v2 top-level commands and exposes the complete governed namespace', () => {
    const program = createProgram();
    const workflow = program.commands.find((item) => item.name() === 'workflow');
    expect(workflow).toBeDefined();
    expect(workflow!.commands.map((item) => item.name())).toEqual(expect.arrayContaining([
      'setup', 'readiness', 'plan', 'run', 'recover', 'rejudge', 'doctor', 'report', 'migrate-config',
    ]));
    expect(program.commands.map((item) => item.name())).toEqual(expect.arrayContaining(['plan', 'run', 'workflow']));
  });

  it('plans three canonical steps by two arbitrary exact selectors with zero dispatch and immutable overlays', async () => {
    const root = await fixture();
    const priorVersion = process.env['YYLO_BENCHMARK_JUNO_VERSION'];
    const priorBoundary = process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY'];
    const priorHash = process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256'];
    const boundary = path.join(root, 'reviewed-boundary.mjs');
    await writeFile(boundary, 'export default null;\n');
    const digest = createHash('sha256').update(await readFile(boundary)).digest('hex');
    process.env['YYLO_BENCHMARK_JUNO_VERSION'] = '0.2.2'; process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY'] = boundary;
    process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256'] = digest;
    try {
      const plan = await capture(root, ['--config', 'yylo-benchmark.config.json', 'workflow', 'plan',
        '--workflow', '.juno_task/workflows/daily_product_ops.yaml', '--steps-file', '.juno_task/specs/benchmark/daily-ops-policy.json',
        '--steps', 'first,second,third', '--models', 'zai/glm-alpha,zai/glm-beta', '--attempts', '1', '--var', 'run_date=2026-09-08',
        '--output', 'plan.json', '--dry-run']);
      expect(plan).toMatchObject({ schema_version: 'juno_benchmark_workflow_plan.v2', dispatch_count: 0,
        selected_step_ids: ['first', 'second', 'third'], models: ['zai/glm-alpha', 'zai/glm-beta'],
        runtime_binding: { juno_version: '0.2.2', boundary: { sha256: `sha256:${digest}` } } });
      expect(plan.execution_order.map((item: any) => `${item.model}:${item.step_id}`)).toEqual([
        'zai/glm-alpha:first', 'zai/glm-alpha:second', 'zai/glm-alpha:third',
        'zai/glm-beta:first', 'zai/glm-beta:second', 'zai/glm-beta:third',
      ]);
      expect(plan.execution_order).toHaveLength(6);
      expect(plan.execution_order.some((item: any) => item.step_id === 'summary')).toBe(false);
      for (const compiled of plan.compiled_workflows) {
        const value = parse(Buffer.from(compiled.workflow_bytes_base64, 'base64').toString('utf8')) as any;
        const selected = value.steps.filter((item: any) => ['first', 'second', 'third'].includes(item.id));
        expect(selected.map((item: any) => item.command.slice(0, 4))).toEqual([
          ['yy', 'pi', '--model', compiled.model],
          ['yy', 'pi', '--model', compiled.model],
          ['yy', 'pi', '--model', compiled.model],
        ]);
      }
      const dry = await capture(root, ['--config', 'yylo-benchmark.config.json', 'workflow', 'run', '--plan', 'plan.json',
        '--steps-file', '.juno_task/specs/benchmark/daily-ops-policy.json', '--dry-run']);
      expect(dry).toMatchObject({ dispatch_count: 0, production_models_sequential: true });
      expect(dry.order.map(({ dispatch_id: _dispatch, ...item }: any) => item)).toEqual(plan.execution_order);
      expect(JSON.stringify(dry)).not.toContain('summary');
    } finally {
      if (priorVersion === undefined) delete process.env['YYLO_BENCHMARK_JUNO_VERSION']; else process.env['YYLO_BENCHMARK_JUNO_VERSION'] = priorVersion;
      if (priorBoundary === undefined) delete process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY']; else process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY'] = priorBoundary;
      if (priorHash === undefined) delete process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256']; else process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256'] = priorHash;
    }
  });

  it('diagnoses configuration lanes and never overwrites', async () => {
    const root = await fixture();
    const governed = await capture(root, ['workflow', 'migrate-config']);
    expect(governed).toMatchObject({ detected_lane: 'governed_workflow', action: 'none' });
    await writeFile(path.join(root, 'isolated.json'), JSON.stringify({ schema_version: 'yylo_benchmark_config.v2' }));
    const diagnosis = await capture(root, ['workflow', 'migrate-config', '--input', 'isolated.json']);
    expect(diagnosis).toMatchObject({ detected_lane: 'isolated_v2', action: 'explicit_output_required' });
    await capture(root, ['workflow', 'migrate-config', '--input', 'isolated.json', '--output', 'governed.json']);
    await expect(capture(root, ['workflow', 'migrate-config', '--input', 'isolated.json', '--output', 'governed.json'])).rejects.toThrow();
  });
});
