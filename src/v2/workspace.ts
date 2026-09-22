import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalHash, canonicalJson } from '../contracts/canonical.js';
import { buildSnapshot, captureRepositoryResult, deriveCandidateManifest, doctorSnapshot, environmentValueDisclosesProtectedPath, isCredentialEnvironmentName, type RepositoryResultManifest, type SnapshotManifest } from '../snapshot/index.js';

export const ATTEMPT_WORKSPACE_SCHEMA_VERSION = 'yylo_benchmark_attempt_workspace.v2' as const;

export interface AttemptWorkspaceReceiptV2 {
  readonly schema_version: typeof ATTEMPT_WORKSPACE_SCHEMA_VERSION;
  readonly attempt_id: `sha256:${string}`;
  readonly backend: 'fresh_repository';
  readonly source_commit: string;
  readonly source_tree: string;
  readonly candidate_manifest_hash: `sha256:${string}`;
  readonly snapshot_identity: `sha256:${string}`;
  readonly roots: {
    readonly repository: string;
    readonly temporary: string;
    readonly cache: string;
    readonly config: string;
    readonly home: string;
  };
  readonly isolation: {
    readonly git_objects: 'isolated';
    readonly host_filesystem: 'trusted' | 'selectively_sandboxed';
    readonly container: 'none';
    readonly sibling_discovery: 'not_exposed';
    readonly private_registry: 'not_exposed';
  };
  readonly receipt_hash: `sha256:${string}`;
}

export interface AttemptWorkspaceV2 {
  readonly root: string;
  readonly repository: string;
  readonly temporaryRoot: string;
  readonly cacheRoot: string;
  readonly configRoot: string;
  readonly homeRoot: string;
  readonly candidateEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly receipt: AttemptWorkspaceReceiptV2;
  readonly snapshot: SnapshotManifest;
  readonly resultManifest: RepositoryResultManifest | null;
  readonly controllerPaths: readonly string[];
  readonly deniedPaths: readonly string[];
  /** True only for paths intentionally inside this attempt's candidate-visible repository. */
  assertCandidateVisible(candidate: string): boolean;
}

export interface CreateAttemptWorkspaceOptions {
  readonly attemptId: `sha256:${string}`;
  readonly sourceRepository: string;
  readonly baseCommit: string;
  readonly attemptsRoot: string;
  readonly privateRegistryRoot: string;
  readonly excludedPaths?: readonly string[];
  readonly controllerPaths?: readonly string[];
  readonly deniedPaths?: readonly string[];
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
}

const ROUTING = /^(?:(?:PWD|OLDPWD|INIT_CWD)|NPM_(?:CONFIG_LOCAL_PREFIX|PACKAGE_JSON)|(?:YYLO|JUNO)_(?:BENCHMARK|TASK|CONTROLLER|CANONICAL|KANBAN|LEDGER).*|GIT_(?:DIR|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES))$/iu;

function digestFromAttemptId(attemptId: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(attemptId)) throw new Error('attempt ID must be sha256:<lowercase hex>');
  return attemptId.slice(7);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`attempt root is unsafe: ${directory}`);
}

function candidateEnvironment(options: {
  inherited: NodeJS.ProcessEnv;
  repository: string;
  temporary: string;
  cache: string;
  config: string;
  home: string;
  protectedPaths: readonly string[];
}): Readonly<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {};
  const protectedPaths = [...new Set(options.protectedPaths.map((item) => path.resolve(item)))];
  const disclosed = (value: string) => environmentValueDisclosesProtectedPath(value, protectedPaths);
  for (const [name, value] of Object.entries(options.inherited)) {
    if (value === undefined || ROUTING.test(name) || isCredentialEnvironmentName(name)) continue;
    if (name.toUpperCase() === 'PATH') {
      const safe = value.split(path.delimiter).filter((item) => item !== '' && path.isAbsolute(item) && !disclosed(item)).join(path.delimiter);
      if (safe !== '') environment[name] = safe;
    } else if (!disclosed(value)) environment[name] = value;
  }
  Object.assign(environment, {
    HOME: options.home,
    TMPDIR: options.temporary,
    TMP: options.temporary,
    TEMP: options.temporary,
    XDG_CACHE_HOME: options.cache,
    XDG_CONFIG_HOME: options.config,
    XDG_DATA_HOME: path.join(options.home, '.local', 'share'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });
  return Object.freeze(environment);
}

