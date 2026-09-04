import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateTaskAttemptSpendAuthorization, type CandidateInvocation, type CandidateRunner } from '../execution/index.js';
import type { ProcessEvidence } from '../telemetry/index.js';

export const AUTH_LAUNCHER_PROTOCOL = 'juno_benchmark_auth_launcher.v1' as const;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const SAFE_CREDENTIAL_TOKEN = /^[A-Za-z0-9._~-]+$/u;
interface ProviderAuthTransport { readonly environmentNames: readonly string[] }
const PROVIDER_AUTH_TRANSPORTS: Readonly<Record<string, ProviderAuthTransport>> = Object.freeze({
  openai: Object.freeze({ environmentNames: Object.freeze(['OPENAI_API_KEY']) }),
  'openai-codex': Object.freeze({ environmentNames: Object.freeze(['OPENAI_CODEX_TOKEN']) }),
  anthropic: Object.freeze({ environmentNames: Object.freeze(['ANTHROPIC_API_KEY']) }),
  google: Object.freeze({ environmentNames: Object.freeze(['GEMINI_API_KEY', 'GOOGLE_API_KEY']) }),
  gemini: Object.freeze({ environmentNames: Object.freeze(['GEMINI_API_KEY']) }),
  zai: Object.freeze({ environmentNames: Object.freeze(['ZAI_API_KEY']) }),
});

export type CredentialSource =
  | { readonly kind: 'environment'; readonly name: string }
  | { readonly kind: 'file'; readonly path: string };

export interface AuthenticatedLauncherOptions {
  /** Absolute, non-symlinked path to the reviewed launcher executable. */
  readonly executable: string;
  /** Lowercase SHA-256 of the exact launcher bytes. */
  readonly sha256: string;
  readonly provider: string;
  readonly credential: CredentialSource;
  readonly versionTimeoutMs?: number;
}

interface ReviewedLauncher { readonly bytes: Buffer; readonly interpreterBytes: Buffer }
interface ResolvedBoundary { readonly launcher: ReviewedLauncher; readonly secret: Buffer }
interface PinnedExecutable { readonly probe: FileHandle; readonly launch: FileHandle; readonly executablePath?: string; releasePath(): Promise<void>; cleanup(): Promise<void> }
interface PinnedBoundary { readonly launcher: PinnedExecutable; readonly interpreter: PinnedExecutable; cleanup(): Promise<void> }
interface RunningLauncher { readonly child: ChildProcess; readonly stdout: Buffer[]; readonly stderr: Buffer[]; readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; overflow(): boolean; failure(): Error | undefined }

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function safeError(message: string): Error { return new Error(`authenticated launcher boundary rejected the request: ${message}`); }

async function verifiedExecutableBytes(executable: string, identity: 'launcher' | 'interpreter', requireImmutable: boolean): Promise<Buffer> {
  const handle = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw safeError(`${identity} identity cannot be opened safely`); });
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0 || (requireImmutable && (metadata.mode & 0o222) !== 0)) throw safeError(`${identity} is not an immutable executable`);
    if (requireImmutable && typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw safeError(`${identity} owner does not match the benchmark owner`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs || (requireImmutable && (after.mode & 0o222) !== 0)) {
      throw safeError(`${identity} identity changed while it was being pinned`);
    }
    return bytes;
  } finally { await handle.close(); }
}

async function resolveNodeInterpreter(interpreter: string, interpreterArgument: string | undefined, environment: NodeJS.ProcessEnv): Promise<Buffer> {
  let candidate: string;
  if (path.basename(interpreter) === 'env' && interpreterArgument === 'node') {
    const searchPath = environment.PATH;
    if (searchPath === undefined) throw safeError('env node launcher requires an explicit PATH');
    const directories = searchPath.split(path.delimiter);
    if (directories.some((directory) => directory === '' || !path.isAbsolute(directory))) throw safeError('env node launcher PATH must contain only absolute directories');
    let found: string | undefined;
    for (const directory of directories) {
      const entry = path.join(directory, 'node');
      try {
        const metadata = await lstat(entry);
        if ((metadata.isFile() || metadata.isSymbolicLink()) && (metadata.mode & 0o111) !== 0) { found = entry; break; }
      } catch { /* Continue the exact PATH search. */ }
    }
    if (found === undefined) throw safeError('env node interpreter is missing from PATH');
    candidate = await realpath(found).catch(() => { throw safeError('env node interpreter identity is missing'); });
  } else if (path.basename(interpreter) === 'node' && interpreterArgument === undefined && path.isAbsolute(interpreter)) {
    candidate = await realpath(interpreter).catch(() => { throw safeError('node interpreter identity is missing'); });
  } else {
    throw safeError('launcher interpreter form is unsupported');
  }
  return verifiedExecutableBytes(candidate, 'interpreter', false);
}

