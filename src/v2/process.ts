import { spawn } from 'node:child_process';

/** Trusted-host process groups, not a sandbox. The selected harness owns detached descendants. */
export async function capture(executable: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string; responsePipe?: boolean;
}): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; response: string;
  timedOut: boolean; cancelled: boolean; overflow: boolean; runtimeMs: number }> {
  if (process.platform === 'win32') throw new Error('POSIX process groups are required');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('invalid timeout');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, detached: true,
      stdio: ['pipe', 'pipe', 'pipe', ...(options.responsePipe ? ['pipe' as const] : [])] });
    const chunks: Buffer[][] = [[], [], []]; const sizes = [0, 0, 0];
    let timedOut = false; let cancelled = false; let overflow = false; let terminating = false;
    let closed: { code: number | null; signal: string | null } | null = null; let settled = false;
    let escalation: NodeJS.Timeout | undefined; let cleanup: NodeJS.Timeout | undefined;
    const signal = (value: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, value); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } } };
    const alive = () => { if (!child.pid) return false; try { process.kill(-child.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
    const detach = () => { clearTimeout(timer); clearTimeout(escalation); clearInterval(cleanup); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); };
    const fail = (error: unknown) => { if (settled) return; settled = true; detach(); reject(error); };
    const finish = () => {
      if (settled || !closed || terminating && alive()) return;
      settled = true; detach();
      resolve({ ...closed, stdout: Buffer.concat(chunks[0]!).toString(), stderr: Buffer.concat(chunks[1]!).toString(),
        response: Buffer.concat(chunks[2]!).toString(), timedOut, cancelled, overflow, runtimeMs: Date.now() - started });
    };
    const terminate = () => {
      if (terminating || settled) return; terminating = true;
      try { signal('SIGTERM'); } catch (error) { fail(error); return; }
      escalation = setTimeout(() => {
        try { signal('SIGKILL'); } catch (error) { fail(error); return; }
        const deadline = Date.now() + 3000;
        cleanup = setInterval(() => {
          try { finish(); if (!settled && Date.now() >= deadline) fail(new Error('owned process group settlement could not be confirmed')); }
          catch (error) { fail(error); }
        }, 20);
      }, 500);
    };
    const cancel = () => { cancelled = true; terminate(); };
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
    [child.stdout, child.stderr, child.stdio[3]].forEach((stream, index) => {
      stream?.on('data', (raw: Buffer) => {
        const chunk = Buffer.from(raw); const remaining = Math.max(0, 8 * 1024 * 1024 - sizes[index]!);
        chunks[index]!.push(chunk.subarray(0, remaining)); sizes[index]! += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) { overflow = true; terminate(); }
      });
    });
    child.once('error', fail);
    // A child may exit without reading stdin. Never turn EPIPE into an unhandled exception.
    child.stdin!.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') { terminate(); } });
    child.stdin!.end(options.stdin ?? '');
    child.once('close', (code, signalName) => {
      closed = { code, signal: signalName };
      try { if (alive() && !terminating) terminate(); finish(); } catch (error) { fail(error); }
    });
  });
}
