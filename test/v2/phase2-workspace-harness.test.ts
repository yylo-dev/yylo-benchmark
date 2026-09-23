import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, command } from '../snapshot/real-git.js';
import { prepareCase, loadCase, git } from '../../src/v2/workspace.js';
import { runAttempt, loadAttempt } from '../../src/v2/adapters.js';
import { capture } from '../../src/v2/process.js';
import { environment } from '../../src/v2/harness.js';

const roots: string[] = []; afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('reviewed cases and independent attempts', () => {
  it('copies only the historical source, with fresh Git and no future answer/controller context', async () => {
    const f = await fixture(); roots.push(f.root); const attempt = path.join(f.root, 'attempt');
    const result = await runAttempt({ caseDirectory: f.caseDirectory, output: attempt, treatment: command(`
      const fs=require('fs'); const cp=require('child_process');
      if(fs.existsSync('solution.txt')||fs.existsSync('.juno_task/answer.txt'))process.exit(4);
      const count=cp.execFileSync('git',['rev-list','--all','--count']).toString().trim(); if(count!=='1')process.exit(5);
      fs.writeFileSync('code.txt','candidate'); fs.writeFileSync('added.txt','new'); console.log('done');`) });
    expect(result.execution.status).toBe('completed');
    expect(await readFile(path.join(attempt, 'patch.diff'), 'utf8')).toContain('+candidate');
    expect(await readFile(path.join(attempt, 'output', 'added.txt'), 'utf8')).toBe('new');
    await expect(git(path.join(attempt, 'workspace'), ['cat-file', '-e', f.reference])).rejects.toThrow();
    const second = await runAttempt({ caseDirectory: f.caseDirectory, output: path.join(f.root, 'other'), treatment: command(`const fs=require('fs');if(fs.readFileSync('code.txt','utf8')!=='baseline\\n'||fs.existsSync('added.txt'))process.exit(6);`) });
    expect(second.execution.status).toBe('completed');
    await expect(runAttempt({ caseDirectory: f.caseDirectory, output: attempt, treatment: command('') })).rejects.toThrow();
  });
  it('admits explicitly reviewed controller source without copying sibling metadata', async () => {
    const f = await fixture(); roots.push(f.root);
    const record = await prepareCase({ source: f.source, base: f.base, prompt: 'edit script', output: path.join(f.root, 'included'), reviewed: true, include: ['.juno_task/scripts'] });
    expect(record.files.some((file) => file.path === '.juno_task/scripts/source.py')).toBe(true);
    expect(record.files.some((file) => file.path === '.juno_task/answer.txt')).toBe(false);
    const excluded = await prepareCase({ source: f.source, base: f.base, prompt: 'edit code', output: path.join(f.root, 'excluded'), reviewed: true, include: ['.juno_task/scripts'], exclude: ['.juno_task/scripts/source.py'] });
    expect(excluded.files.some((file) => file.path.includes('source.py'))).toBe(false);
  });
  it('requires review, external storage and a different reference', async () => {
    const f = await fixture(); roots.push(f.root);
    const input = { source: f.source, base: f.base, prompt: 'task', output: path.join(f.root, 'new'), reviewed: false };
    await expect(prepareCase(input)).rejects.toThrow('review');
    await expect(prepareCase({ ...input, reviewed: true, output: path.join(f.source, 'case') })).rejects.toThrow('outside');
    await expect(prepareCase({ ...input, reviewed: true, reference: f.base })).rejects.toThrow('differ');
  });
  it('rejects symlink source and output leakage and detects retained drift', async () => {
    const f = await fixture(); roots.push(f.root);
    await symlink('/tmp', path.join(f.source, 'escape')); await git(f.source, ['add', '.']); await git(f.source, ['commit', '--quiet', '-m', 'link']);
    await expect(prepareCase({ source: f.source, base: 'HEAD', prompt: 'task', output: path.join(f.root, 'bad'), reviewed: true })).rejects.toThrow('symlink/gitlink');
    const attempt = path.join(f.root, 'attempt'); const result = await runAttempt({ caseDirectory: f.caseDirectory, output: attempt,
      treatment: command(`require('fs').symlinkSync('/tmp','escape')`) });
    expect(result.output_error).toContain('unsafe output');
    await writeFile(path.join(f.caseDirectory, 'source', 'code.txt'), 'changed'); await expect(loadCase(f.caseDirectory)).rejects.toThrow('manifest');
  });
  it('detects patch drift without confusing it with a model failure', async () => {
    const f = await fixture(); roots.push(f.root); const attempt = path.join(f.root, 'a');
    await runAttempt({ caseDirectory: f.caseDirectory, output: attempt, treatment: command('console.log("ok")') });
    await writeFile(path.join(attempt, 'patch.diff'), 'tampered'); await expect(loadAttempt(attempt)).rejects.toThrow('patch changed');
  });
  it('retains setup and executable failures separately from successful execution', async () => {
    const f = await fixture(); roots.push(f.root);
    const invalid = await runAttempt({ caseDirectory: f.caseDirectory, output: path.join(f.root, 'a'), treatment: { ...command(''), executable: '/missing/benchmark-executable' } });
    expect(invalid.execution.status).toBe('error');
    const setup = await runAttempt({ caseDirectory: f.caseDirectory, output: path.join(f.root, 'b'), treatment: { ...command(''), setup: { executable: process.execPath, args: ['-e', 'process.exit(3)'] } } });
    expect(setup.execution.diagnostic).toContain('setup failed');
  });
});
describe('bounded process handling', () => {
  it('records timeout only after TERM-resistant child settlement', async () => {
    const result = await capture(process.execPath, ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},100)`], { cwd: process.cwd(), env: environment(), timeoutMs: 150 });
    expect(result.timedOut).toBe(true); expect(result.runtimeMs).toBeGreaterThanOrEqual(150);
  });
  it('handles EPIPE when a process ignores a large stdin', async () => {
    const result = await capture(process.execPath, ['-e', 'process.exit(0)'], { cwd: process.cwd(), env: environment(), timeoutMs: 5000, stdin: 'x'.repeat(2_000_000) });
    expect(result.code).toBe(0);
  });
  it('bounds excessive captured output and records incompleteness', async () => {
    const result = await capture(process.execPath, ['-e', `process.stdout.write('x'.repeat(10_000_000));setInterval(()=>{},100)`], { cwd: process.cwd(), env: environment(), timeoutMs: 5000 });
    expect(result.overflow).toBe(true); expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