async function immutableLauncher(options: AuthenticatedLauncherOptions, environment: NodeJS.ProcessEnv): Promise<ReviewedLauncher> {
  if (!path.isAbsolute(options.executable) || !/^[0-9a-f]{64}$/u.test(options.sha256)) throw safeError('launcher identity is incomplete');
  const resolved = await realpath(options.executable).catch(() => { throw safeError('launcher identity is missing'); });
  if (resolved !== options.executable) throw safeError('launcher must be an exact non-symlinked path');

  // O_NOFOLLOW binds validation and the single read to one opened file object. The
  // caller-controlled pathname is never opened again after these bytes are pinned.
  const bytes = await verifiedExecutableBytes(resolved, 'launcher', true);
  if (hash(bytes) !== options.sha256) throw safeError('launcher identity digest does not match');
  const firstLine = bytes.subarray(0, bytes.indexOf(0x0a) < 0 ? bytes.length : bytes.indexOf(0x0a)).toString('utf8').replace(/\r$/u, '');
  const shebang = /^#!(\/\S+?)(?:[ \t]+(\S+))?$/u.exec(firstLine);
  if (shebang === null) throw safeError('launcher must use one absolute shebang interpreter and at most one argument');
  const interpreterBytes = await resolveNodeInterpreter(shebang[1]!, shebang[2], environment);
  return { bytes, interpreterBytes };
}

async function materializeExecutable(bytes: Buffer, kind: 'launcher' | 'interpreter', retainPath = false): Promise<PinnedExecutable> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `yylo-benchmark-${kind}-`)).catch(() => { throw safeError(`verified ${kind} cannot be materialized`); });
  const executable = path.join(directory, `verified-${kind}`);
  let writer: FileHandle | undefined; let probe: FileHandle | undefined; let launch: FileHandle | undefined;
  try {
    await chmod(directory, 0o700);
    writer = await open(executable, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o500);
    await writer.writeFile(bytes); await writer.sync(); await writer.chmod(0o500);
    // Two independent descriptions of the same inode avoid shared script offsets
    // across shebang probe/launch while retaining one exact unlinked file object.
    probe = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
    launch = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
    const expected = await writer.stat(); const probeStat = await probe.stat(); const launchStat = await launch.stat();
    if (!expected.isFile() || (expected.mode & 0o222) !== 0 || probeStat.dev !== expected.dev || probeStat.ino !== expected.ino || launchStat.dev !== expected.dev || launchStat.ino !== expected.ino) {
      throw safeError(`materialized ${kind} identity is unstable`);
    }
    let pathReleased = false;
    const releasePath = async (): Promise<void> => {
      if (!pathReleased) { if (retainPath) await chmod(directory, 0o700); await unlink(executable); pathReleased = true; }
    };
    if (!retainPath) await releasePath(); // No execution pathname remains addressable.
    await writer.close(); writer = undefined;
    if (retainPath) await chmod(directory, 0o500); // Freeze the private interpreter namespace before either spawn.
    const pinnedProbe = probe; const pinnedLaunch = launch; probe = undefined; launch = undefined;
    return { probe: pinnedProbe, launch: pinnedLaunch, ...(retainPath ? { executablePath: executable } : {}), releasePath, cleanup: async () => {
      const closed = await Promise.allSettled([releasePath(), pinnedProbe.close(), pinnedLaunch.close()]);
      const removed = await rm(directory, { recursive: true, force: true }).then(() => true, () => false);
      if (closed.some((result) => result.status === 'rejected') || !removed) throw safeError(`verified ${kind} cleanup failed`);
    } };
  } catch (error) {
    await Promise.allSettled([writer?.close(), probe?.close(), launch?.close()]);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof Error && error.message.startsWith('authenticated launcher boundary rejected')) throw error;
    throw safeError(`verified ${kind} cannot be materialized`);
  }
}

