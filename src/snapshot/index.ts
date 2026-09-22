import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { canonicalHash, sha256Hex } from '../contracts/canonical.js';

export const SNAPSHOT_SCHEMA_VERSION = 'juno_benchmark_snapshot.v1' as const;
export const SNAPSHOT_BRANCH = 'benchmark-baseline' as const;

export interface SnapshotEntry {
  readonly path: string;
  readonly mode: '100644' | '100755' | '120000';
  readonly type: 'file' | 'symlink';
  readonly size: number;
  readonly sha256: `sha256:${string}`;
}

export interface SnapshotManifest {
  readonly schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly source_commit: string;
  readonly source_tree: string;
  readonly excluded_paths: readonly string[];
  readonly entries: readonly SnapshotEntry[];
  readonly content_identity: `sha256:${string}`;
  readonly synthetic_commit: string;
  readonly synthetic_tree: string;
  readonly isolation: {
    readonly git_objects: 'isolated';
    readonly host_filesystem: 'trusted';
    readonly container: 'none';
  };
}

export interface BuildSnapshotOptions {
  readonly sourceRepository: string;
  readonly baseCommit: string;
  readonly destination: string;
  /** Exact paths or directory prefixes removed from the candidate-visible tree. */
  readonly excludedPaths?: readonly string[];
}

export interface RepositoryResultManifest {
  readonly schema_version: 'yylo_benchmark_repository_result.v2';
  readonly head: string;
  readonly head_identity: { readonly kind: 'symbolic'; readonly ref: string } | { readonly kind: 'detached' };
  readonly tree: string;
  readonly refs: readonly string[];
  readonly index: readonly string[];
  readonly status: readonly string[];
  readonly entries: readonly SnapshotEntry[];
  readonly manifest_hash: `sha256:${string}`;
}

export interface SnapshotDoctorOptions {
  readonly repository: string;
  readonly manifest: SnapshotManifest;
  readonly resultManifest?: RepositoryResultManifest;
  readonly sourceRepository?: string;
  readonly prohibitedByteSequences?: readonly (string | Uint8Array)[];
  readonly canonicalControllerPaths?: readonly string[];
  readonly candidateEnvironment?: NodeJS.ProcessEnv;
}

export interface SnapshotDoctorResult {
  readonly ok: true;
  readonly content_identity: `sha256:${string}`;
  readonly synthetic_commit: string;
  readonly isolation: SnapshotManifest['isolation'];
}

const FIXED_GIT_ENV = Object.freeze({
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  LC_ALL: 'C',
  LANG: 'C',
});

function canonicalFilesystemPath(value: string): string {
  const absolute = path.isAbsolute(value) ? value : `${process.cwd()}${path.sep}${value}`;
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(/[\\/]+/u)) {
    if (!component || component === '.') continue;
    if (component === '..') { current = path.dirname(current); continue; }
    const candidate = path.join(current, component);
    try { current = realpathSync(candidate); }
    catch { current = candidate; }
  }
  return current;
}

/** Detect protected filesystem references even when an arbitrary environment value uses lexical aliases. */
export function environmentValueDisclosesProtectedPath(value: string, protectedPaths: readonly string[], allowedPaths: readonly string[] = []): boolean {
  const protectedCanonical = [...new Set(protectedPaths.map(canonicalFilesystemPath))];
  const allowedCanonical = [...new Set(allowedPaths.map(canonicalFilesystemPath))];
  const candidates = new Set<string>();
  if (path.isAbsolute(value)) candidates.add(value);
  for (const item of value.split(path.delimiter)) if (path.isAbsolute(item)) candidates.add(item);
  for (const match of value.matchAll(/\/[^\0\r\n\s"'`,;:]+/gu)) if (match[0].length > 1) candidates.add(match[0]);
  return [...candidates].some((candidate) => {
    const canonical = canonicalFilesystemPath(candidate);
    if (allowedCanonical.some((allowedPath) => canonical === allowedPath || canonical.startsWith(`${allowedPath}${path.sep}`))) return false;
    return protectedCanonical.some((protectedPath) => canonical === protectedPath || canonical.startsWith(`${protectedPath}${path.sep}`));
  });
}

function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_') && value !== undefined) environment[name] = value;
  }
  return { ...environment, ...FIXED_GIT_ENV, ...extra };
}

async function run(executable: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Uint8Array } = {}): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${executable} ${args.join(' ')} failed (${code ?? signal ?? 'unknown'}): ${Buffer.concat(stderr).toString('utf8').trim()}`));
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

async function git(repository: string, args: readonly string[], extraEnvironment: NodeJS.ProcessEnv = {}): Promise<Buffer> {
  return await run('git', ['-C', repository, '--no-optional-locks', ...args], { env: gitEnvironment(extraEnvironment) });
}

function normalizedRelativePath(value: string, label: string): string {
  const normalized = value.replace(/\/$/u, '');
  if (normalized === '' || path.posix.isAbsolute(normalized) || normalized.includes('\\')) {
    throw new Error(`${label} is not a normalized repository-relative path: ${value}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error(`${label} contains an unsafe path component: ${value}`);
  }
  return normalized;
}

