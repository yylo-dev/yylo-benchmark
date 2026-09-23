import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { capture } from './process.js';
import { TreatmentSchema, type Execution, type Treatment } from './contracts.js';

export function failure(message: string, runtime = 0): Execution {
  return { status: 'error', exit_code: null, signal: null, runtime_ms: runtime, stdout: '', stderr: '', response: '',
    observed_model: null, session_id: null, cost_usd: null, cost_completeness: 'unknown', diagnostic: message };
}
export function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GIT_|JUNO_|YYLO_|PI_)/.test(key) || key === 'PWD' || key === 'OLDPWD' || key === 'NODE_OPTIONS' || key === 'PYTHONPATH') delete env[key];
  }
  // Retain account authentication through the normal host environment. This is not filesystem/account isolation.
  return env;
}
function rejectOverrides(args: string[], reserved: string[]): void {
  if (args.some((arg) => reserved.some((key) => arg === key || arg.startsWith(`${key}=`) || key.length === 2 && arg.startsWith(key)))) throw new Error('harness arguments override benchmark-owned input/model/session/workflow options');
}
export function workflowPrefix(yaml: string, through?: string): string {
  if (!through) return yaml;
  const value = parse(yaml) as { steps?: { id?: string }[]; continue_from_step?: unknown };
  if (!value || !Array.isArray(value.steps) || value.continue_from_step !== undefined) throw new Error('prefix requires an ordinary steps workflow without continue_from_step');
  const ids = value.steps.map((step) => step?.id);
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('prefix requires unique step ids');
  const index = ids.indexOf(through); if (index < 0) throw new Error(`unknown workflow step: ${through}`);
  // Container projection only. No command rewriting, session conversion, dependency inference or repair.
  return stringify({ ...value, steps: value.steps.slice(0, index + 1) });
}
export async function invoke(input: {
  treatment: Treatment; prompt: string; workspace: string; control: string; workflow?: string | null;
}): Promise<Execution> {
  const start = Date.now();
  try {
    const treatment = TreatmentSchema.parse(input.treatment); const env = environment();
    await mkdir(input.control, { recursive: true });
    await writeFile(path.join(input.control, 'prompt.txt'), input.prompt, { flag: 'wx', mode: 0o600 });
    let workflowRequest: { path: string; variables: Record<string, unknown>; through: string | null } | null = null;
    if (treatment.workflow) {
      if (!input.workflow) throw new Error('workflow configuration requires a case workflow');
      const projected = workflowPrefix(input.workflow, treatment.workflow.through);
      const workflow = path.join(input.control, 'workflow.yaml'); await writeFile(workflow, projected, { flag: 'wx', mode: 0o600 });
      workflowRequest = { path: workflow, variables: { ...treatment.workflow.variables, [treatment.workflow.model_variable]: treatment.model }, through: treatment.workflow.through ?? null };
    }
    env['YYLO_BENCHMARK_REQUEST_JSON'] = JSON.stringify({ model: treatment.model, configuration: treatment.configuration, prompt: input.prompt, workflow: workflowRequest });
    let args = [...treatment.args]; let stdin = input.prompt;
    if (treatment.harness === 'yylo_pi') {
      rejectOverrides(args, ['--model', '-m', '--provider', '--prompt', '-p', '--prompt-file', '-f', '--cwd', '-w', '--resume', '-r', '--continue', '--additional-args', '--session-dir']);
      const sessions = path.join(input.control, 'sessions'); await mkdir(sessions);
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      args = ['--execution-envelope', 'pi', '--model', treatment.model, ...args, '--additional-args', `--session-dir ${quote(sessions)}`,
        '--prompt-file', path.join(input.control, 'prompt.txt')];
      env['YYLO_EXECUTION_EVIDENCE_FD'] = '3'; stdin = '';
    } else if (treatment.harness === 'workflow_runner') {
      if (!workflowRequest) throw new Error('workflow_runner requires a case workflow');
      rejectOverrides(args, ['--workflow', '-w', '--run-root', '--project-root', '--out-dir', '--var', '--from-step', '--amends-run', '--dry-run', '--tmux']);
      args = [...args, '--workflow', workflowRequest.path, '--run-root', input.workspace, '--out-dir', path.join(input.control, 'workflow-output'),
        ...Object.entries(workflowRequest.variables).flatMap(([key, value]) => ['--var', `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`])];
      stdin = '';
    }
    // Setup is an explicit harness-owned command, not a dependency installation framework.
    let setupMs = 0;
    if (treatment.setup) {
      const setup = await capture(treatment.setup.executable, treatment.setup.args, { cwd: input.workspace, env, timeoutMs: treatment.timeout_ms });
      setupMs = setup.runtimeMs;
      await writeFile(path.join(input.control, 'setup.log'), `${setup.stdout}\n${setup.stderr}`, { flag: 'wx', mode: 0o600 });
      if (setup.cancelled) return failure('cancelled', setupMs);
      if (setup.code !== 0 || setup.timedOut || setup.overflow) return failure(`setup failed${setup.timedOut ? ': timeout' : ''}: ${setup.stderr}`, setupMs);
    }
    const remaining = treatment.timeout_ms - (Date.now() - start);
    if (remaining <= 0) return { ...failure('setup exhausted attempt timeout', Date.now() - start), status: 'timed_out' };
    const result = await capture(treatment.executable, args, { cwd: input.workspace, env, timeoutMs: remaining, stdin, responsePipe: treatment.harness === 'yylo_pi' });
    const execution: Execution = { status: result.timedOut ? 'timed_out' : result.cancelled || result.overflow ? 'error' : result.code === 0 ? 'completed' : 'failed',
      exit_code: result.code, signal: result.signal, runtime_ms: Date.now() - start,
      stdout: result.stdout, stderr: result.stderr, response: treatment.harness === 'yylo_pi' ? result.response : result.stdout,
      observed_model: null, session_id: null, cost_usd: null, cost_completeness: 'unknown',
      diagnostic: result.cancelled ? 'cancelled' : result.overflow ? 'output exceeded 8 MiB per stream; retained output is incomplete' : null };
    if (treatment.harness === 'yylo_pi') {
      let envelope: Record<string, unknown> = {};
      try { const value: unknown = JSON.parse(result.stdout); if (value && typeof value === 'object' && !Array.isArray(value)) envelope = value as Record<string, unknown>; } catch { /* retain unavailable identity */ }
      if (typeof envelope['model'] === 'string' && typeof envelope['provider'] === 'string') {
        const provider = envelope['provider']; const model = envelope['model']; execution.observed_model = model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
      }
      if (typeof envelope['session_id'] === 'string') execution.session_id = envelope['session_id'];
      const cost = envelope['cost'] as { usd?: unknown } | undefined;
      if (typeof cost?.usd === 'number' && Number.isFinite(cost.usd) && cost.usd >= 0) {
        execution.cost_usd = cost.usd; execution.cost_completeness = result.timedOut ? 'partial' : 'reported';
      }
      if (execution.status === 'completed' && (envelope['status'] !== 'success' || !execution.observed_model || !execution.session_id)) {
        execution.status = 'error'; execution.diagnostic = 'missing or unsuccessful YYLO execution envelope';
      }
      // Selectors can be aliases: retain requested and observed separately rather than guessing resolution.
    }
    if (treatment.harness === 'workflow_runner' && execution.status === 'completed') {
      try {
        const manifest = JSON.parse(await readFile(path.join(input.control, 'workflow-output', 'manifest.json'), 'utf8')) as Record<string, unknown>;
        if (manifest['status'] === 'failed' || manifest['semantic_status'] === 'failed' || Array.isArray(manifest['failed_steps']) && manifest['failed_steps'].length) execution.status = 'failed';
        else if (manifest['status'] !== 'completed' && manifest['semantic_status'] !== 'completed') throw new Error('workflow has no completed terminal');
      } catch (error) { execution.status = 'error'; execution.diagnostic = `workflow terminal unavailable: ${String(error)}`; }
    }
    return execution;
  } catch (error) { return failure(error instanceof Error ? error.message : String(error), Date.now() - start); }
}
