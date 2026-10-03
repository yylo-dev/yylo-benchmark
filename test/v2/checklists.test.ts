import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { freezeChecklist, validateChecklist, assessChecklist, checklistScore, loadChecklist } from '../../src/v2/checklists.js';
import { prepareCase, loadCase, objectHash } from '../../src/v2/workspace.js';
import { runAttempt, loadAttempt } from '../../src/v2/adapters.js';
import { evaluate } from '../../src/v2/evaluators.js';
import { EvaluatorSchema } from '../../src/v2/contracts.js';
import { disqualify, report, table } from '../../src/v2/cli.js';
import { runCli } from '../../src/cli/program.js';
import { fixture, command } from '../snapshot/real-git.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const document = (id = 'C1') => ({ name: 'project standard', version: '1', criteria: [{ id, pass_when: 'Output implements the specified behavior.' }] });
const entry = (id: string, result = 'pass') => ({ id, result, evidence: ['fixture result and source location'] });
const human = EvaluatorSchema.parse({ name: 'operator', kind: 'human' });

async function attempt() {
  const f = await fixture(); roots.push(f.root);
  const old = await loadCase(f.caseDirectory);
  const checklist = freezeChecklist({ project: document(), task: document('C2') });
  const caseDirectory = path.join(f.root, 'checklist-case');
  await prepareCase({ source: f.source, base: old.source_commit, prompt: 'Implement behavior.', output: caseDirectory, reviewed: true, checklist });
  const output = path.join(f.root, 'attempt');
  await runAttempt({ caseDirectory, output, treatment: command('console.log("candidate")') });
  return { ...f, output, caseDirectory, checklist };
}

