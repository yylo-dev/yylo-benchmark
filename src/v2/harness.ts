
import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalHash, canonicalJson, type JsonValue } from '../contracts/canonical.js';
import { CostEvidenceSchema, JunoExecutionEnvelopeV1Schema, type CostEvidence } from '../contracts/schemas.js';
import { runCapturedProcess } from './process.js';

export const HARNESS_INTENT_SCHEMA_VERSION = 'yylo_benchmark_harness_intent.v2' as const;
export const HARNESS_TERMINAL_SCHEMA_VERSION = 'yylo_benchmark_harness_terminal.v2' as const;

export interface HarnessProbeResult { readonly ready: boolean; readonly reason?: string }
export interface HarnessPrepareResult { readonly prepared: boolean; readonly reason?: string }
export interface HarnessProcessIdentity { readonly pid: number | null; readonly command: readonly string[] }
export interface HarnessArtifact { readonly role: string; readonly sha256: `sha256:${string}`; readonly size: number }

export interface HarnessTerminalInput {
  readonly status: 'success' | 'failure' | 'timeout' | 'cancelled' | 'invalid';
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly session_id: string | null;
  readonly resolved_provider: string | null;
  readonly resolved_model: string | null;
  readonly observed_provider: string | null;
  readonly observed_model: string | null;
  readonly harness_version: string | null;
  readonly started_at: string;
  readonly ended_at: string;
  readonly runtime_ms: number;
  readonly cost: CostEvidence;
  readonly process: HarnessProcessIdentity;
  readonly artifacts: readonly HarnessArtifact[];
  readonly raw_output?: string;
}

const MEASURED_PROCESS_FAILURE = Symbol('yylo.benchmark.measured_process_failure');

/** Attach adapter-owned process truth outside the JSON command-harness namespace. */
export function withMeasuredProcessFailure(input: HarnessTerminalInput): HarnessTerminalInput {
  Object.defineProperty(input, MEASURED_PROCESS_FAILURE, { value: true, enumerable: false, configurable: false });
  return input;
}

export interface HarnessRequest {
  readonly attemptId: `sha256:${string}`;
  readonly requestedModel: string;
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly invocation?: JsonValue;
  readonly resumeToken?: string;
  /** Per-operation bound; adapters must prefer it over their profile default. */
  readonly timeoutMs?: number;
  /** Host paths that the candidate process is forbidden to read or write. */
  readonly deniedPaths?: readonly string[];
}

export type HarnessReconcileResult =
  | { readonly state: 'terminal'; readonly terminal: HarnessTerminalInput }
  | { readonly state: 'resume'; readonly resumeToken: string }
  | { readonly state: 'ambiguous'; readonly reason: string };

/** Versioned provider-agnostic adapter protocol. Model selectors remain opaque strings. */
export interface HarnessAdapter {
  readonly profileId: string;
  readonly version: string;
  probe(request: HarnessRequest): Promise<HarnessProbeResult>;
  prepare(request: HarnessRequest): Promise<HarnessPrepareResult>;
  run(request: HarnessRequest): Promise<HarnessTerminalInput>;
  reconcile(request: HarnessRequest): Promise<HarnessReconcileResult>;
}

interface HarnessIntentV2 {
  readonly schema_version: typeof HARNESS_INTENT_SCHEMA_VERSION;
  readonly attempt_id: `sha256:${string}`;
  readonly requested_model: string;
  readonly harness_profile: string;
  readonly harness_version: string;
  readonly cwd_hash: `sha256:${string}`;
  readonly invocation_hash: `sha256:${string}`;
  readonly created_at: string;
  readonly intent_hash: `sha256:${string}`;
}

export interface HarnessDiagnostic { readonly code: string; readonly message: string }
export interface HarnessTerminalV2 {
  readonly schema_version: typeof HARNESS_TERMINAL_SCHEMA_VERSION;
  readonly attempt_id: `sha256:${string}`;
  readonly requested_model: string;
  readonly harness_profile: string;
  readonly harness_version: string;
  readonly observed_harness_version: string | null;
  readonly terminal_status: HarnessTerminalInput['status'] | 'ambiguous';
  readonly recovery: 'not_needed' | 'reconciled' | 'resumed' | 'manual';
  readonly validity: 'valid' | 'invalid';
  readonly diagnostics: readonly HarnessDiagnostic[];
  readonly session_id: string | null;
  readonly resolved_provider: string | null;
  readonly resolved_model: string | null;
  readonly observed_provider: string | null;
  readonly observed_model: string | null;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly runtime_ms: number | null;
  readonly cost: CostEvidence;
  readonly process: HarnessProcessIdentity | null;
  readonly artifacts: readonly HarnessArtifact[];
  readonly raw_output: string | null;
  readonly intent_hash: `sha256:${string}`;
  readonly workspace_manifest_hash: `sha256:${string}`;
  readonly terminal_hash: `sha256:${string}`;
}