async function materializeBoundary(launcher: ReviewedLauncher): Promise<PinnedBoundary> {
  const pinnedLauncher = await materializeExecutable(launcher.bytes, 'launcher');
  try {
    const pinnedInterpreter = await materializeExecutable(launcher.interpreterBytes, 'interpreter', true);
    return { launcher: pinnedLauncher, interpreter: pinnedInterpreter, cleanup: async () => {
      const cleaned = await Promise.allSettled([pinnedLauncher.cleanup(), pinnedInterpreter.cleanup()]);
      if (cleaned.some((result) => result.status === 'rejected')) throw safeError('verified execution boundary cleanup failed');
    } };
  } catch (error) {
    await pinnedLauncher.cleanup().catch(() => undefined);
    throw error;
  }
}

async function credentialBytes(options: AuthenticatedLauncherOptions, repository: string): Promise<Buffer> {
  const transport = PROVIDER_AUTH_TRANSPORTS[options.provider];
  if (transport === undefined) throw safeError('provider is not allowlisted');
  let bytes: Buffer;
  if (options.credential.kind === 'environment') {
    if (!transport.environmentNames.includes(options.credential.name)) throw safeError('environment credential transport is not allowlisted for the provider');
    const value = process.env[options.credential.name];
    if (value === undefined) throw safeError('credential source is missing');
    bytes = Buffer.from(value);
  } else {
    if (!path.isAbsolute(options.credential.path)) throw safeError('credential file path must be absolute');
    const resolved = await realpath(options.credential.path).catch(() => { throw safeError('credential source is missing'); });
    if (resolved !== options.credential.path || resolved === repository || resolved.startsWith(`${repository}${path.sep}`)) throw safeError('credential file is symlinked or inside the candidate snapshot');
    const metadata = await lstat(resolved);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) || metadata.size > MAX_CREDENTIAL_BYTES) {
      throw safeError('credential file ownership, mode, type, or size is unsafe');
    }
    bytes = await readFile(resolved);
    if (bytes.at(-1) === 0x0a) bytes = bytes.subarray(0, bytes.at(-2) === 0x0d ? bytes.length - 2 : bytes.length - 1);
  }
  const text = bytes.toString('utf8');
  if (bytes.length < 16 || bytes.length > MAX_CREDENTIAL_BYTES || !Buffer.from(text).equals(bytes) || !SAFE_CREDENTIAL_TOKEN.test(text)) {
    bytes.fill(0); throw safeError('credential value is outside the supported provider token alphabet');
  }
  return bytes;
}

async function resolveBoundary(options: AuthenticatedLauncherOptions, input: CandidateInvocation): Promise<ResolvedBoundary> {
  try { validateTaskAttemptSpendAuthorization(input); }
  catch { throw safeError('task dispatch is missing an exact unexpired spend authorization'); }
  const separator = input.attempt.model.indexOf('/');
  const modelProvider = separator > 0 ? input.attempt.model.slice(0, separator) : '';
  const bareModel = separator > 0 ? input.attempt.model.slice(separator + 1) : '';
  if (input.attempt.provider !== options.provider || modelProvider !== options.provider || bareModel === '') {
    throw safeError('attempt provider/model identity does not exactly match the launcher allowlist');
  }
  const launcher = await immutableLauncher(options, input.environment);
  const repository = await realpath(input.repository).catch(() => { throw safeError('candidate repository is missing'); });
  if (options.executable === repository || options.executable.startsWith(`${repository}${path.sep}`)) throw safeError('launcher identity must be outside the candidate snapshot');
  const secret = await credentialBytes(options, repository);
  if (credentialRepresentations(secret).some((value) => input.prompt.includes(value))) {
    secret.fill(0); throw safeError('credential value is present in the candidate prompt');
  }
  return { launcher, secret };
}

