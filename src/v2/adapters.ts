import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TreatmentSchema, type AttemptIntent, type AttemptResult, type Treatment } from './contracts.js';
import { copyFiles, digest, freshDirectory, git, immutable, initializeRepository, inside, json, loadCase, newId, objectHash, retainOutput, verifyFiles } from './workspace.js';
import { invoke } from './harness.js';

export async function runAttempt(input: { caseDirectory: string; output: string; treatment: Treatment }): Promise<AttemptResult> {
  const treatment = TreatmentSchema.parse(input.treatment); const caseDirectory = await realpath(input.caseDirectory);
  const caseRecord = await loadCase(caseDirectory);
  await mkdir(path.dirname(path.resolve(input.output)), { recursive: true });
  if (inside(caseDirectory, path.join(await realpath(path.dirname(path.resolve(input.output))), path.basename(input.output)))) throw new Error('attempt output must be outside the case bundle');
  const output = await freshDirectory(input.output); const workspace = path.join(output, 'workspace'); await mkdir(workspace);
  const intent: AttemptIntent = { schema: 'yylo_benchmark_attempt.v3', id: newId(), case_hash: caseRecord.sha256, ledger_task_id: caseRecord.ledger_task_id, source_commit: caseRecord.source_commit, case_prompt: caseRecord.prompt,
    treatment, scope: !treatment.workflow ? 'task' : treatment.workflow.through ? 'workflow_prefix' : 'workflow', started_at: new Date().toISOString() };
  // Intent first: an interrupted producer is visible and is never silently replayed.
  await immutable(path.join(output, 'attempt.json'), intent);
  await copyFiles(path.join(caseDirectory, 'source'), workspace, caseRecord.files);
  const base = await initializeRepository(workspace);
  const execution = await invoke({ treatment, prompt: caseRecord.prompt, workspace, control: path.join(output, 'execution'), workflow: caseRecord.workflow });
  let outputFiles: AttemptResult['output_files'] = []; let outputError: string | null = null; let patch: Buffer = Buffer.from('');
  try {
    outputFiles = await retainOutput(workspace, path.join(output, 'output'));
    await git(workspace, ['add', '--all']);
    patch = await git(workspace, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--cached', base]);
  } catch (error) { outputError = error instanceof Error ? error.message : String(error); }
  await writeFile(path.join(output, 'patch.diff'), patch, { flag: 'wx', mode: 0o600 });
  const core: Omit<AttemptResult, 'sha256'> = { schema: 'yylo_benchmark_result.v3', attempt_id: intent.id, intent_hash: objectHash(intent), execution,
    output_files: outputFiles, output_error: outputError, patch_sha256: digest(patch), ended_at: new Date().toISOString() };
  const result = { ...core, sha256: objectHash(core) };
  await immutable(path.join(output, 'result.json'), result); return result;
}
export async function loadAttempt(directory: string): Promise<{ intent: AttemptIntent; result: AttemptResult }> {
  const intent = await json<AttemptIntent>(path.join(directory, 'attempt.json'));
  const result = await json<AttemptResult>(path.join(directory, 'result.json'));
  const { sha256, ...core } = result;
  if (sha256 !== objectHash(core)) throw new Error('result checksum mismatch');
  if (intent.schema !== 'yylo_benchmark_attempt.v3' || result.schema !== 'yylo_benchmark_result.v3'
      || result.intent_hash !== objectHash(intent) || result.attempt_id !== intent.id) throw new Error('attempt linkage mismatch');
  if (digest(await readFile(path.join(directory, 'patch.diff'))) !== result.patch_sha256) throw new Error('retained patch changed');
  if (!result.output_error) await verifyFiles(path.join(directory, 'output'), result.output_files);
  return { intent, result };
}