export interface RunHarnessAttemptOptions extends HarnessRequest {
  readonly intentRoot: string;
  readonly adapter: HarnessAdapter;
  /** Runs after the candidate process ends and before terminal publication. */
  readonly publishWorkspaceResult?: () => Promise<`sha256:${string}`>;
  readonly now?: () => Date;
}

function attemptDigest(attemptId: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(attemptId)) throw new Error('attempt ID must be sha256:<lowercase hex>');
  return attemptId.slice(7);
}

function paths(intentRoot: string, attemptId: string): { intent: string; terminal: string } {
  const digest = attemptDigest(attemptId);
  return { intent: path.join(intentRoot, `${digest}.intent.json`), terminal: path.join(intentRoot, `${digest}.terminal.json`) };
}

async function privateRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
}

async function atomicJson(destination: string, value: unknown): Promise<void> {
  const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

function makeIntent(input: {
  attemptId: `sha256:${string}`; requestedModel: string; harnessProfile: string; harnessVersion: string; cwd: string; invocation?: JsonValue; createdAt: string;
}): HarnessIntentV2 {
  if (!input.requestedModel.trim()) throw new Error('requested model selector must be non-empty');
  const core = {
    schema_version: HARNESS_INTENT_SCHEMA_VERSION,
    attempt_id: input.attemptId,
    requested_model: input.requestedModel,
    harness_profile: input.harnessProfile,
    harness_version: input.harnessVersion,
    cwd_hash: canonicalHash(path.resolve(input.cwd)),
    invocation_hash: canonicalHash(input.invocation ?? null),
    created_at: input.createdAt,
  } as const;
  return Object.freeze({ ...core, intent_hash: canonicalHash(core) });
}

async function loadJson(file: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as unknown; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function parseIntent(value: unknown, request: HarnessRequest, adapter: HarnessAdapter): HarnessIntentV2 {
  if (typeof value !== 'object' || value === null) throw new Error('harness intent is malformed');
  const intent = value as Partial<HarnessIntentV2>;
  const { intent_hash: claimed, ...core } = intent;
  if (intent.schema_version !== HARNESS_INTENT_SCHEMA_VERSION || intent.attempt_id !== request.attemptId
      || intent.requested_model !== request.requestedModel || intent.harness_profile !== adapter.profileId
      || intent.harness_version !== adapter.version || intent.cwd_hash !== canonicalHash(path.resolve(request.cwd))
      || intent.invocation_hash !== canonicalHash(request.invocation ?? null)
      || claimed !== canonicalHash(core)) throw new Error('harness intent identity or integrity mismatch');
  return intent as HarnessIntentV2;
}

interface NormalizedHarnessTerminalInput {
  readonly status: HarnessTerminalInput['status'];
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly session_id: string | null;
  readonly resolved_provider: string | null;
  readonly resolved_model: string | null;
  readonly observed_provider: string | null;
  readonly observed_model: string | null;
  readonly harness_version: string | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly runtime_ms: number | null;
  readonly cost: CostEvidence;
  readonly process: HarnessProcessIdentity | null;
  readonly artifacts: readonly HarnessArtifact[];
  readonly raw_output: string | null;
}

function normalizeTerminalInput(value: unknown): { readonly input: NormalizedHarnessTerminalInput; readonly diagnostics: HarnessDiagnostic[] } {
  const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const observed: HarnessDiagnostic[] = [];
  const malformed = (field: string, expected: string): void => {
    observed.push({ code: 'malformed_protocol_field', message: `command harness field ${field} must be ${expected}` });
  };
  const nullableString = (field: string): string | null => {
    const candidate = source[field];
    if (candidate === null) return null;
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
    malformed(field, 'a non-empty string or null'); return null;
  };
  const nullableInteger = (field: string): number | null => {
    const candidate = source[field];
    if (candidate === null) return null;
    if (Number.isSafeInteger(candidate)) return candidate as number;
    malformed(field, 'a safe integer or null'); return null;
  };
  const nullableTimestamp = (field: string): string | null => {
    const candidate = source[field];
    if (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate))) return candidate;
    malformed(field, 'an ISO timestamp'); return null;
  };
  const supportedFields = new Set(['status', 'exit_code', 'signal', 'session_id', 'resolved_provider', 'resolved_model',
    'observed_provider', 'observed_model', 'harness_version', 'started_at', 'ended_at', 'runtime_ms', 'cost', 'process', 'artifacts', 'raw_output']);
  for (const field of Object.keys(source)) if (!supportedFields.has(field)) malformed(field, 'a supported command-harness field');
  const statuses = new Set(['success', 'failure', 'timeout', 'cancelled', 'invalid']);
  const emittedStatus = typeof source['status'] === 'string' && statuses.has(source['status'])
    ? source['status'] as HarnessTerminalInput['status']
    : (malformed('status', 'a supported terminal status'), 'invalid' as const);
  const status = (source as Record<PropertyKey, unknown>)[MEASURED_PROCESS_FAILURE] === true ? 'failure' as const : emittedStatus;
  const runtime = source['runtime_ms'];
  const runtime_ms = Number.isSafeInteger(runtime) && (runtime as number) >= 0
    ? runtime as number : (malformed('runtime_ms', 'a non-negative safe integer'), null);
  const costResult = CostEvidenceSchema.safeParse(source['cost']);
  if (!costResult.success) malformed('cost', 'valid cost evidence');
  const processValue = source['process'];
  let processIdentity: HarnessProcessIdentity | null = null;
  if (typeof processValue === 'object' && processValue !== null && !Array.isArray(processValue)) {
    const record = processValue as Record<string, unknown>;
    const pid = record['pid']; const command = record['command'];
    if ((pid === null || Number.isSafeInteger(pid)) && Array.isArray(command) && command.every((item) => typeof item === 'string')) {
      processIdentity = { pid: pid as number | null, command: command as string[] };
    } else malformed('process', 'a valid process identity');
  } else malformed('process', 'a valid process identity');
  const artifactsValue = source['artifacts'];
  const artifacts: HarnessArtifact[] = [];
  if (Array.isArray(artifactsValue) && artifactsValue.every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return Object.keys(record).length === 3 && ['role', 'sha256', 'size'].every((field) => Object.hasOwn(record, field))
      && typeof record['role'] === 'string' && record['role'].trim() !== ''
      && typeof record['sha256'] === 'string' && /^sha256:[0-9a-f]{64}$/u.test(record['sha256'])
      && Number.isSafeInteger(record['size']) && (record['size'] as number) >= 0;
  })) artifacts.push(...artifactsValue as HarnessArtifact[]);
  else malformed('artifacts', 'an array of valid artifact records');
  const raw = source['raw_output'];
  if (raw !== undefined && raw !== null && typeof raw !== 'string') malformed('raw_output', 'a string or null');
  return { input: {
    status, exit_code: nullableInteger('exit_code'), signal: nullableString('signal'), session_id: nullableString('session_id'),
    resolved_provider: nullableString('resolved_provider'), resolved_model: nullableString('resolved_model'),
    observed_provider: nullableString('observed_provider'), observed_model: nullableString('observed_model'),
    harness_version: nullableString('harness_version'), started_at: nullableTimestamp('started_at'), ended_at: nullableTimestamp('ended_at'),
    runtime_ms, cost: costResult.success ? costResult.data : { completeness: 'unavailable', usd: null }, process: processIdentity,
    artifacts, raw_output: typeof raw === 'string' ? raw : null,
  }, diagnostics: observed };
}

