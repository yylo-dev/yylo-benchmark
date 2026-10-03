import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadAttempt } from './adapters.js';
import { immutable, json, newId, objectHash } from './workspace.js';
import type { AttemptIntent, EvaluationRecord } from './contracts.js';
import { assessChecklist, checklistScore, validateChecklist } from './checklists.js';

/** Read-only assisted proposal. The completion response never becomes candidate input. */
export async function draftLedgerCase(id: string, cwd: string, executable = 'yy'): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('invalid Ledger task id');
  const { stdout } = await promisify(execFile)(executable, ['ledger', 'get', id, '-f', 'json'], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const parsed: unknown = JSON.parse(stdout); const task = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
  if (!task || task['id'] !== id || task['status'] !== 'done' || typeof task['body'] !== 'string') throw new Error('Ledger case draft requires a completed task with original requirements');
  return { ledger_task_id: id, prompt_draft: task['body'], reference_candidate: task['commit_hash'] ?? null,
    base: null, reviewed: false,
    review_required: 'Recover original requirements and full pre-solution range. Do not use the completion response or assume the integrated commit parent is the base. Supply reviewed prompt, explicit base and exclusions to case create.' };
}
export async function disqualify(directory: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error('disqualification reason is required');
  const { intent, result } = await loadAttempt(directory); const target = path.join(directory, 'disqualifications'); await mkdir(target, { recursive: true });
  await immutable(path.join(target, `${newId()}.json`), { attempt_id: intent.id, result_hash: objectHash(result), reason, created_at: new Date().toISOString() });
}
async function present(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function entries(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export async function report(root: string): Promise<Record<string, unknown>[]> {
  const directories = await present(path.join(root, 'attempt.json')) ? [root]
    : (await entries(root)).map((name) => path.join(root, name));
  const rows: Record<string, unknown>[] = [];
  for (const directory of directories) {
    if (!await present(path.join(directory, 'attempt.json'))) continue;
    let intent: AttemptIntent;
    try {
      intent = await json<AttemptIntent>(path.join(directory, 'attempt.json'));
      if (intent.schema !== 'yylo_benchmark_attempt.v3' || !intent.treatment) throw new Error('unsupported or malformed attempt; historical evidence must not be reinterpreted');
    } catch (error) {
      rows.push({ directory, integrity_error: error instanceof Error ? error.message : String(error) }); continue;
    }
    const common = { attempt_id: intent.id, case_hash: intent.case_hash, case: intent.ledger_task_id ?? intent.case_hash, source_commit: intent.source_commit, treatment: intent.treatment.name,
      checklist_hash: intent.checklist?.sha256 ?? null, loss: null, score_status: 'unscored', score_reason: 'not_evaluated',
      requested_model: intent.treatment.model, harness: intent.treatment.harness, configuration: intent.treatment.configuration,
      scope: intent.scope, through: intent.treatment.workflow?.through ?? null };
    if (!await present(path.join(directory, 'result.json'))) { rows.push({ ...common, execution: 'interrupted_or_running', evaluator: null }); continue; }
    try {
      const { result } = await loadAttempt(directory); const reasons: string[] = [];
      for (const file of await entries(path.join(directory, 'disqualifications'))) {
        const note = await json<{ attempt_id: string; result_hash: string; reason: string }>(path.join(directory, 'disqualifications', file));
        if (note.attempt_id !== intent.id || note.result_hash !== objectHash(result)) throw new Error('disqualification linkage mismatch');
        reasons.push(note.reason);
      }
      const base = { ...common, execution: result.execution.status, observed_model: result.execution.observed_model,
        runtime_ms: result.execution.runtime_ms, execution_diagnostic: result.execution.diagnostic, candidate_cost_usd: result.execution.cost_usd, candidate_cost_completeness: result.execution.cost_completeness,
        output_error: result.output_error, disqualified: reasons.length > 0, disqualification_reasons: reasons };
      const evaluations = await entries(path.join(directory, 'evaluations'));
      if (!evaluations.length) rows.push({ ...base, evaluator: null });
      for (const id of evaluations) {
        const folder = path.join(directory, 'evaluations', id);
        if (!await present(path.join(folder, 'result.json'))) { rows.push({ ...base, evaluation_id: id, evaluation_validity: 'interrupted_or_running' }); continue; }
        const evaluation = await json<EvaluationRecord>(path.join(folder, 'result.json'));
        const binding = await json<Record<string, unknown>>(path.join(folder, 'intent.json'));
        const { sha256, ...evaluationCore } = evaluation;
        if (sha256 !== objectHash(evaluationCore)) throw new Error('evaluation checksum mismatch');
        const checklist = evaluation.checklist === undefined ? undefined : validateChecklist(evaluation.checklist);
        if (checklist ? !['case', 'evaluation'].includes(evaluation.checklist_origin ?? '')
          : evaluation.checklist_origin !== undefined || evaluation.checklist_judge_instruction !== undefined || evaluation.checklist_score !== undefined || intent.checklist !== undefined) {
          throw new Error('evaluation checklist binding missing or malformed');
        }
        if (evaluation.checklist_origin === 'case' && checklist?.sha256 !== intent.checklist?.sha256) throw new Error('evaluation case checklist mismatch');
        if (checklist && (evaluation.evaluator.kind === 'judge'
          ? typeof evaluation.checklist_judge_instruction !== 'string' || !evaluation.checklist_judge_instruction.trim()
          : evaluation.checklist_judge_instruction !== null)) throw new Error('missing or invalid frozen checklist judge instruction');
        const contract = checklist ? { checklist, checklist_origin: evaluation.checklist_origin,
          checklist_judge_instruction: evaluation.checklist_judge_instruction } : {};
        if (evaluation.schema !== 'yylo_benchmark_evaluation.v3' || evaluation.attempt_id !== intent.id || evaluation.id !== id
            || evaluation.result_hash !== objectHash(result) || objectHash(binding) !== objectHash({ id, attempt_id: intent.id, result_hash: evaluation.result_hash, evaluator: evaluation.evaluator, ...contract })) throw new Error('evaluation linkage mismatch');
        if (checklist && (evaluation.checklist_score === undefined || !['valid', 'error'].includes(evaluation.validity))) throw new Error('missing checklist score or invalid evaluation validity');
        const score = checklist ? checklistScore(checklist, evaluation.assessment, evaluation.validity === 'error') : undefined;
        if (score && (objectHash(score) !== objectHash(evaluation.checklist_score)
            || evaluation.validity === 'valid' && objectHash(assessChecklist({ criteria: evaluation.assessment.criteria }, checklist!)) !== objectHash(evaluation.assessment))) throw new Error('derived checklist score or assessment mismatch');
        // Freeze the built-in judge wrapper too: future wording changes must not silently share an identity.
        const evaluatorHash = objectHash(checklist ? { evaluator: evaluation.evaluator, checklist_judge_instruction: evaluation.checklist_judge_instruction } : evaluation.evaluator);
        const { name: _name, model: _model, ...settings } = intent.treatment;
        const comparisonKey = checklist ? objectHash({ case_hash: intent.case_hash, checklist_hash: checklist.sha256, evaluator_hash: evaluatorHash, settings }) : null;
        rows.push({ ...base, evaluation_id: id, evaluator: evaluation.evaluator.name, evaluator_kind: evaluation.evaluator.kind,
          evaluator_hash: evaluatorHash, comparison_key: comparisonKey, checklist_hash: checklist?.sha256 ?? null,
          checklist_origin: evaluation.checklist_origin ?? null, criteria_changed: checklist ? checklist.sha256 !== intent.checklist?.sha256 : null,
          criteria_results: evaluation.assessment.criteria ?? null,
          total: score?.total ?? null, passed: score?.passed ?? null, failed: score?.failed ?? null, unknown: score?.unknown ?? null,
          loss: reasons.length ? null : score?.loss ?? null,
          score_status: reasons.length ? 'unscored' : score?.status ?? 'unscored',
          score_reason: reasons.length ? 'disqualified' : score?.reason ?? (score ? null : 'no_checklist'),
          evaluation_validity: evaluation.validity, verdict: evaluation.assessment.verdict, findings: evaluation.assessment.findings,
          evaluation_error: evaluation.error, evaluator_runtime_ms: evaluation.execution?.runtime_ms ?? null,
          evaluator_cost_usd: evaluation.execution?.cost_usd ?? null });
      }
    } catch (error) { rows.push({ ...common, integrity_error: error instanceof Error ? error.message : String(error) }); }
  }
  return rows;
}
export function table(rows: Record<string, unknown>[]): string {
  const columns = ['case', 'treatment', 'requested_model', 'harness', 'scope', 'execution', 'disqualified', 'evaluator', 'evaluation_validity', 'verdict', 'loss', 'score_reason', 'candidate_cost_usd', 'evaluator_cost_usd', 'runtime_ms', 'evaluator_runtime_ms', 'integrity_error'];
  const cell = (value: unknown) => String(value ?? '-').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
  return [columns.join(' | '), columns.map(() => '---').join(' | '), ...rows.map((row) => columns.map((key) => cell(row[key])).join(' | '))].join('\n');
}