/** Build one candidate-visible fresh repository and private per-attempt process roots. */
export async function createAttemptWorkspace(options: CreateAttemptWorkspaceOptions): Promise<AttemptWorkspaceV2> {
  const digest = digestFromAttemptId(options.attemptId);
  const attemptsRoot = path.resolve(options.attemptsRoot);
  const registryRoot = path.resolve(options.privateRegistryRoot);
  const controllerPaths = [...new Set([registryRoot, ...(options.controllerPaths ?? []).map((item) => path.resolve(item))])];
  // Environment filtering still protects source; doctor must distinguish automatic source from explicit protection.
  const protectedPaths = [...new Set([path.resolve(options.sourceRepository), ...controllerPaths])];
  if (inside(attemptsRoot, registryRoot) || inside(registryRoot, attemptsRoot)) {
    throw new Error('private registry and attempt roots must be disjoint');
  }
  await privateDirectory(attemptsRoot);
  const root = path.join(attemptsRoot, digest);
  // buildSnapshot requires a non-existent destination, so only create the parent.
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  const repository = path.join(root, 'repository');
  const temporary = path.join(root, 'tmp');
  const cache = path.join(root, 'cache');
  const config = path.join(root, 'config');
  const home = path.join(root, 'home');
  for (const directory of [temporary, cache, config, home]) await privateDirectory(directory);
  await privateDirectory(path.join(home, '.local', 'share'));

  const mandatoryExclusions = ['.juno_task', ...(options.excludedPaths ?? [])];
  const snapshot = await buildSnapshot({
    sourceRepository: options.sourceRepository,
    baseCommit: options.baseCommit,
    destination: repository,
    excludedPaths: [...new Set(mandatoryExclusions)],
  });
  const candidateManifest = await deriveCandidateManifest({ sourceRepository: options.sourceRepository, baseCommit: options.baseCommit,
    excludedPaths: [...new Set(mandatoryExclusions)] });
  await chmod(repository, 0o700);
  const environment = candidateEnvironment({ inherited: options.inheritedEnvironment ?? process.env, repository, temporary, cache, config, home, protectedPaths });
  const core = {
    schema_version: ATTEMPT_WORKSPACE_SCHEMA_VERSION,
    attempt_id: options.attemptId,
    backend: 'fresh_repository' as const,
    source_commit: snapshot.source_commit,
    source_tree: snapshot.source_tree,
    candidate_manifest_hash: candidateManifest.manifest_hash,
    snapshot_identity: snapshot.content_identity,
    roots: { repository: 'repository', temporary: 'tmp', cache: 'cache', config: 'config', home: 'home' },
    isolation: {
      git_objects: 'isolated' as const,
      host_filesystem: (options.deniedPaths?.length ?? 0) > 0 ? 'selectively_sandboxed' as const : 'trusted' as const,
      container: 'none' as const,
      sibling_discovery: 'not_exposed' as const,
      private_registry: 'not_exposed' as const,
    },
  };
  const receipt: AttemptWorkspaceReceiptV2 = Object.freeze({ ...core, receipt_hash: canonicalHash(core) });
  await writeFile(path.join(root, '.workspace.json'), `${canonicalJson({ receipt, snapshot })}\n`, { mode: 0o600, flag: 'wx' });
  const canonicalRepository = await realpath(repository);
  return Object.freeze({
    root,
    repository,
    temporaryRoot: temporary,
    cacheRoot: cache,
    configRoot: config,
    homeRoot: home,
    candidateEnvironment: environment,
    receipt,
    snapshot,
    resultManifest: null,
    controllerPaths: Object.freeze(controllerPaths), deniedPaths: Object.freeze([...(options.deniedPaths ?? [])]),
    assertCandidateVisible(candidate: string): boolean { return inside(canonicalRepository, candidate); },
  });
}

