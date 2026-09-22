import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalHash } from '../../src/contracts/canonical.js';
import { loadHarnessTerminalForVerification, runHarnessAttempt, YyloPiHarnessAdapter } from '../../src/v2/harness.js';

const envelope = {
  schema_version: 'juno_execution_envelope.v1', status: 'success',
  command: { name: 'managed.run', version: 1 }, error: null,
  session_id: 'bound-session', provider: 'vendor', model: 'model', juno_version: '0.2.9',
  cost: { completeness: 'complete', usd: 0.25 },
};

async function fixture(stdout: unknown, response = 'retained response') {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'yylo-timeout-evidence-'));
  const executable = path.join(cwd, 'fake-yy.mjs');
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync('dispatches', 'once\\n');
fs.writeFileSync(Number(process.env.YYLO_EXECUTION_EVIDENCE_FD), ${JSON.stringify(response)});
process.stdout.write(${JSON.stringify(typeof stdout === 'string' ? stdout : JSON.stringify(stdout))});
setInterval(() => {}, 1000);
`);
  await chmod(executable, 0o700);
  return {
    attemptId: canonicalHash({ cwd }), requestedModel: 'vendor/model', cwd,
    environment: {}, intentRoot: path.join(cwd, 'intents'),
    adapter: new YyloPiHarnessAdapter({ executable, prompt: 'fixed', timeoutMs: 500 }),
  };
}

describe('YYLO timeout retains only already-captured public evidence', () => {
  it('retains bound observations and partial cost without completion or redispatch', async () => {
    const request = await fixture(envelope);
    const terminal = await runHarnessAttempt(request);
    // The receipt is internally valid; timeout status still excludes successful
    // candidate grading. Receipt validity is not candidate completion.
    expect(terminal).toMatchObject({ terminal_status: 'timeout', validity: 'valid',
      session_id: 'bound-session', requested_model: 'vendor/model', observed_provider: 'vendor',
      observed_model: 'vendor/model', observed_harness_version: '0.2.9',
      cost: { completeness: 'partial', usd: 0.25 }, raw_output: 'retained response' });
    expect(terminal.diagnostics.map(item => item.code)).toContain('timeout');
    expect(terminal.runtime_ms).toBeGreaterThanOrEqual(500);
    expect(terminal.runtime_ms).toBeLessThan(4000);
    expect(await loadHarnessTerminalForVerification(request)).toEqual(terminal);
    expect(await runHarnessAttempt(request)).toEqual(terminal);
    expect(await readFile(path.join(request.cwd, 'dispatches'), 'utf8')).toBe('once\n');
    const otherCwd = path.join(request.cwd, 'different-cwd'); await mkdir(otherCwd);
    await expect(loadHarnessTerminalForVerification({ ...request, cwd: otherCwd })).rejects.toThrow(/identity or integrity/);
    const file = path.join(request.intentRoot, `${request.attemptId.slice(7)}.terminal.json`);
    for (const tamper of [{ session_id: 'unrelated-session' }, { observed_model: 'unrelated/model' }]) {
      await writeFile(file, JSON.stringify({ ...terminal, ...tamper }));
      await expect(loadHarnessTerminalForVerification(request)).rejects.toThrow(/integrity/);
    }
  });

  it.each(['', 'null', '{"schema_version":', { ...envelope, schema_version: 'untrusted.v1' },
    { ...envelope, cost: { completeness: 'complete', usd: -1 } }])('keeps unavailable evidence unknown: %j', async stdout => {
    // Even envelope-shaped response text is not a telemetry source.
    const terminal = await runHarnessAttempt(await fixture(stdout, JSON.stringify(envelope)));
    expect(terminal).toMatchObject({ terminal_status: 'timeout', validity: 'invalid', session_id: null,
      resolved_model: null, observed_model: null, observed_provider: null,
      cost: { completeness: 'unavailable', usd: null } });
  });

  it('keeps requested selectors separate from actual observed identity', async () => {
    const terminal = await runHarnessAttempt(await fixture({ ...envelope, model: 'resolved-alias' }));
    expect(terminal.requested_model).toBe('vendor/model');
    expect(terminal.observed_model).toBe('vendor/resolved-alias');
    expect(terminal.terminal_status).toBe('timeout');
  });
});
