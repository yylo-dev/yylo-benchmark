import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, command } from '../snapshot/real-git.js';
import { runAttempt } from '../../src/v2/adapters.js';
import { evaluate } from '../../src/v2/evaluators.js';
import { EvaluatorSchema } from '../../src/v2/contracts.js';
import { disqualify, report } from '../../src/v2/cli.js';
const roots: string[] = []; afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('independent assessment', () => {
  it('adds new disagreeing judges without candidate replay or rewriting original outputs/results', async () => {
    const f = await fixture(); roots.push(f.root); const directory = path.join(f.root, 'attempt');
    await runAttempt({ caseDirectory: f.caseDirectory, output: directory, treatment: command(`require('fs').writeFileSync('code.txt','candidate');console.log('response')`) });
    const original = await readFile(path.join(directory, 'result.json'), 'utf8');
    for (const verdict of ['pass', 'fail']) {
      const judge = command(`require('fs').writeFileSync('code.txt','judge edit');console.log(JSON.stringify({verdict:'${verdict}',findings:['different opinion']}))`, `judge-${verdict}`);
      const evaluation = await evaluate({ attemptDirectory: directory, evaluator: EvaluatorSchema.parse({ name: judge.name, kind: 'judge', judge, rubric: `new rubric ${verdict}` }) });
      expect(evaluation.validity).toBe('valid'); expect(evaluation.assessment.verdict).toBe(verdict);
    }
    expect(await readFile(path.join(directory, 'result.json'), 'utf8')).toBe(original);
    expect(await readFile(path.join(directory, 'output', 'code.txt'), 'utf8')).toBe('candidate');
    const rows = await report(directory); expect(rows.map((row) => row.verdict).sort()).toEqual(['fail', 'pass']);
    expect(rows.every((row) => !('overall_verdict' in row))).toBe(true);
  });
  it('separates deterministic failure, malformed output, unavailable packet and human review', async () => {
    const f = await fixture(); roots.push(f.root); const directory = path.join(f.root, 'attempt');
    await runAttempt({ caseDirectory: f.caseDirectory, output: directory, treatment: command('process.exit(2)') });
    const check = (script: string) => EvaluatorSchema.parse({ name: 'checks', kind: 'check', command: { executable: process.execPath, args: ['-e', script] } });
    const failed = await evaluate({ attemptDirectory: directory, evaluator: check(`console.log('{"verdict":"fail","findings":["wrong behavior"]}')`) });
    expect(failed.validity).toBe('valid'); expect(failed.assessment.verdict).toBe('fail');
    const malformed = await evaluate({ attemptDirectory: directory, evaluator: check(`console.log('not JSON')`) });
    expect(malformed.validity).toBe('error'); expect(malformed.assessment.verdict).toBe('unknown');
    const oversize = await evaluate({ attemptDirectory: directory, evaluator: EvaluatorSchema.parse({ name: 'judge', kind: 'judge', max_packet_bytes: 1, judge: command('process.exit(99)') }) });
    expect(oversize.error).toContain('no truncated evidence'); expect(oversize.execution).toBeNull();
    const human = await evaluate({ attemptDirectory: directory, evaluator: EvaluatorSchema.parse({ name: 'reviewer', kind: 'human' }), assessment: { verdict: 'pass', findings: ['patch works but execution failed'] } });
    expect(human.validity).toBe('valid');
    const rows = await report(directory); expect(rows.every((row) => row.execution === 'failed')).toBe(true);
  });
  it('uses explicit evaluator timeout and retains unavailable quality', async () => {
    const f = await fixture(); roots.push(f.root); const directory = path.join(f.root, 'a');
    await runAttempt({ caseDirectory: f.caseDirectory, output: directory, treatment: command('') });
    const result = await evaluate({ attemptDirectory: directory, evaluator: EvaluatorSchema.parse({ name: 'slow-check', kind: 'check', timeout_ms: 100, command: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},100)'] } }) });
    expect(result.validity).toBe('error'); expect(result.assessment.verdict).toBe('unknown'); expect(result.execution!.status).toBe('timed_out');
  });
  it('records known answer leakage as disqualification without erasing results', async () => {
    const f = await fixture(); roots.push(f.root); const directory = path.join(f.root, 'a');
    await runAttempt({ caseDirectory: f.caseDirectory, output: directory, treatment: command('') });
    await disqualify(directory, 'Operator confirmed reference answer was supplied');
    const rows = await report(directory); expect(rows[0]!.disqualified).toBe(true); expect(rows[0]!.execution).toBe('completed');
  });
  it('reports retained corruption visibly and refuses to evaluate it', async () => {
    const f = await fixture(); roots.push(f.root); const directory = path.join(f.root, 'a');
    await runAttempt({ caseDirectory: f.caseDirectory, output: directory, treatment: command('') });
    await writeFile(path.join(directory, 'output', 'code.txt'), 'tampered');
    await expect(evaluate({ attemptDirectory: directory, evaluator: EvaluatorSchema.parse({ name: 'human', kind: 'human' }), assessment: { verdict: 'pass', findings: [] } })).rejects.toThrow('manifest');
    expect((await report(directory))[0]!.integrity_error).toContain('manifest');
  });
});
