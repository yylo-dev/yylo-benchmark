#!/usr/bin/env node
// Historical filename; verifies the breaking thin v3 package using only local synthetic commands.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const tarball = process.argv[2];
if (!tarball) throw new Error('usage: verify-v2-packed-acceptance.mjs /absolute/package.tgz');
const root = await mkdtemp(path.join(os.tmpdir(), 'yylo-benchmark-thin-packed-'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(GIT_|JUNO_|YYLO_|PI_)/.test(key)) delete env[key];
await writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}\n');
await exec('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.resolve(tarball)], { cwd: root, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
const source = path.join(root, 'source'); await mkdir(source);
const git = (...args) => exec('git', args, { cwd: source, env });
await git('init', '--quiet'); await git('config', 'user.name', 'Packed Acceptance'); await git('config', 'user.email', 'packed@localhost');
await writeFile(path.join(source, 'code.txt'), 'baseline'); await git('add', '.'); await git('commit', '--quiet', '-m', 'base');
const base = (await git('rev-parse', 'HEAD')).stdout.trim();
await writeFile(path.join(source, 'answer.txt'), 'future solution'); await git('add', '.'); await git('commit', '--quiet', '-m', 'reference');
await writeFile(path.join(root, 'prompt.md'), 'Implement a local change.');
const executable = path.join(root, 'node_modules', '.bin', 'yylo-benchmark');
const run = async (args) => (await exec(executable, args, { cwd: root, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
const help = await run(['--help']);
for (const command of ['case', 'run', 'evaluate', 'report', 'disqualify']) assert.match(help, new RegExp(`\\b${command}\\b`));
for (const retired of ['rejudge', 'recover', 'migrate-config']) assert.ok(!help.includes(retired));
await run(['case', 'create', '--source', source, '--base', base, '--prompt', path.join(root, 'prompt.md'), '--output', path.join(root, 'case'), '--reviewed']);
const treatment = { name: 'synthetic', model: 'offline/model', harness: 'command', executable: process.execPath,
  args: ['-e', `const fs=require('fs');if(fs.existsSync('answer.txt'))process.exit(10);fs.writeFileSync('code.txt','candidate');console.log('done');`] };
await writeFile(path.join(root, 'treatment.json'), JSON.stringify(treatment));
await run(['run', '--case', path.join(root, 'case'), '--treatment', path.join(root, 'treatment.json'), '--output', path.join(root, 'experiment')]);
const attempt = path.join(root, 'experiment', '1-1'); const before = await readFile(path.join(attempt, 'result.json'), 'utf8');
for (const verdict of ['pass', 'fail']) {
  await writeFile(path.join(root, `${verdict}.json`), JSON.stringify({ name: verdict, kind: 'judge', judge: { ...treatment, args: ['-e', `console.log('{"verdict":"${verdict}","findings":[]}')`] } }));
  await run(['evaluate', '--attempt', attempt, '--evaluator', path.join(root, `${verdict}.json`)]);
}
assert.equal(await readFile(path.join(attempt, 'result.json'), 'utf8'), before);
const rows = JSON.parse(await run(['report', '--root', path.join(root, 'experiment')]));
assert.equal(rows.length, 2); assert.deepEqual(rows.map((row) => row.verdict).sort(), ['fail', 'pass']);
assert.ok(rows.every((row) => row.execution === 'completed' && row.evaluation_validity === 'valid'));
await run(['disqualify', '--attempt', attempt, '--reason', 'synthetic audit example']);
assert.ok(JSON.parse(await run(['report', '--root', attempt])).every((row) => row.disqualified));
await writeFile(path.join(root, 'slow.json'), JSON.stringify({ ...treatment, name: 'slow', args: ['-e', "require('fs').writeFileSync('ready','yes');setInterval(()=>{},100)"] }));
const cancelledRoot = path.join(root, 'cancelled');
const pending = exec(executable, ['run', '--case', path.join(root, 'case'), '--treatment', path.join(root, 'slow.json'), '--treatment', path.join(root, 'treatment.json'), '--output', cancelledRoot], { cwd: root, env, timeout: 30_000 });
const settled = pending.then(() => null, (error) => error);
const deadline = Date.now() + 15_000;
while (!existsSync(path.join(cancelledRoot, '1-1', 'workspace', 'ready'))) {
  if (Date.now() >= deadline) throw new Error('cancellation fixture did not start');
  await new Promise((resolve) => setTimeout(resolve, 25));
}
pending.child.kill('SIGTERM');
assert.ok(await settled, 'cancelled CLI must exit unsuccessfully');
assert.equal(existsSync(path.join(cancelledRoot, '2-1')), false, 'cancellation must not launch next variant');
assert.equal(JSON.parse(await readFile(path.join(cancelledRoot, '1-1', 'result.json'), 'utf8')).execution.diagnostic, 'cancelled');
console.log(JSON.stringify({ schema: 'yylo_benchmark_packed_acceptance.v3', ok: true, live_model_calls: 0, candidate_dispatch_count: 2, evaluator_dispatch_count: 2, cancellation_verified: true, root }));