describe('frozen equal-weight checklists', () => {
  it('combines explicit standards, records assumptions and hashes canonical content', () => {
    const task = { ...document('C2'), assumptions: ['No production execution'] };
    const frozen = freezeChecklist({ project: document(), task });
    expect(validateChecklist(frozen)).toEqual(frozen);
    expect(frozen.sha256).toBe(freezeChecklist({ task, project: document() }).sha256);
    expect(frozen.sha256).not.toBe(freezeChecklist({ task: { ...task, version: '2' }, project: document() }).sha256);
    expect(frozen.task?.assumptions).toEqual(['No production execution']);
    expect(() => freezeChecklist({})).toThrow();
    expect(() => freezeChecklist({ project: document(), task: document() })).toThrow(/duplicate/i);
    for (const bad of [{ ...document(), criteria: [] }, { ...document(), name: ' ' }, { ...document(), version: ' ' },
      { ...document(), criteria: [{ id: 'C1', pass_when: ' ' }] }, { ...document(), weights: [1] },
      { ...document(), criteria: [document().criteria[0], document().criteria[0]] }]) {
      expect(() => freezeChecklist({ task: bad })).toThrow();
    }
    expect(() => validateChecklist({ ...frozen, sha256: 'a'.repeat(64) })).toThrow(/checksum/);
  });

  it('reads bounded YAML/JSON without duplicate YAML keys or aliases', async () => {
    const f = await fixture(); roots.push(f.root);
    const yaml = path.join(f.root, 'criteria.yaml');
    await writeFile(yaml, 'name: standards\nversion: "1"\ncriteria:\n  - id: C1\n    pass_when: Output works.\n');
    const frozen = await loadChecklist({ projectCriteria: yaml });
    expect(frozen?.project?.name).toBe('standards');
    expect(await loadChecklist({})).toBeUndefined();
    await writeFile(yaml, 'name: a\nname: b\n');
    await expect(loadChecklist({ criteria: yaml })).rejects.toThrow();
    await writeFile(yaml, 'name: &n standard\nversion: *n\ncriteria: []\n');
    await expect(loadChecklist({ criteria: yaml })).rejects.toThrow();
    await writeFile(yaml, ' '.repeat(65537));
    await expect(loadChecklist({ criteria: yaml })).rejects.toThrow(/64 KiB/);
  });

  it('computes loss without delegating scores or silently dropping unknowns', () => {
    const checklist = freezeChecklist({ project: document(), task: document('C2') });
    for (const [results, expected] of [[['pass', 'pass'], 0], [['fail', 'pass'], 0.5], [['fail', 'fail'], 1]] as const) {
      const assessment = assessChecklist({ criteria: results.map((r, i) => entry(`C${i + 1}`, r)) }, checklist);
      expect(checklistScore(checklist, assessment).loss).toBe(expected);
    }
    const unknown = assessChecklist({ criteria: [entry('C1', 'unknown'), entry('C2', 'fail')] }, checklist);
    expect(unknown.verdict).toBe('unknown');
    expect(checklistScore(checklist, unknown)).toMatchObject({ loss: null, reason: 'insufficient_evidence', unknown: 1 });
    for (const bad of [{ criteria: [entry('C1')] }, { criteria: [entry('C1'), entry('C1')] },
      { criteria: [entry('C1'), entry('OTHER')] }, { criteria: [entry('C1'), { ...entry('C2'), evidence: [] }] },
      { criteria: [entry('C1'), { ...entry('C2'), evidence: [' '] }] },
      { criteria: [entry('C1'), entry('C2')], loss: 0 }, { criteria: [entry('C1'), entry('C2')], verdict: 'pass' }]) {
      expect(() => assessChecklist(bad, checklist)).toThrow();
    }
  });

  it('delivers public criteria, retains independent judgments and excludes self-assigned scores', async () => {
    const f = await attempt();
    const c = await loadCase(f.caseDirectory);
    expect(c.prompt).toContain('C1: Output implements');
    expect(c.prompt).not.toContain('##');
    const original = await readFile(path.join(f.output, 'result.json'), 'utf8');
    const assessment = { criteria: [entry('C2', 'fail'), entry('C1')] };
    const result = await evaluate({ attemptDirectory: f.output, evaluator: human, assessment });
    expect(result.validity).toBe('valid');
    expect(result.checklist_score?.loss).toBe(0.5);
    expect(result.assessment.verdict).toBe('fail');
    const failed = await evaluate({ attemptDirectory: f.output, evaluator: human, assessment: { ...assessment, loss: 0 } });
    expect(failed.validity).toBe('error');
    expect(failed.checklist_score).toMatchObject({ loss: null, reason: 'evaluation_error' });
    expect(await readFile(path.join(f.output, 'result.json'), 'utf8')).toBe(original);
    const rows = await report(f.output);
    expect(rows.find(r => r.evaluation_id === result.id)).toMatchObject({ loss: 0.5, failed: 1, total: 2, criteria_changed: false });
    expect(table(rows)).toContain('loss');
    await disqualify(f.output, 'known answer exposure');
    expect((await report(f.output)).every(r => r.loss === null && r.score_reason === 'disqualified')).toBe(true);
  });

  it('binds an explicit later revision without overwriting criteria or original evaluations', async () => {
    const f = await attempt();
    const before = await readFile(path.join(f.output, 'attempt.json'), 'utf8');
    const first = await evaluate({ attemptDirectory: f.output, evaluator: human, assessment: { criteria: [entry('C1'), entry('C2')] } });
    const saved = await readFile(path.join(f.output, 'evaluations', first.id, 'result.json'), 'utf8');
    const revised = freezeChecklist({ task: document('NEW') });
    const next = await evaluate({ attemptDirectory: f.output, evaluator: human, checklist: revised, assessment: { criteria: [entry('NEW')] } });
    expect(next.checklist_origin).toBe('evaluation');
    expect(await readFile(path.join(f.output, 'attempt.json'), 'utf8')).toBe(before);
    expect(await readFile(path.join(f.output, 'evaluations', first.id, 'result.json'), 'utf8')).toBe(saved);
    const rows = await report(f.output);
    expect(new Set(rows.map(r => r.comparison_key)).size).toBe(2);
    expect(rows.find(r => r.evaluation_id === next.id)?.criteria_changed).toBe(true);
  });

  it('supplies identical frozen criterion contracts to command checks and synthetic judges', async () => {
    const f = await attempt();
    for (const kind of ['check', 'judge'] as const) {
      const script = `const fs=require('fs');const input=fs.readFileSync(0,'utf8');if(!input.includes('checklist')||!input.includes('C2'))process.exit(2);console.log(JSON.stringify(${JSON.stringify({ criteria: [entry('C1'), entry('C2', 'unknown')] })}));`;
      const evaluator = EvaluatorSchema.parse(kind === 'check'
        ? { name: 'checks', kind, command: { executable: process.execPath, args: ['-e', script] } }
        : { name: 'judge', kind, judge: command(script) });
      const result = await evaluate({ attemptDirectory: f.output, evaluator });
      expect(result.validity).toBe('valid');
      expect(result.checklist_score?.loss).toBeNull();
      const prompt = await readFile(path.join(f.output, 'evaluations', result.id, 'execution', 'prompt.txt'), 'utf8');
      expect(prompt).not.toContain('requested_model');
      if (kind === 'judge') {
        expect(prompt).toContain('only the frozen criterion IDs');
        expect(prompt.startsWith(result.checklist_judge_instruction!)).toBe(true);
      }
      expect((await report(f.output)).find(r => r.evaluation_id === result.id)?.evaluator_hash).toBe(objectHash({
        evaluator: result.evaluator, checklist_judge_instruction: result.checklist_judge_instruction,
      }));
    }
  });

  it('detects rewritten derived scores even if the result checksum is recomputed', async () => {
    const f = await attempt();
    const evaluation = await evaluate({ attemptDirectory: f.output, evaluator: human, assessment: { criteria: [entry('C1'), entry('C2', 'fail')] } });
    const file = path.join(f.output, 'evaluations', evaluation.id, 'result.json');
    const { sha256: _ignored, ...core } = evaluation;
    core.checklist_score!.loss = 0;
    await writeFile(file, JSON.stringify({ ...core, sha256: objectHash(core) }));
    expect((await report(f.output)).some(r => String(r.integrity_error).includes('score'))).toBe(true);
  });

  it('detects nested contract drift in both case and attempt even with repaired outer digests', async () => {
    const f = await attempt();
    const caseFile = path.join(f.caseDirectory, 'case.json');
    const { sha256: _caseHash, ...caseCore } = JSON.parse(await readFile(caseFile, 'utf8'));
    caseCore.checklist.task.criteria[0].pass_when = 'changed after freeze';
    await writeFile(caseFile, JSON.stringify({ ...caseCore, sha256: objectHash(caseCore) }));
    await expect(loadCase(f.caseDirectory)).rejects.toThrow('checklist checksum');
    const intentFile = path.join(f.output, 'attempt.json');
    const intent = JSON.parse(await readFile(intentFile, 'utf8'));
    intent.checklist.project.version = '2';
    await writeFile(intentFile, JSON.stringify(intent));
    const resultFile = path.join(f.output, 'result.json');
    const { sha256: _resultHash, ...core } = JSON.parse(await readFile(resultFile, 'utf8'));
    core.intent_hash = objectHash(intent);
    await writeFile(resultFile, JSON.stringify({ ...core, sha256: objectHash(core) }));
    await expect(loadAttempt(f.output)).rejects.toThrow('checklist checksum');
  });

  it('groups model/name changes but separates evaluator and declared harness-setting changes', async () => {
    const f = await attempt();
    const assessment = { criteria: [entry('C1'), entry('C2')] };
    await evaluate({ attemptDirectory: f.output, evaluator: human, assessment });
    const key = (await report(f.output))[0]!.comparison_key;
    for (const [index, treatment] of [
      { ...command('console.log("candidate")'), name: 'other', model: 'other/model' },
      { ...command('console.log("candidate")'), timeout_ms: 9000 },
    ].entries()) {
      const output = path.join(f.root, `comparison-${index}`);
      await runAttempt({ caseDirectory: f.caseDirectory, output, treatment });
      await evaluate({ attemptDirectory: output, evaluator: human, assessment });
      expect((await report(output))[0]!.comparison_key === key).toBe(index === 0);
    }
    const second = await evaluate({ attemptDirectory: f.output, evaluator: { ...human, rubric: 'new evaluation policy' }, assessment });
    expect((await report(f.output)).find(r => r.evaluation_id === second.id)?.comparison_key).not.toBe(key);
  });

  it('keeps checklist evaluator execution failures unscored without trusting stdout', async () => {
    const f = await attempt();
    const result = await evaluate({ attemptDirectory: f.output, evaluator: EvaluatorSchema.parse({ name: 'broken', kind: 'check', command: {
      executable: process.execPath, args: ['-e', `console.log(JSON.stringify(${JSON.stringify({ criteria: [entry('C1'), entry('C2')] })}));process.exit(2)`],
    } }) });
    expect(result).toMatchObject({ validity: 'error', assessment: { verdict: 'unknown' }, checklist_score: { loss: null, reason: 'evaluation_error' } });
    const before = await readFile(path.join(f.output, 'result.json'), 'utf8');
    expect((await report(f.output))[0]).toMatchObject({ loss: null, evaluation_validity: 'error', candidate_cost_usd: null });
    expect(await readFile(path.join(f.output, 'result.json'), 'utf8')).toBe(before);
  });

  it('freezes CLI file inputs, appends revisions, and leaves legacy cases unscored', async () => {
    const f = await fixture(); roots.push(f.root);
    const old = await loadCase(f.caseDirectory);
    await writeFile(path.join(f.root, 'task.yaml'), 'name: task\nversion: "1"\ncriteria:\n  - id: C2\n    pass_when: It works.\n');
    await writeFile(path.join(f.root, 'project.json'), JSON.stringify(document()));
    await writeFile(path.join(f.root, 'prompt.txt'), 'Do the task.');
    const output: string[] = []; const opts = { cwd: f.root, stdout: (s: string) => output.push(s) };
    await runCli(['case', 'create', '--source', f.source, '--base', old.source_commit, '--prompt', 'prompt.txt', '--output', 'case-cli', '--reviewed', '--criteria', 'task.yaml', '--project-criteria', 'project.json'], opts);
    const caseBefore = await loadCase(path.join(f.root, 'case-cli'));
    await writeFile(path.join(f.root, 'project.json'), JSON.stringify(document('REVISED')));
    expect((await loadCase(path.join(f.root, 'case-cli'))).sha256).toBe(caseBefore.sha256);
    await writeFile(path.join(f.root, 'treatment.json'), JSON.stringify(command('')));
    await runCli(['run', '--case', 'case-cli', '--treatment', 'treatment.json', '--output', 'runs'], opts);
    await writeFile(path.join(f.root, 'human.json'), JSON.stringify(human));
    await writeFile(path.join(f.root, 'assessment.json'), JSON.stringify({ criteria: [entry('C1'), entry('C2')] }));
    await runCli(['evaluate', '--attempt', 'runs/1-1', '--evaluator', 'human.json', '--assessment', 'assessment.json'], opts);
    expect(JSON.parse(output.at(-1)!).checklist_score.loss).toBe(0);
    await writeFile(path.join(f.root, 'assessment.json'), JSON.stringify({ criteria: [entry('REVISED')] }));
    await runCli(['evaluate', '--attempt', 'runs/1-1', '--evaluator', 'human.json', '--assessment', 'assessment.json', '--project-criteria', 'project.json'], opts);
    expect(JSON.parse(output.at(-1)!).checklist_origin).toBe('evaluation');
    const legacy = path.join(f.root, 'legacy');
    await runAttempt({ caseDirectory: f.caseDirectory, output: legacy, treatment: command('') });
    await evaluate({ attemptDirectory: legacy, evaluator: human, assessment: { verdict: 'pass', findings: [] } });
    expect((await report(legacy))[0]).toMatchObject({ verdict: 'pass', loss: null, score_reason: 'no_checklist' });
  });
});
