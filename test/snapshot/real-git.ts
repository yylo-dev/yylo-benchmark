import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, prepareCase } from '../../src/v2/workspace.js';
import { TreatmentSchema } from '../../src/v2/contracts.js';
export async function fixture(workflow?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-test-')); const source = path.join(root, 'source'); await mkdir(source);
  await git(source, ['init', '--quiet']); await git(source, ['config', 'user.name', 'Test']); await git(source, ['config', 'user.email', 'test@localhost']);
  await writeFile(path.join(source, 'code.txt'), 'baseline\n'); await writeFile(path.join(source, '.gitignore'), 'node_modules/\n');
  await mkdir(path.join(source, '.juno_task', 'scripts'), { recursive: true }); await writeFile(path.join(source, '.juno_task', 'answer.txt'), 'hidden answer');
  await writeFile(path.join(source, '.juno_task', 'scripts', 'source.py'), 'print("source")');
  if (workflow) await writeFile(path.join(source, 'workflow.yaml'), workflow);
  await git(source, ['add', '.']); await git(source, ['commit', '--quiet', '-m', 'base']); const base = (await git(source, ['rev-parse', 'HEAD'])).toString().trim();
  await writeFile(path.join(source, 'solution.txt'), 'future answer'); await git(source, ['add', '.']); await git(source, ['commit', '--quiet', '-m', 'solution']);
  const reference = (await git(source, ['rev-parse', 'HEAD'])).toString().trim(); const caseDirectory = path.join(root, 'case');
  await prepareCase({ source, base, reference, prompt: 'Implement behavior without looking at the answer.', output: caseDirectory, reviewed: true, ...(workflow ? { workflow: 'workflow.yaml' } : {}) });
  return { root, source, base, reference, caseDirectory };
}
export function command(script: string, name = 'candidate') {
  return TreatmentSchema.parse({ name, model: 'test/model', harness: 'command', executable: process.execPath, args: ['-e', script], timeout_ms: 5000 });
}