export async function loadAttemptWorkspace(options: Pick<CreateAttemptWorkspaceOptions, 'attemptId' | 'attemptsRoot' | 'inheritedEnvironment'> & {
  readonly sourceRepository?: string; readonly privateRegistryRoot?: string; readonly controllerPaths?: readonly string[]; readonly deniedPaths?: readonly string[];
}): Promise<AttemptWorkspaceV2> {
  const root = path.join(path.resolve(options.attemptsRoot), digestFromAttemptId(options.attemptId));
  const value = JSON.parse(await readFile(path.join(root, '.workspace.json'), 'utf8')) as { receipt?: AttemptWorkspaceReceiptV2; snapshot?: SnapshotManifest };
  let resultManifest: RepositoryResultManifest | null = null;
  try { resultManifest = JSON.parse(await readFile(path.join(root, '.result-workspace.json'), 'utf8')) as RepositoryResultManifest; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const receipt = value.receipt;
  const snapshot = value.snapshot;
  if (receipt === undefined || snapshot === undefined || receipt.schema_version !== ATTEMPT_WORKSPACE_SCHEMA_VERSION
      || receipt.attempt_id !== options.attemptId) throw new Error('attempt workspace receipt is malformed');
  const { receipt_hash: claimed, ...core } = receipt;
  if (claimed !== canonicalHash(core) || receipt.source_commit !== snapshot.source_commit || receipt.source_tree !== snapshot.source_tree
      || receipt.snapshot_identity !== snapshot.content_identity) throw new Error('attempt workspace receipt integrity failed');
  const repository = path.join(root, receipt.roots.repository);
  const temporary = path.join(root, receipt.roots.temporary);
  const cache = path.join(root, receipt.roots.cache);
  const config = path.join(root, receipt.roots.config);
  const home = path.join(root, receipt.roots.home);
  const canonicalRepository = await realpath(repository);
  const controllerPaths = [...new Set([...(options.privateRegistryRoot === undefined ? [] : [path.resolve(options.privateRegistryRoot)]),
    ...(options.controllerPaths ?? []).map((item) => path.resolve(item))])];
  const protectedPaths = [...new Set([...(options.sourceRepository === undefined ? [] : [path.resolve(options.sourceRepository)]), ...controllerPaths])];
  const environment = candidateEnvironment({ inherited: options.inheritedEnvironment ?? process.env, repository, temporary, cache, config, home, protectedPaths });
  return Object.freeze({ root, repository, temporaryRoot: temporary, cacheRoot: cache, configRoot: config, homeRoot: home,
    candidateEnvironment: environment, receipt: Object.freeze(receipt), snapshot: Object.freeze(snapshot),
    resultManifest: resultManifest === null ? null : Object.freeze(resultManifest), controllerPaths: Object.freeze(controllerPaths),
    deniedPaths: Object.freeze([...(options.deniedPaths ?? [])]),
    assertCandidateVisible(candidate: string): boolean { return inside(canonicalRepository, candidate); } });
}

/** Publish the candidate's exact post-execution repository identity once, before terminal publication. */
export async function publishAttemptWorkspaceResult(workspace: AttemptWorkspaceV2): Promise<RepositoryResultManifest> {
  const result = await captureRepositoryResult(workspace.repository);
  const destination = path.join(workspace.root, '.result-workspace.json');
  try { await writeFile(destination, `${canonicalJson(result)}\n`, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const retained = JSON.parse(await readFile(destination, 'utf8')) as RepositoryResultManifest;
    if (canonicalHash(retained) !== canonicalHash(result)) throw new Error('post-execution repository/workspace drift detected before terminal publication');
    return retained;
  }
  return result;
}

export async function doctorAttemptWorkspace(
  workspace: AttemptWorkspaceV2,
  options: { readonly sourceRepository?: string } = {},
): Promise<{ readonly ok: true; readonly receipt_hash: `sha256:${string}` }> {
  const metadata = await lstat(workspace.root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new Error('attempt workspace root is not private');
  if (workspace.assertCandidateVisible(workspace.root) || workspace.assertCandidateVisible(path.dirname(workspace.root))) {
    throw new Error('candidate visibility boundary includes attempt control paths');
  }
  await doctorSnapshot({
    repository: workspace.repository,
    manifest: workspace.snapshot,
    ...(workspace.resultManifest === null ? {} : { resultManifest: workspace.resultManifest }),
    ...(options.sourceRepository === undefined ? {} : { sourceRepository: options.sourceRepository }),
    canonicalControllerPaths: workspace.controllerPaths,
    candidateEnvironment: workspace.candidateEnvironment,
  });
  return Object.freeze({ ok: true, receipt_hash: workspace.receipt.receipt_hash });
}