function diagnostics(input: NormalizedHarnessTerminalInput): HarnessDiagnostic[] {
  const result: HarnessDiagnostic[] = [];
  if (input.resolved_provider === null || input.resolved_model === null || input.observed_provider === null || input.observed_model === null || input.harness_version === null) {
    result.push({ code: 'missing_identity', message: 'resolved/observed harness identity is incomplete' });
  } else if (input.resolved_provider !== input.observed_provider || input.resolved_model !== input.observed_model) {
    result.push({ code: 'identity_mismatch', message: 'resolved and observed provider/model identities differ' });
  }
  if (input.session_id === null) result.push({ code: 'missing_session', message: 'harness did not report a candidate session ID' });
  if (input.status === 'timeout') result.push({ code: 'timeout', message: 'candidate reached its timeout' });
  if (input.signal !== null) result.push({ code: 'signal', message: `candidate terminated with ${input.signal}` });
  if (input.runtime_ms === null || input.started_at === null || input.ended_at === null
      || Date.parse(input.ended_at) < Date.parse(input.started_at)) {
    result.push({ code: 'invalid_timing', message: 'candidate timing evidence is malformed' });
  }
  return result;
}

function terminalFromInput(intent: HarnessIntentV2, adapter: HarnessAdapter, input: HarnessTerminalInput, recovery: HarnessTerminalV2['recovery'], workspaceManifestHash: `sha256:${string}`): HarnessTerminalV2 {
  const normalized = normalizeTerminalInput(input);
  const observedDiagnostics = [...normalized.diagnostics, ...diagnostics(normalized.input)];
  const invalidCodes = new Set(['malformed_protocol_field', 'missing_identity', 'identity_mismatch', 'missing_session', 'invalid_timing']);
  const terminalInput = normalized.input;
  const core = {
    schema_version: HARNESS_TERMINAL_SCHEMA_VERSION,
    attempt_id: intent.attempt_id,
    requested_model: intent.requested_model,
    harness_profile: adapter.profileId,
    harness_version: adapter.version,
    observed_harness_version: terminalInput.harness_version,
    terminal_status: terminalInput.status,
    recovery,
    validity: observedDiagnostics.some((item) => invalidCodes.has(item.code)) ? 'invalid' as const : 'valid' as const,
    diagnostics: observedDiagnostics,
    session_id: terminalInput.session_id,
    resolved_provider: terminalInput.resolved_provider,
    resolved_model: terminalInput.resolved_model,
    observed_provider: terminalInput.observed_provider,
    observed_model: terminalInput.observed_model,
    exit_code: terminalInput.exit_code,
    signal: terminalInput.signal,
    started_at: terminalInput.started_at,
    ended_at: terminalInput.ended_at,
    runtime_ms: terminalInput.runtime_ms,
    cost: terminalInput.cost,
    process: terminalInput.process,
    artifacts: terminalInput.artifacts,
    raw_output: terminalInput.raw_output,
    intent_hash: intent.intent_hash,
    workspace_manifest_hash: workspaceManifestHash,
  } as const;
  return Object.freeze({ ...core, terminal_hash: canonicalHash(core) });
}

