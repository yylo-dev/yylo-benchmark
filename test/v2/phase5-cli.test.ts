import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, command } from '../snapshot/real-git.js';
import { runCli } from '../../src/cli/program.js';
import { draftLedgerCase, report } from '../../src/v2/cli.js';
const roots: string[] = []; afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('public thin experiment CLI', () => {
  it('runs a treatment matrix, later evaluation and readable separate-results report', async () => {
    const f = await fixture(); roots.push(f.root);
    await writeFile(path.join(f.root, 'a.json'), JSON.stringify(command('console.log("a")', 'a')));
    await writeFile(path.join(f.root, 'b.json'), JSON.stringify(command('console.log("b")', 'b')));
    const output: string[] = []; const options = { cwd: f.root, stdout: (text: string) => output.push(text) };
    await runCli(['run', '--case', f.caseDirectory, '--treatment', 'a.json', '--treatment', 'b.json', '--attempts', '2', '--output', 'experiment'], options);
    expect(output).toHaveLength(4);
    await writeFile(path.join(f.root, 'human.json'), JSON.stringify({ name: 'human', kind: 'human' }));
    await writeFile(path.join(f.root, 'assessment.json'), JSON.stringify({ verdict: 'pass', findings: ['reviewed'] }));
    await runCli(['evaluate', '--attempt', 'experiment/1-1', '--evaluator', 'human.json', '--assessment', 'assessment.json'], options);
    await runCli(['report', '--root', 'experiment', '--table'], options);
    expect(output.at(-1)).toContain('human'); expect(output.at(-1)).toContain('pass');
    expect((await report(path.join(f.root, 'experiment')))).toHaveLength(4);
    await expect(runCli(['run', '--case', f.caseDirectory, '--treatment', 'a.json', '--output', 'experiment'], options)).rejects.toThrow();
  });
  it('keeps completion answers out of the Ledger draft and never guesses a historical base', async () => {
    const f = await fixture(); roots.push(f.root); const fake = path.join(f.root, 'ledger');
    await writeFile(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify([{id:'task_abc',status:'done',body:'original requirements',commit_hash:'abc123',agent_response:'ANSWER NEVER COPY'}]));\n`, { mode: 0o755 });
    const draft = await draftLedgerCase('task_abc', f.root, fake);
    expect(draft.prompt_draft).toBe('original requirements'); expect(draft.base).toBeNull(); expect(JSON.stringify(draft)).not.toContain('ANSWER');
    await expect(draftLedgerCase('--help', f.root, fake)).rejects.toThrow('invalid');
  });
  it('reports interrupted attempts rather than silently replaying them', async () => {
    const f = await fixture(); roots.push(f.root); const directory = path.join(f.root, 'unfinished'); await mkdir(directory);
    await writeFile(path.join(directory, 'attempt.json'), JSON.stringify({ schema: 'yylo_benchmark_attempt.v3', id: 'interrupted', case_hash: 'hash', treatment: command(''), scope: 'task' }));
    expect((await report(directory))[0]!.execution).toBe('interrupted_or_running');
  });
});