function credentialRepresentations(secret: Buffer): readonly string[] {
  const raw = secret.toString('utf8');
  return [...new Set([raw, secret.toString('hex'), secret.toString('base64'), secret.toString('base64url'), encodeURIComponent(raw)])];
}

function scrub(text: string, secret: Buffer): { text: string; leaked: boolean } {
  let clean = text; let leaked = false;
  for (const value of credentialRepresentations(secret)) {
    if (clean.includes(value)) { clean = clean.split(value).join('[REDACTED]'); leaked = true; }
  }
  return { text: clean, leaked };
}

function spawnLauncher(handle: FileHandle, interpreter: string, input: CandidateInvocation, operation: 'probe' | 'launch'): RunningLauncher {
  const launcherArgs = [operation, '--protocol', AUTH_LAUNCHER_PROTOCOL, '--provider', input.attempt.provider, '--model', input.attempt.model, '--juno-version', input.attempt.juno_version];
  const child = spawn(interpreter, ['--input-type=module', '-', ...launcherArgs], {
    cwd: input.repository,
    env: { ...input.environment, YYLO_BENCHMARK_AUTH_PROTOCOL: AUTH_LAUNCHER_PROTOCOL },
    stdio: [handle.fd, 'pipe', 'pipe', operation === 'launch' ? 'pipe' : 'ignore', operation === 'launch' ? 'pipe' : 'ignore'], shell: false,
  });
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let outputOverflow = false;
  const collect = (target: Buffer[]) => (chunk: Buffer): void => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { outputOverflow = true; child.kill('SIGKILL'); } else target.push(chunk); };
  child.stdout?.on('data', collect(stdout)); child.stderr?.on('data', collect(stderr));
  let processFailure: Error | undefined;
  for (const stream of operation === 'launch' ? [child.stdio[3], child.stdio[4]] : []) {
    stream?.on('error', (error: NodeJS.ErrnoException) => {
      // A launcher that rejects input or exits after detecting leakage may close
      // these parent-side pipes before end() completes. That is normal process
      // evidence, not an unhandled host exception.
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') {
        processFailure = error; child.kill('SIGKILL');
      }
    });
  }
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => { processFailure = error; resolve({ code: null, signal: null }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, stdout, stderr, closed, overflow: () => outputOverflow, failure: () => processFailure };
}

async function invokeLauncher(running: RunningLauncher, boundary: ResolvedBoundary, input: CandidateInvocation, operation: 'probe' | 'launch', timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  const { child } = running;
  if (operation === 'launch') {
    (child.stdio[3] as NodeJS.WritableStream | null)?.end(boundary.secret);
    (child.stdio[4] as NodeJS.WritableStream | null)?.end(input.prompt); // Prompt is not exposed in argv, environment, or broker receipts.
  }
  let timedOut = false; let force: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 1_000); }, timeoutMs);
  const closed = await running.closed.finally(() => { clearTimeout(timeout); if (force !== undefined) clearTimeout(force); });
  const processFailure = running.failure();
  if (processFailure !== undefined) throw safeError(`launcher process failed: ${processFailure.message}`);
  if (running.overflow()) throw safeError('launcher output exceeded the bounded capture limit');
  const cleanOut = scrub(Buffer.concat(running.stdout).toString('utf8'), boundary.secret); const cleanErr = scrub(Buffer.concat(running.stderr).toString('utf8'), boundary.secret);
  if (cleanOut.leaked) throw safeError('launcher stdout emitted credential material');
  if (cleanErr.leaked) throw safeError('launcher stderr emitted credential material');
  return { stdout: cleanOut.text, stderr: cleanErr.text, code: closed.code, signal: closed.signal, timedOut };
}

/**
 * Build the sole authenticated execution boundary. The reviewed launcher receives
 * the credential on fd 3 and the prompt on fd 4, must consume and close both before
 * creating candidate tools, and may perform only `probe` and `launch`. Candidate
 * HOME/XDG/environment are otherwise passed through unchanged from snapshot isolation.
 */