function ambiguousTerminal(intent: HarnessIntentV2, adapter: HarnessAdapter, reason: string, workspaceManifestHash: `sha256:${string}`): HarnessTerminalV2 {
  const core = {
    schema_version: HARNESS_TERMINAL_SCHEMA_VERSION,
    attempt_id: intent.attempt_id,
    requested_model: intent.requested_model,
    harness_profile: adapter.profileId,
    harness_version: adapter.version,
    observed_harness_version: null,
    terminal_status: 'ambiguous' as const,
    recovery: 'manual' as const,
    validity: 'invalid' as const,
    diagnostics: [{ code: 'ambiguous_effect', message: reason }],
    session_id: null, resolved_provider: null, resolved_model: null, observed_provider: null, observed_model: null,
    exit_code: null, signal: null, started_at: null, ended_at: null, runtime_ms: null,
    cost: { completeness: 'unavailable' as const, usd: null }, process: null, artifacts: [], raw_output: null,
    intent_hash: intent.intent_hash,
    workspace_manifest_hash: workspaceManifestHash,
  } as const;
  return Object.freeze({ ...core, terminal_hash: canonicalHash(core) });
}

function parseTerminal(value: unknown, intent: HarnessIntentV2): HarnessTerminalV2 {
  if (typeof value !== 'object' || value === null) throw new Error('harness terminal is malformed');
  const terminal = value as Partial<HarnessTerminalV2>;
  const { terminal_hash: claimed, ...core } = terminal;
  if (terminal.schema_version !== HARNESS_TERMINAL_SCHEMA_VERSION || terminal.attempt_id !== intent.attempt_id
      || terminal.requested_model !== intent.requested_model || terminal.intent_hash !== intent.intent_hash
      || !/^sha256:[0-9a-f]{64}$/u.test(terminal.workspace_manifest_hash ?? '')
      || claimed !== canonicalHash(core)) throw new Error('harness terminal identity or integrity mismatch');
  CostEvidenceSchema.parse(terminal.cost);
  return Object.freeze(terminal as HarnessTerminalV2);
}

