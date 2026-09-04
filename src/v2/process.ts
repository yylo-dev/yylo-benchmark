import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface CapturedProcessOptions {
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly timeoutMs: number;
  readonly termGraceMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly stdin?: string;
  readonly extraPipeCount?: number;
  readonly deniedPaths?: readonly string[];
}

export interface CapturedProcessResult {
  readonly pid: number | null;
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly extra: readonly string[];
  readonly timedOut: boolean;
  readonly runtimeMs: number;
}

const DEFAULT_TERM_GRACE_MS = 500;

export function linuxBubblewrapArguments(executable: string, args: readonly string[], options: Pick<CapturedProcessOptions, 'cwd' | 'environment'>,
  deniedPaths: readonly string[]): string[] {
  const writableRoots = [...new Set(['HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']
    .flatMap((name) => { const value = options.environment[name]; return value !== undefined && path.isAbsolute(value) && existsSync(value) ? [realpathSync(value)] : []; }))]
    .filter((item) => !deniedPaths.some((denied) => item === denied || item.startsWith(`${denied}${path.sep}`)));
  return ['--die-with-parent', '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc',
    '--bind', path.resolve(options.cwd), path.resolve(options.cwd), ...writableRoots.flatMap((item) => ['--bind', item, item]),
    ...deniedPaths.filter((item) => existsSync(item)).flatMap((item) => ['--tmpfs', item]),
    // bubblewrap synthesizes PWD after applying its own environment options.
    // Strip it in the final exec boundary so the admitted candidate environment
    // remains authoritative and does not expose generated workspace topology.
    '--chdir', path.resolve(options.cwd), '/usr/bin/env', '-u', 'PWD', executable, ...args];
}

export function assertProcessTreeSupported(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') throw new Error('process-tree timeout isolation is unsupported on Windows; refusing dispatch');
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * Run one process in an isolated process group. Timeout truth is terminal only
 * after bounded TERM grace, group KILL, and the direct child close/reap event.
 */
export async function runCapturedProcess(executable: string, args: readonly string[], options: CapturedProcessOptions): Promise<CapturedProcessResult> {
  assertProcessTreeSupported();
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('process timeout must be a positive integer');
  const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS; const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2000;
  if (!Number.isSafeInteger(termGraceMs) || termGraceMs < 0) throw new Error('TERM grace must be a nonnegative integer');
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1) throw new Error('cleanup timeout must be a positive integer');
  const deniedPaths = [...new Set((options.deniedPaths ?? []).map((item) => {
    const resolved = path.resolve(item);
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  }))]
    .filter((item) => item !== path.resolve(options.cwd) && !path.resolve(options.cwd).startsWith(`${item}${path.sep}`));
  let effectiveExecutable = executable; let effectiveArgs = [...args];
  if (deniedPaths.length > 0 && process.platform === 'darwin') {
    const profile = `(version 1)\n(allow default)\n${deniedPaths.map((item) => `(deny file-read* file-write* (subpath ${JSON.stringify(item)}))`).join('\n')}`;
    effectiveExecutable = '/usr/bin/sandbox-exec'; effectiveArgs = ['-p', profile, executable, ...args];
  } else if (deniedPaths.length > 0 && process.platform === 'linux') {
    const bubblewrap = ['/usr/bin/bwrap', '/bin/bwrap'].find((item) => existsSync(item));
    if (bubblewrap === undefined) throw new Error('candidate filesystem boundary is unavailable: install bubblewrap before dispatch');
    effectiveExecutable = bubblewrap;
    effectiveArgs = linuxBubblewrapArguments(executable, args, options, deniedPaths);
  } else if (deniedPaths.length > 0) {
    throw new Error(`candidate filesystem boundary is unsupported on ${process.platform}; refusing dispatch`);
  }
  return await new Promise((resolve, reject) => {
    const started = Date.now(); const extraPipeCount = options.extraPipeCount ?? 0;
    const child = spawn(effectiveExecutable, effectiveArgs, {
      cwd: options.cwd, env: { ...options.environment }, shell: false, detached: true,
      stdio: ['pipe', 'pipe', 'pipe', ...Array.from({ length: extraPipeCount }, () => 'pipe' as const)],
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; const extra = Array.from({ length: extraPipeCount }, () => [] as Buffer[]);
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    for (let index = 0; index < extraPipeCount; index += 1) {
      const stream = child.stdio[index + 3];
      if (stream !== null && stream !== undefined && 'on' in stream) stream.on('data', (chunk: Buffer) => extra[index]!.push(chunk));
    }
    let timedOut = false; let escalationComplete = false; let groupGone = false; let closed: { code: number | null; signal: string | null } | null = null; let settled = false;
    const finish = () => {
      if (settled || closed === null || (timedOut && (!escalationComplete || !groupGone))) return;
      settled = true;
      resolve({ pid: child.pid ?? null, code: closed.code, signal: closed.signal, stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'), extra: extra.map((chunks) => Buffer.concat(chunks).toString('utf8')),
        timedOut, runtimeMs: Date.now() - started });
    };
    child.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
    child.stdin!.end(options.stdin ?? '');
    const timeout = setTimeout(() => {
      timedOut = true;
      try { signalTree(child, 'SIGTERM'); } catch (error) { if (!settled) { settled = true; reject(error); } return; }
      setTimeout(() => {
        try { signalTree(child, 'SIGKILL'); } catch (error) { if (!settled) { settled = true; reject(error); } return; }
        escalationComplete = true;
        const cleanupStarted = Date.now(); const poll = setInterval(() => {
          if (settled) { clearInterval(poll); return; }
          try { if (child.pid !== undefined) process.kill(-child.pid, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              groupGone = true; finish();
              if (settled) clearInterval(poll);
              else if (Date.now() - cleanupStarted >= cleanupTimeoutMs) {
                clearInterval(poll); settled = true; reject(new Error('direct child reap could not be confirmed within the bounded timeout'));
              }
              return;
            }
            clearInterval(poll); settled = true; reject(error); return;
          }
          if (Date.now() - cleanupStarted >= cleanupTimeoutMs) {
            clearInterval(poll); settled = true; reject(new Error('process group cleanup could not be confirmed within the bounded timeout'));
          }
        }, 10);
      }, termGraceMs);
    }, options.timeoutMs);
    child.once('close', (code, signal) => { clearTimeout(timeout); closed = { code, signal }; finish(); });
  });
}
