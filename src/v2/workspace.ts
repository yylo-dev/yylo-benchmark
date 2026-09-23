import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../contracts/canonical.js';
import type { CaseRecord, FileEntry } from './contracts.js';

const exec = promisify(execFile);
export const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const objectHash = (value: unknown): string => digest(canonicalJson(value));
export async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, 'utf8')) as T; }
export async function immutable(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${canonicalJson(value)}\n`, { flag: 'wx', mode: 0o600 });
}
export function relative(file: string): string {
  if (!file || file.includes('\\') || file.includes('\0') || file.includes('\n') || path.isAbsolute(file)
      || file.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) throw new Error(`unsafe relative path: ${file}`);
  return file;
}
export function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file); return rel === '' || !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}
export async function freshDirectory(directory: string): Promise<string> {
  await mkdir(path.dirname(path.resolve(directory)), { recursive: true });
  await mkdir(directory, { mode: 0o700 }); // Existing destinations are never overwritten.
  return realpath(directory);
}
export async function git(cwd: string, args: string[]): Promise<Buffer> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const { stdout } = await exec('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 60_000,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return stdout;
}
export async function initializeRepository(directory: string): Promise<string> {
  await git(directory, ['init', '--quiet']);
  await git(directory, ['add', '--all', '--force']);
  await git(directory, ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@localhost', 'commit', '--quiet', '--allow-empty', '-m', 'Benchmark starting input']);
  return (await git(directory, ['rev-parse', 'HEAD'])).toString().trim();
}
export async function manifest(root: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name); const rel = path.relative(root, file).split(path.sep).join('/');
      relative(rel); const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`symlinks are not supported in retained inputs/outputs: ${rel}`);
      if (stat.isDirectory()) await visit(file);
      else if (stat.isFile()) files.push({ path: rel, sha256: digest(await readFile(file)), executable: (stat.mode & 0o111) !== 0 });
      else throw new Error(`non-regular file: ${rel}`);
    }
  }
  await visit(root); return files;
}
export async function verifyFiles(root: string, expected: FileEntry[]): Promise<void> {
  if (objectHash(await manifest(root)) !== objectHash(expected)) throw new Error('retained file manifest mismatch');
}
export async function copyFiles(source: string, destination: string, entries: FileEntry[]): Promise<void> {
  for (const entry of entries) {
    const rel = relative(entry.path); const from = path.join(source, rel);
    const resolved = await realpath(from);
    if (!inside(await realpath(source), resolved) || !(await lstat(from)).isFile()) throw new Error(`unsafe source file: ${rel}`);
    const bytes = await readFile(from);
    if (digest(bytes) !== entry.sha256) throw new Error(`source bytes changed: ${rel}`);
    const to = path.join(destination, rel); await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, bytes, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 });
  }
}
const DEFAULT_EXCLUSIONS = ['.juno_task', '.gitmodules', 'hidden-graders', 'reference-solutions'];
export async function prepareCase(input: {
  source: string; base: string; prompt: string; output: string; reviewed: boolean;
  reference?: string; ledgerTaskId?: string; workflow?: string; exclude?: string[]; include?: string[];
}): Promise<CaseRecord> {
  if (!input.reviewed) throw new Error('case preparation requires explicit review of requirements, base and answer exclusions');
  if (!input.prompt.trim()) throw new Error('case prompt is empty');
  const source = await realpath(input.source);
  if (await realpath((await git(source, ['rev-parse', '--show-toplevel'])).toString().trim()) !== source) throw new Error('source must be the repository root');
  const parent = path.resolve(input.output, '..'); await mkdir(parent, { recursive: true });
  if (inside(source, path.join(await realpath(parent), path.basename(input.output)))) throw new Error('case storage must be outside the source repository');
  const commit = (await git(source, ['rev-parse', '--verify', '--end-of-options', `${input.base}^{commit}`])).toString().trim();
  const reference = input.reference ? (await git(source, ['rev-parse', '--verify', '--end-of-options', `${input.reference}^{commit}`])).toString().trim() : null;
  if (reference) {
    if (reference === commit) throw new Error('reference and pre-solution base must differ');
    await git(source, ['merge-base', '--is-ancestor', commit, reference]);
  }
  const exclusions = [...new Set([...DEFAULT_EXCLUSIONS, ...(input.exclude ?? [])].map(relative))].sort();
  const inclusions = [...new Set((input.include ?? []).map(relative))].sort();
  // Explicit reviewed source subtrees may override defaults, never a caller's explicit exclusion.
  const under = (file: string, parent: string) => file === parent || file.startsWith(`${parent}/`);
  const tree = (await git(source, ['ls-tree', '-rz', commit])).toString().split('\0').filter(Boolean);
  const entries = tree.map((row) => { const [meta, file] = row.split('\t'); return { meta: meta!, file: relative(file!) }; })
    .filter(({ file }) => !(input.exclude ?? []).some((item) => under(file, item))
      && (!exclusions.some((item) => under(file, item)) || inclusions.some((item) => under(file, item))));
  for (const { meta, file } of entries) if (!/^100(?:644|755) blob /.test(meta)) throw new Error(`source symlink/gitlink is unsupported; explicitly exclude or materialize it before review: ${file}`);
  if (!entries.length) throw new Error('case source snapshot is empty');
  const output = await freshDirectory(input.output); const snapshot = path.join(output, 'source'); await mkdir(snapshot);
  // Git creates the archive from the reviewed commit; no refs, objects or worktree links are copied.
  const archive = await git(source, ['archive', '--format=tar', commit, '--', ...entries.map((item) => item.file)]);
  const tar = path.join(output, 'source.tar'); await writeFile(tar, archive, { flag: 'wx', mode: 0o600 });
  await exec('tar', ['-xf', tar, '-C', snapshot], { timeout: 60_000 });
  await unlink(tar); // Disposable transport only; the verified source files are the retained input.
  for (const { meta, file } of entries) {
    const [mode, , oid] = meta.split(' ');
    const bytes = await readFile(path.join(snapshot, file));
    const actual = createHash(oid!.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (actual !== oid || ((await lstat(path.join(snapshot, file))).mode & 0o111 ? '100755' : '100644') !== mode) {
      throw new Error(`archive changed source bytes/mode (check export attributes): ${file}`);
    }
  }
  let workflow: string | null = null;
  if (input.workflow) {
    const name = relative(input.workflow);
    if (!entries.some((entry) => entry.file === name)) throw new Error('workflow must be included in reviewed source');
    workflow = await readFile(path.join(snapshot, name), 'utf8');
  }
  const core = { schema: 'yylo_benchmark_case.v3' as const, source_commit: commit, reference_commit: reference,
    ledger_task_id: input.ledgerTaskId ?? null, reviewed: true as const, prompt: input.prompt, workflow, exclusions, inclusions, files: await manifest(snapshot) };
  const record = { ...core, sha256: objectHash(core) }; await immutable(path.join(output, 'case.json'), record);
  return record;
}
export async function loadCase(directory: string): Promise<CaseRecord> {
  const record = await json<CaseRecord>(path.join(directory, 'case.json')); const { sha256, ...core } = record;
  if (core.schema !== 'yylo_benchmark_case.v3' || core.reviewed !== true || sha256 !== objectHash(core)) throw new Error('invalid case record');
  await verifyFiles(path.join(directory, 'source'), core.files); return record;
}
export async function retainOutput(workspace: string, output: string): Promise<FileEntry[]> {
  await mkdir(output);
  const names = [...new Set((await git(workspace, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).toString().split('\0').filter(Boolean))].sort();
  for (const name of names) {
    const rel = relative(name); const from = path.join(workspace, rel);
    let stat; try { stat = await lstat(from); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || !inside(await realpath(workspace), await realpath(from))) throw new Error(`unsafe output file: ${rel}`);
    const to = path.join(output, rel); await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to); await chmod(to, stat.mode & 0o111 ? 0o755 : 0o644);
  }
  return manifest(output);
}
export function newId(): string { return randomUUID(); }