export async function loadHarnessTerminalForVerification(options: RunHarnessAttemptOptions): Promise<HarnessTerminalV2> {
  const files = paths(options.intentRoot, options.attemptId);
  const intentValue = await loadJson(files.intent); const terminalValue = await loadJson(files.terminal);
  if (intentValue === null || terminalValue === null) throw new Error('retained harness intent/terminal is missing');
  const intent = parseIntent(intentValue, options, options.adapter);
  return parseTerminal(terminalValue, intent);
}

/** Test/recovery seam: persist externally-effective intent without fabricating a terminal. */
export async function writeHarnessIntentForRecovery(input: {
  readonly attemptId: `sha256:${string}`; readonly requestedModel: string; readonly intentRoot: string;
  readonly harnessProfile: string; readonly harnessVersion: string; readonly cwd: string; readonly invocation?: JsonValue; readonly createdAt?: string;
}): Promise<void> {
  await privateRoot(input.intentRoot);
  const file = paths(input.intentRoot, input.attemptId).intent;
  const intent = makeIntent({ ...input, createdAt: input.createdAt ?? new Date().toISOString() });
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(`${canonicalJson(intent)}\n`); await handle.sync(); } finally { await handle.close(); }
}

/** Persist intent before dispatch, then run or reconcile exactly once. */
export async function runHarnessAttempt(options: RunHarnessAttemptOptions): Promise<HarnessTerminalV2> {
  await privateRoot(options.intentRoot);
  const publishWorkspaceResult = options.publishWorkspaceResult ?? (() => Promise.resolve(canonicalHash({ cwd: path.resolve(options.cwd) })));
  const files = paths(options.intentRoot, options.attemptId);
  const existingIntent = await loadJson(files.intent);
  let intent: HarnessIntentV2;
  let recovery: HarnessTerminalV2['recovery'] = 'not_needed';
  let terminalInput: HarnessTerminalInput;
  if (existingIntent === null) {
    intent = makeIntent({ attemptId: options.attemptId, requestedModel: options.requestedModel, harnessProfile: options.adapter.profileId,
      harnessVersion: options.adapter.version, cwd: options.cwd,
      ...(options.invocation === undefined ? {} : { invocation: options.invocation }),
      createdAt: (options.now ?? (() => new Date()))().toISOString() });
    await atomicJson(files.intent, intent);
  } else {
    intent = parseIntent(existingIntent, options, options.adapter);
    const retained = await loadJson(files.terminal);
    if (retained !== null) return parseTerminal(retained, intent);
    const reconciled = await options.adapter.reconcile(options);
    if (reconciled.state === 'ambiguous') {
      const workspaceManifestHash = await publishWorkspaceResult();
      const ambiguous = ambiguousTerminal(intent, options.adapter, reconciled.reason, workspaceManifestHash);
      await atomicJson(files.terminal, ambiguous);
      return ambiguous;
    }
    if (reconciled.state === 'terminal') {
      terminalInput = reconciled.terminal;
      recovery = 'reconciled';
      const workspaceManifestHash = await publishWorkspaceResult();
      const terminal = terminalFromInput(intent, options.adapter, terminalInput, recovery, workspaceManifestHash);
      await atomicJson(files.terminal, terminal);
      return terminal;
    }
    recovery = 'resumed';
    const resumedRequest: HarnessRequest = { ...options, resumeToken: reconciled.resumeToken };
    terminalInput = await options.adapter.run(resumedRequest);
    const workspaceManifestHash = await publishWorkspaceResult();
    const terminal = terminalFromInput(intent, options.adapter, terminalInput, recovery, workspaceManifestHash);
    await atomicJson(files.terminal, terminal);
    return terminal;
  }

  const probe = await options.adapter.probe(options);
  if (!probe.ready) throw new Error(`harness is not ready: ${probe.reason ?? 'unspecified reason'}`);
  const prepared = await options.adapter.prepare(options);
  if (!prepared.prepared) throw new Error(`harness preparation failed: ${prepared.reason ?? 'unspecified reason'}`);
  terminalInput = await options.adapter.run(options);
  const workspaceManifestHash = await publishWorkspaceResult();
  const terminal = terminalFromInput(intent, options.adapter, terminalInput, recovery, workspaceManifestHash);
  await atomicJson(files.terminal, terminal);
  return terminal;
}

export interface YyloPiHarnessOptions {
  readonly profileId?: string;
  readonly executable?: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly extraArgs?: readonly string[];
}