function excluded(file: string, exclusions: readonly string[]): boolean {
  return exclusions.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

async function mustNotExist(target: string): Promise<void> {
  try {
    await lstat(target);
    throw new Error(`snapshot destination must not already exist: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function parseTree(output: Buffer): Array<{ mode: string; oid: string; path: string }> {
  const entries: Array<{ mode: string; oid: string; path: string }> = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  while (offset < output.length) {
    const nul = output.indexOf(0, offset);
    if (nul < 0) throw new Error('unterminated Git tree record');
    const recordBytes = output.subarray(offset, nul);
    offset = nul + 1;
    if (recordBytes.length === 0) continue;
    let record: string;
    try { record = decoder.decode(recordBytes); }
    catch { throw new Error('Git tree contains a non-UTF-8 path unsupported by the snapshot contract'); }
    const tab = record.indexOf('\t');
    const header = record.slice(0, tab).split(' ');
    if (tab < 0 || header.length !== 3 || header[1] !== 'blob' || header[0] === undefined || header[2] === undefined) {
      throw new Error(`unsupported Git tree entry: ${JSON.stringify(record)}`);
    }
    entries.push({ mode: header[0], oid: header[2], path: record.slice(tab + 1) });
  }
  return entries;
}

function manifestIdentity(input: Omit<SnapshotManifest, 'content_identity' | 'synthetic_commit' | 'synthetic_tree' | 'isolation'>): `sha256:${string}` {
  return canonicalHash(input);
}

export interface CandidateManifestV2 {
  readonly source_commit: string;
  readonly source_tree: string;
  readonly excluded_paths: readonly string[];
  readonly entries: readonly { path: string; mode: string; oid: string }[];
  readonly manifest_hash: `sha256:${string}`;
}

/** Derive the candidate-visible source identity directly from the selected Git tree. */
export async function deriveCandidateManifest(options: Pick<BuildSnapshotOptions, 'sourceRepository' | 'baseCommit' | 'excludedPaths'>): Promise<CandidateManifestV2> {
  const source = await realpath(options.sourceRepository);
  const excludedPaths = [...new Set((options.excludedPaths ?? []).map((entry) => normalizedRelativePath(entry, 'excluded path')))].sort();
  const sourceCommit = (await git(source, ['rev-parse', '--verify', `${options.baseCommit}^{commit}`])).toString('utf8').trim();
  const sourceTree = (await git(source, ['rev-parse', '--verify', `${sourceCommit}^{tree}`])).toString('utf8').trim();
  const entries = parseTree(await git(source, ['ls-tree', '-rz', '--full-tree', sourceCommit]))
    .filter((entry) => !excluded(entry.path, excludedPaths))
    .map((entry) => ({ path: normalizedRelativePath(entry.path, 'Git tree path'), mode: entry.mode, oid: entry.oid }));
  const core = { source_commit: sourceCommit, source_tree: sourceTree, excluded_paths: excludedPaths, entries } as const;
  return Object.freeze({ ...core, manifest_hash: canonicalHash(core) });
}

/** Export a selected commit without checkout filters or any source Git metadata. */
export async function buildSnapshot(options: BuildSnapshotOptions): Promise<SnapshotManifest> {
  const source = await realpath(options.sourceRepository);
  const destination = path.resolve(options.destination);
  await mustNotExist(destination);
  const exclusions = [...new Set((options.excludedPaths ?? []).map((entry) => normalizedRelativePath(entry, 'excluded path')))].sort();
  const sourceCommit = (await git(source, ['rev-parse', '--verify', `${options.baseCommit}^{commit}`])).toString('utf8').trim();
  const sourceTree = (await git(source, ['rev-parse', '--verify', `${sourceCommit}^{tree}`])).toString('utf8').trim();
  const treeEntries = parseTree(await git(source, ['ls-tree', '-rz', '--full-tree', sourceCommit]));
  const caseFolded = new Set<string>();
  const entries: SnapshotEntry[] = [];

  await mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    for (const item of treeEntries) {
      const relative = normalizedRelativePath(item.path, 'Git tree path');
      if (excluded(relative, exclusions)) continue;
      const folded = relative.toLowerCase();
      if (caseFolded.has(folded)) throw new Error(`case-colliding Git tree path: ${relative}`);
      caseFolded.add(folded);
      if (item.mode !== '100644' && item.mode !== '100755' && item.mode !== '120000') {
        throw new Error(`unsupported Git mode ${item.mode} at ${relative}`);
      }
      const bytes = await git(source, ['cat-file', 'blob', item.oid]);
      const output = path.join(destination, ...relative.split('/'));
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      if (item.mode === '120000') {
        const target = bytes.toString('utf8');
        if (target.includes('\0') || path.isAbsolute(target) || path.resolve(path.dirname(output), target).split(path.sep).includes('..') || !path.resolve(path.dirname(output), target).startsWith(`${destination}${path.sep}`)) {
          throw new Error(`unsafe candidate symlink target at ${relative}`);
        }
        await symlink(target, output);
      } else {
        await writeFile(output, bytes, { mode: item.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
        await chmod(output, item.mode === '100755' ? 0o755 : 0o644);
      }
      entries.push({
        path: relative,
        mode: item.mode,
        type: item.mode === '120000' ? 'symlink' : 'file',
        size: bytes.length,
        sha256: `sha256:${sha256Hex(bytes)}`,
      });
    }
    entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    await run('git', ['init', '--quiet', '--template=', '--object-format=sha1', '--initial-branch', SNAPSHOT_BRANCH, destination], { env: gitEnvironment() });
    await git(destination, ['config', 'core.logAllRefUpdates', 'false']);
    await git(destination, ['config', 'user.name', 'YYLO Benchmark']);
    await git(destination, ['config', 'user.email', 'benchmark.invalid@example.invalid']);
    await git(destination, ['add', '--all', '--', '.']);
    const commitEnvironment = {
      GIT_AUTHOR_NAME: 'YYLO Benchmark',
      GIT_AUTHOR_EMAIL: 'benchmark.invalid@example.invalid',
      GIT_COMMITTER_NAME: 'YYLO Benchmark',
      GIT_COMMITTER_EMAIL: 'benchmark.invalid@example.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    };
    await git(destination, ['commit', '--quiet', '--no-gpg-sign', '-m', 'YYLO Benchmark synthetic baseline'], commitEnvironment);
    const syntheticCommit = (await git(destination, ['rev-parse', 'HEAD'])).toString('utf8').trim();
    const syntheticTree = (await git(destination, ['rev-parse', 'HEAD^{tree}'])).toString('utf8').trim();
    const identityInput = { schema_version: SNAPSHOT_SCHEMA_VERSION, source_commit: sourceCommit, source_tree: sourceTree, excluded_paths: exclusions, entries } as const;
    return {
      ...identityInput,
      content_identity: manifestIdentity(identityInput),
      synthetic_commit: syntheticCommit,
      synthetic_tree: syntheticTree,
      isolation: { git_objects: 'isolated', host_filesystem: 'trusted', container: 'none' },
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else result.push(absolute);
    }
  };
  await visit(root);
  return result;
}

async function currentManifestEntries(repository: string): Promise<SnapshotEntry[]> {
  const tree = parseTree(await git(repository, ['ls-tree', '-rz', '--full-tree', 'HEAD']));
  const entries: SnapshotEntry[] = [];
  for (const item of tree) {
    if (item.mode !== '100644' && item.mode !== '100755' && item.mode !== '120000') throw new Error(`doctor: unsupported mode ${item.mode} at ${item.path}`);
    const bytes = await git(repository, ['cat-file', 'blob', item.oid]);
    entries.push({ path: item.path, mode: item.mode, type: item.mode === '120000' ? 'symlink' : 'file', size: bytes.length, sha256: `sha256:${sha256Hex(bytes)}` });
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function workingTreeEntries(repository: string): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  const visit = async (directory: string, relativeRoot: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (relativeRoot === '' && item.name === '.git') continue;
      const relative = relativeRoot === '' ? item.name : `${relativeRoot}/${item.name}`;
      const normalized = normalizedRelativePath(relative, 'result manifest path');
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) await visit(absolute, normalized);
      else if (item.isFile()) {
        const bytes = await readFile(absolute); const metadata = await lstat(absolute);
        entries.push({ path: normalized, mode: (metadata.mode & 0o111) === 0 ? '100644' : '100755', type: 'file', size: bytes.length, sha256: `sha256:${sha256Hex(bytes)}` });
      } else if (item.isSymbolicLink()) {
        const target = await readlink(absolute); const bytes = Buffer.from(target); const resolved = path.resolve(path.dirname(absolute), target);
        if (path.isAbsolute(target) || (resolved !== repository && !resolved.startsWith(`${repository}${path.sep}`))) throw new Error(`doctor: unsafe result symlink at ${normalized}`);
        entries.push({ path: normalized, mode: '120000', type: 'symlink', size: bytes.length, sha256: `sha256:${sha256Hex(bytes)}` });
      } else throw new Error(`doctor: unsupported result filesystem entry at ${normalized}`);
    }
  };
  await visit(repository, '');
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/** Capture the exact candidate-produced Git and worktree result after execution. */
export async function captureRepositoryResult(repositoryPath: string): Promise<RepositoryResultManifest> {
  const repository = await realpath(repositoryPath);
  const head = (await git(repository, ['rev-parse', '--verify', 'HEAD'])).toString('utf8').trim();
  const symbolicHead = await git(repository, ['symbolic-ref', '--quiet', 'HEAD']).then((value) => value.toString('utf8').trim()).catch(() => '');
  const head_identity: RepositoryResultManifest['head_identity'] = symbolicHead === '' ? { kind: 'detached' } : { kind: 'symbolic', ref: symbolicHead };
  const tree = (await git(repository, ['rev-parse', '--verify', 'HEAD^{tree}'])).toString('utf8').trim();
  const refs = (await git(repository, ['for-each-ref', '--format=%(refname)%00%(objectname)'])).toString('utf8').split('\n').filter(Boolean).sort();
  const index = (await git(repository, ['ls-files', '--stage', '-z'])).toString('utf8').split('\0').filter(Boolean).sort();
  const status = (await git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).toString('utf8').split('\0').filter(Boolean);
  const entries = await workingTreeEntries(repository);
  const core = { schema_version: 'yylo_benchmark_repository_result.v2' as const, head, head_identity, tree, refs, index, status, entries };
  return Object.freeze({ ...core, manifest_hash: canonicalHash(core) });
}

const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[opsu]_[A-Za-z0-9]{30,}\b/u,
  /https?:\/\/[^\s/:]+:[^\s/@]+@/u,
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.+=]{12,}/iu,
];
const ROUTING_ENV = /^(?:(?:YYLO_BENCHMARK_|JUNO_BENCHMARK_).*|JUNO_TASK_ROOT|JUNO_CONTROLLER_ROOT|JUNO_CANONICAL_CONTROLLER|(?:YYLO_LEDGER_|JUNO_KANBAN_)(?:ROOT|CONFIG|COMMAND)|GIT_(?:DIR|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES))$/u;
const CREDENTIAL_ENV = /(?:(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION|COOKIE)$|^(?:GIT|SSH)_ASKPASS$|^SSH_AUTH_SOCK$|^AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|PROFILE|DEFAULT_PROFILE|WEB_IDENTITY_TOKEN_FILE|SHARED_CREDENTIALS_FILE|CONFIG_FILE|CONTAINER_CREDENTIALS_(?:RELATIVE|FULL)_URI|CONTAINER_AUTHORIZATION_TOKEN_FILE)$|^GOOGLE_APPLICATION_CREDENTIALS$|^AZURE_(?:CLIENT_ID|CLIENT_SECRET|CLIENT_CERTIFICATE_PATH|TENANT_ID|USERNAME|PASSWORD)$)/iu;

/** One credential classification shared by candidate environment construction and doctor. */
export function isCredentialEnvironmentName(name: string): boolean { return CREDENTIAL_ENV.test(name); }

async function resolvedGitPath(repository: string, query: '--git-common-dir' | '--git-dir'): Promise<string> {
  const reported = (await git(repository, ['rev-parse', query])).toString('utf8').trim();
  return await realpath(path.isAbsolute(reported) ? reported : path.resolve(repository, reported));
}

/** Verify the fresh-repository boundary and the exact committed/worktree manifest. */
export async function doctorSnapshot(options: SnapshotDoctorOptions): Promise<SnapshotDoctorResult> {
  const repository = await realpath(options.repository);
  const gitPath = path.join(repository, '.git');
  if (!(await lstat(gitPath)).isDirectory()) throw new Error('doctor: .git must be a private directory, not a worktree link');
  const commonDir = await resolvedGitPath(repository, '--git-common-dir');
  if (commonDir !== await realpath(gitPath)) throw new Error('doctor: linked Git common directory detected');
  const sourceGit = options.sourceRepository === undefined
    ? undefined
    : await resolvedGitPath(await realpath(options.sourceRepository), '--git-dir');
  if (sourceGit !== undefined && (await realpath(path.join(gitPath, 'objects'))).startsWith(`${sourceGit}${path.sep}`)) throw new Error('doctor: snapshot object database reaches source Git directory');

  const refs = (await git(repository, ['for-each-ref', '--format=%(refname)'])).toString('utf8').trim().split('\n').filter(Boolean);
  if (options.resultManifest === undefined) {
    if (refs.length !== 1 || refs[0] !== `refs/heads/${SNAPSHOT_BRANCH}`) throw new Error(`doctor: unexpected refs: ${refs.join(', ') || '(none)'}`);
    if ((await git(repository, ['rev-list', '--count', '--all'])).toString('utf8').trim() !== '1') throw new Error('doctor: repository must contain exactly one commit');
  }
  if ((await git(repository, ['remote'])).toString('utf8').trim() !== '') throw new Error('doctor: remotes are forbidden');
  const forbiddenMetadata = ['objects/info/alternates', 'packed-refs', 'commondir', 'gitdir'];
  for (const relative of forbiddenMetadata) {
    try { await lstat(path.join(gitPath, relative)); throw new Error(`doctor: forbidden Git metadata exists: ${relative}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  for (const relative of ['logs', 'worktrees']) {
    try {
      const found = await filesBelow(path.join(gitPath, relative));
      if (found.length > 0) throw new Error(`doctor: ${relative} metadata is forbidden`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const configText = await readFile(path.join(gitPath, 'config'), 'utf8');
  if (/\[(?:remote|include|includeIf)\b/iu.test(configText) || /(?:alternate|worktree|credential|http\..*extraheader)/iu.test(configText)) {
    throw new Error('doctor: unsafe Git configuration detected');
  }
  const currentHead = (await git(repository, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  if (options.resultManifest === undefined) {
    if (currentHead !== options.manifest.synthetic_commit) throw new Error('doctor: synthetic commit identity mismatch');
    const tree = (await git(repository, ['rev-parse', 'HEAD^{tree}'])).toString('utf8').trim();
    if (tree !== options.manifest.synthetic_tree) throw new Error('doctor: synthetic tree identity mismatch');
    const entries = await currentManifestEntries(repository);
    if (canonicalHash(entries) !== canonicalHash(options.manifest.entries)) throw new Error('doctor: committed manifest differs from the declared manifest');
    const identityInput = { schema_version: SNAPSHOT_SCHEMA_VERSION, source_commit: options.manifest.source_commit, source_tree: options.manifest.source_tree, excluded_paths: options.manifest.excluded_paths, entries } as const;
    if (manifestIdentity(identityInput) !== options.manifest.content_identity) throw new Error('doctor: deterministic content identity mismatch');
    if ((await git(repository, ['status', '--porcelain=v1', '--untracked-files=all'])).length !== 0) throw new Error('doctor: candidate worktree differs from synthetic baseline');
  } else {
    const { manifest_hash: claimed, ...core } = options.resultManifest;
    if (claimed !== canonicalHash(core)) throw new Error('doctor: post-execution repository manifest integrity failed');
    const current = await captureRepositoryResult(repository);
    if (canonicalHash(current) !== canonicalHash(options.resultManifest)) throw new Error('doctor: post-execution repository/workspace drift detected');
  }

  const automaticSourceReferences = options.sourceRepository === undefined
    ? []
    : [...new Set([path.resolve(options.sourceRepository), await realpath(options.sourceRepository), ...(sourceGit === undefined ? [] : [sourceGit])])];
  const needles = [...(options.prohibitedByteSequences ?? []), ...(options.canonicalControllerPaths ?? []), ...automaticSourceReferences]
    .map((value) => typeof value === 'string' ? Buffer.from(value) : Buffer.from(value))
    .filter((value) => value.length > 0);
  for (const needle of needles) if (Buffer.from(configText).indexOf(needle) >= 0) throw new Error('doctor: source or canonical path leaked into Git configuration');
  const visibleFiles = (await filesBelow(repository)).filter((file) => !file.startsWith(`${gitPath}${path.sep}`));
  const explicitNeedles = [...(options.prohibitedByteSequences ?? []), ...(options.canonicalControllerPaths ?? [])]
    .map((value) => Buffer.from(value)).filter((value) => value.length > 0);
  const ownRoot = await realpath(repository);
  for (const file of visibleFiles) {
    const bytes = await readFile(file);
    for (const needle of explicitNeedles) if (bytes.indexOf(needle) >= 0) throw new Error(`doctor: prohibited reference bytes found in ${path.relative(repository, file)}`);
    const text = bytes.toString('utf8');
    // Only automatic source-prefix checks may exempt existing, resolved own paths.
    // Explicit protected bytes and credential checks always inspect the original bytes.
    let sourceText = text;
    if (automaticSourceReferences.some((reference) => text.includes(reference))) {
      const tokens = [...text.matchAll(/\/[^\s"'`<>()[\]{}\\,;]+/gu)].reverse();
      for (const match of tokens) {
        const token = match[0].replace(/:\d+(?::\d+)?$/u, '');
        const lexical = path.resolve(token);
        if (lexical !== ownRoot && !lexical.startsWith(`${ownRoot}${path.sep}`)) continue;
        const actual = await realpath(token).catch(() => null);
        if (actual !== ownRoot && (actual === null || !actual.startsWith(`${ownRoot}${path.sep}`))) continue;
        sourceText = sourceText.slice(0, match.index) + '[candidate-own-path]' + sourceText.slice(match.index + match[0].length);
      }
    }
    if (automaticSourceReferences.some((reference) => sourceText.includes(reference))) {
      throw new Error(`doctor: prohibited reference bytes found in ${path.relative(repository, file)}`);
    }
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) throw new Error(`doctor: credential-like bytes found in ${path.relative(repository, file)}`);
  }
  for (const [name, value] of Object.entries(options.candidateEnvironment ?? {})) {
    if (value === undefined) continue;
    if (ROUTING_ENV.test(name)) throw new Error(`doctor: canonical routing environment is present: ${name}`);
    if (isCredentialEnvironmentName(name)) throw new Error(`doctor: credential environment is present: ${name}`);
    if (name.toUpperCase() === 'PATH' && value.split(path.delimiter).some((item) => item === '' || !path.isAbsolute(item))) {
      throw new Error(`doctor: relative PATH environment entry is present: ${name}`);
    }
    if (environmentValueDisclosesProtectedPath(value, [...(options.canonicalControllerPaths ?? []), ...automaticSourceReferences], [path.dirname(options.repository)])) {
      throw new Error(`doctor: protected source or controller reference is present in environment: ${name}`);
    }
  }
  const fsck = (await git(repository, ['fsck', '--full', '--no-reflogs', '--strict', '--unreachable'])).toString('utf8');
  if (/^(?:unreachable|dangling) /mu.test(fsck)) throw new Error('doctor: unreachable or extra Git objects detected');
  return { ok: true, content_identity: options.manifest.content_identity, synthetic_commit: currentHead, isolation: options.manifest.isolation };
}