export function createAuthenticatedJunoRunner(options: AuthenticatedLauncherOptions): CandidateRunner {
  let prepared: { readonly input: CandidateInvocation; readonly boundary: ResolvedBoundary } | undefined;
  const runner = (async (input: CandidateInvocation): Promise<ProcessEvidence> => {
    const retained = prepared;
    const boundary = retained?.input === input ? retained.boundary : await resolveBoundary(options, input);
    prepared = undefined;
    if (retained !== undefined && retained.boundary !== boundary) retained.boundary.secret.fill(0);
    let pinned: PinnedBoundary | undefined; let probeProcess: RunningLauncher | undefined; let launchProcess: RunningLauncher | undefined;
    try {
      pinned = await materializeBoundary(boundary.launcher);
      const interpreterPath = pinned.interpreter.executablePath;
      if (interpreterPath === undefined) throw safeError('verified interpreter launch path is unavailable');
      // Both native processes are created from the same verified private bytes before
      // probe. The frozen private path is never executed again; launch waits on fd 3.
      probeProcess = spawnLauncher(pinned.launcher.probe, interpreterPath, input, 'probe');
      launchProcess = spawnLauncher(pinned.launcher.launch, interpreterPath, input, 'launch');
      const probe = await invokeLauncher(probeProcess, boundary, input, 'probe', options.versionTimeoutMs ?? 10_000);
      if (probe.timedOut || probe.code !== 0) throw safeError('version probe failed');
      const version = probe.stdout.trim().replace(/^(?:yylo|juno-code)\s+v?/u, '').replace(/^v/u, '');
      if (version !== input.attempt.juno_version) throw safeError('YYLO version mismatch');
      try { validateTaskAttemptSpendAuthorization(input); }
      catch { throw safeError('task dispatch spend authorization expired or drifted during version probe'); }
      const started = new Date(); const monotonic = process.hrtime.bigint();
      const launched = await invokeLauncher(launchProcess, boundary, input, 'launch', input.timeoutMs);
      const ended = new Date();
      return { attemptId: input.attempt.attempt_id, expectedModel: input.attempt.model, expectedJunoVersion: input.attempt.juno_version,
        observedJunoVersion: version, startedAt: started.toISOString(), endedAt: ended.toISOString(), elapsedMs: Number((process.hrtime.bigint() - monotonic) / 1_000_000n),
        exitCode: launched.code, signal: launched.signal, timedOut: launched.timedOut, stdout: launched.stdout, stderr: launched.stderr, patchHash: null };
    } finally {
      boundary.secret.fill(0);
      probeProcess?.child.kill('SIGKILL'); launchProcess?.child.kill('SIGKILL');
      await Promise.allSettled([...(probeProcess === undefined ? [] : [probeProcess.closed]), ...(launchProcess === undefined ? [] : [launchProcess.closed])]);
      if (pinned !== undefined) await pinned.cleanup();
    }
  }) as CandidateRunner;
  runner.preflight = async (input: CandidateInvocation): Promise<void> => {
    const boundary = await resolveBoundary(options, input);
    prepared?.boundary.secret.fill(0);
    prepared = { input, boundary };
  };
  Object.defineProperty(runner, 'requiresSpendAuthorization', { value: true, enumerable: true });
  return runner;
}

export function authenticatedLauncherOptionsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): AuthenticatedLauncherOptions | null {
  const executable = environment['YYLO_BENCHMARK_AUTH_LAUNCHER']?.trim();
  const digest = environment['YYLO_BENCHMARK_AUTH_LAUNCHER_SHA256']?.trim();
  const provider = environment['YYLO_BENCHMARK_AUTH_PROVIDER']?.trim();
  const envName = environment['YYLO_BENCHMARK_AUTH_ENV']?.trim(); const file = environment['YYLO_BENCHMARK_AUTH_FILE']?.trim();
  const any = [executable, digest, provider, envName, file].some((value) => value !== undefined && value !== '');
  if (!any) return null;
  if (!executable || !digest || !provider || (envName ? 1 : 0) + (file ? 1 : 0) !== 1) throw safeError('identity and exactly one credential source are required');
  return { executable, sha256: digest, provider, credential: envName ? { kind: 'environment', name: envName } : { kind: 'file', path: file! } };
}