/** Built-in YYLO Pi adapter. It has no provider/model allowlist and requires a structured JSON envelope. */
export class YyloPiHarnessAdapter implements HarnessAdapter {
  public readonly profileId: string;
  public readonly version = '2';
  readonly #executable: string;
  readonly #prompt: string;
  readonly #timeoutMs: number;
  readonly #extraArgs: readonly string[];
  public constructor(options: YyloPiHarnessOptions) {
    this.profileId = options.profileId ?? 'yylo-pi'; this.#executable = options.executable ?? 'yy'; this.#prompt = options.prompt;
    this.#timeoutMs = options.timeoutMs ?? 30 * 60 * 1000; this.#extraArgs = options.extraArgs ?? [];
  }
  public async probe(): Promise<HarnessProbeResult> { return { ready: true }; }
  public async prepare(): Promise<HarnessPrepareResult> { return { prepared: true }; }
  public async reconcile(): Promise<HarnessReconcileResult> { return { state: 'ambiguous', reason: 'YYLO Pi effect has no retained terminal; operator reconciliation is required' }; }
  public async run(request: HarnessRequest): Promise<HarnessTerminalInput> {
    const started = new Date();
    const prompt = promptForInvocation(request.invocation, this.#prompt);
    const args = ['--execution-envelope', 'pi', '--model', request.requestedModel, ...this.#extraArgs, '-p', prompt];
    const result = await runCapturedProcess(this.#executable, args, { cwd: request.cwd,
      environment: { ...request.environment, YYLO_EXECUTION_EVIDENCE_FD: '3' }, timeoutMs: request.timeoutMs ?? this.#timeoutMs, extraPipeCount: 1,
      ...(request.deniedPaths === undefined ? {} : { deniedPaths: request.deniedPaths }) });
    const ended = new Date();
    // Only the invocation-owned stdout envelope is identity/cost evidence.
    // The response pipe and stderr can contain arbitrary assistant text. Accept
    // public command/error metadata, but never interpret it as identity.
    let envelope: Record<string, unknown> = {};
    try {
      const parsed = JunoExecutionEnvelopeV1Schema.strip().safeParse(JSON.parse(result.stdout.trim()));
      if (parsed.success) envelope = parsed.data;
    } catch { /* absent/incomplete envelope: keep identity and usage unknown */ }
    const cost = CostEvidenceSchema.safeParse(envelope['cost']);
    const provider = typeof envelope['provider'] === 'string' ? envelope['provider'] : null;
    const observedModel = typeof envelope['model'] === 'string' ? envelope['model'] : null;
    const exactModel = provider === null || observedModel === null ? null
      : observedModel.startsWith(`${provider}/`) ? observedModel : `${provider}/${observedModel}`;
    const envelopeStatus = envelope['status'];
    const status = result.timedOut ? 'timeout' as const : result.signal !== null ? 'failure' as const
      : result.code !== 0 ? 'failure' as const
        : envelopeStatus === 'success' ? 'success' as const
          : envelopeStatus === 'timeout' ? 'timeout' as const
            : envelopeStatus === 'cancelled' ? 'cancelled' as const : 'failure' as const;
    return {
      status,
      exit_code: result.code, signal: result.signal,
      session_id: typeof envelope['session_id'] === 'string' ? envelope['session_id'] : null,
      resolved_provider: provider,
      resolved_model: exactModel,
      observed_provider: provider,
      observed_model: exactModel,
      harness_version: typeof envelope['juno_version'] === 'string' ? envelope['juno_version'] : null,
      started_at: started.toISOString(), ended_at: ended.toISOString(), runtime_ms: ended.getTime() - started.getTime(),
      // Captured usage is a lower bound when the owned invocation timed out,
      // even if it emitted a successful envelope before hanging during teardown.
      cost: cost.success
        ? status === 'timeout' && cost.data.usd !== null ? { completeness: 'partial', usd: cost.data.usd } : cost.data
        : { completeness: 'unavailable', usd: null },
      process: { pid: result.pid, command: [this.#executable, ...args] }, artifacts: [],
      raw_output: result.extra[0] || result.stderr || result.stdout,
    };
  }
}

function promptForInvocation(invocation: JsonValue | undefined, fallback: string): string {
  if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) return fallback;
  if ((invocation['kind'] === 'task' || invocation['kind'] === 'evaluator') && typeof invocation['prompt'] === 'string' && invocation['prompt'].trim()) {
    return invocation['prompt'];
  }
  return fallback;
}
