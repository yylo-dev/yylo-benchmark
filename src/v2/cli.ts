import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { canonicalHash, canonicalJson, sha256Hex, type JsonValue } from '../contracts/canonical.js';
import { caseInvocation, compileTaskAttempt, compileWorkflowAttempt, evidenceFromTerminal, executeCaseAttempt, nonModelInputHash, recoverCaseAttempt } from './adapters.js';
import { evaluateAttempt, reevaluateAttempt, type DeterministicEvaluator, type EvaluationComposition, type EvaluatorProfile, type RichEvaluationRecord } from './evaluators.js';
import { loadHarnessTerminalForVerification, withMeasuredProcessFailure, YyloPiHarnessAdapter, type HarnessAdapter, type HarnessRequest, type HarnessReconcileResult, type HarnessTerminalInput } from './harness.js';
import { AttemptEvidenceV2Schema, AttemptPlanV2Schema, EvaluationRecordV2Schema, ReportProvenanceV2Schema, ReportV2Schema, serializeV2, type AttemptEvidenceV2, type AttemptPlanV2 } from './contracts.js';
import { WorkflowRunnerHarnessAdapter } from './adapters.js';
import { doctorAttemptWorkspace, loadAttemptWorkspace } from './workspace.js';
import { runCapturedProcess } from './process.js';
import { deriveCandidateManifest } from '../snapshot/index.js';

export const V2_CLI_SCHEMA_VERSION = 'yylo_benchmark_cli.v2' as const;
export const V2_CONFIG_SCHEMA_VERSION = 'yylo_benchmark_config.v2' as const;
export const V2_EXPERIMENT_PLAN_SCHEMA_VERSION = 'yylo_benchmark_experiment_plan.v2' as const;
const execFileAsync = promisify(execFile);

interface CommandHarnessConfig { readonly kind: 'command'; readonly executable: string; readonly arguments: readonly string[]; readonly timeout_ms: number }
const COMMAND_HARNESS_DIAGNOSTIC_BYTES = 64 * 1024;
const COMMAND_HARNESS_DIAGNOSTIC_TRUNCATED = '\n[command harness diagnostic truncated]\n';

function boundedCommandHarnessDiagnostic(stdout: string, stderr: string): string {
  const bytes = Buffer.from(`${stdout}${stderr}`, 'utf8');
  if (bytes.length <= COMMAND_HARNESS_DIAGNOSTIC_BYTES) return bytes.toString('utf8');
  const suffix = Buffer.from(COMMAND_HARNESS_DIAGNOSTIC_TRUNCATED, 'utf8');
  return `${bytes.subarray(0, COMMAND_HARNESS_DIAGNOSTIC_BYTES - suffix.length).toString('utf8')}${COMMAND_HARNESS_DIAGNOSTIC_TRUNCATED}`;
}
interface PiHarnessConfig { readonly kind: 'yylo_pi'; readonly executable?: string; readonly prompt: string; readonly timeout_ms?: number; readonly arguments?: readonly string[] }
interface WorkflowHarnessConfig { readonly kind: 'workflow_runner'; readonly executable: string; readonly timeout_ms?: number; readonly arguments?: readonly string[] }
type HarnessConfig = CommandHarnessConfig | PiHarnessConfig | WorkflowHarnessConfig;

interface DeterministicEvaluatorConfig {
  readonly kind: 'deterministic'; readonly profile_version: string; readonly generation: number; readonly required: boolean;
  readonly correctness_gate?: boolean; readonly command: readonly string[];
}
interface JudgeEvaluatorConfig {
  readonly kind: 'llm_judge'; readonly profile_version: string; readonly generation: number; readonly required: boolean;
  readonly harness_profile: string; readonly requested_model: string; readonly system_prompt: string; readonly prompt_template: string; readonly rubric: string;
  readonly evidence_fields: readonly string[]; readonly max_evidence_bytes: number; readonly identity_visibility: 'blinded' | 'visible';
  readonly mode: 'single' | 'reference' | 'pairwise'; readonly timeout_ms: number; readonly repetitions: number;
  readonly aggregation: 'majority' | 'all' | 'any'; readonly parser: 'strict_json' | 'legacy_verdict'; readonly settings: Readonly<Record<string, JsonValue>>;
  readonly reference?: JsonValue;
}
type EvaluatorConfig = DeterministicEvaluatorConfig | JudgeEvaluatorConfig;

export interface V2Config {
  readonly schema_version: typeof V2_CONFIG_SCHEMA_VERSION;
  readonly yylo_version: string;
  readonly workspace: { readonly attempts_root: string; readonly registry_root: string };
  readonly default_candidate_harness: string;
  readonly harnesses: Readonly<Record<string, HarnessConfig>>;
  readonly default_evaluators: readonly string[];
  readonly evaluators: Readonly<Record<string, EvaluatorConfig>>;
}

export interface V2ExperimentPlan {
  readonly schema_version: typeof V2_EXPERIMENT_PLAN_SCHEMA_VERSION;
  readonly yylo_version: string;
  readonly benchmark_version: string;
  readonly experiment_id: `sha256:${string}`;
  readonly plan_hash: `sha256:${string}`;
  readonly config_hash: `sha256:${string}`;
  readonly config_path: string;
  readonly snapshot_exclusions: readonly string[];
  readonly source_repository: string;
  readonly source_commit: string;
  readonly source_tree: string;
  readonly comparison_kind: 'model_only' | 'agent_system';
  readonly case_kind: 'task' | 'workflow';
  readonly case_path: string;
  readonly evaluator_profiles: readonly EvaluatorProfile[];
  readonly evaluator_catalog: readonly EvaluatorProfile[];
  readonly attempts: readonly AttemptPlanV2[];
}

function assertPlannedAttemptCardinality(plan: Pick<V2ExperimentPlan, 'attempts'>, operation: string): void {
  if (plan.attempts.length === 0) throw new Error(`${operation}: experiment plan must contain at least one attempt`);
  const identities = new Set<string>();
  for (const attempt of plan.attempts) {
    if (identities.has(attempt.attempt_id)) throw new Error(`${operation}: duplicate planned attempt identity: ${attempt.attempt_id}`);
    identities.add(attempt.attempt_id);
  }
}

function assertEvaluatorProfileUniqueness(profiles: readonly EvaluatorProfile[], operation: string): void {
  const identities = new Set<string>();
  for (const profile of profiles) {
    const identity = `${profile.profileId}\0${profile.generation}`;
    if (identities.has(identity)) throw new Error(`${operation}: evaluator profile/generation must be unique: ${profile.profileId}/${profile.generation}`);
    identities.add(identity);
  }
}

function verifyExperimentIdentity(plan: V2ExperimentPlan): void {
  assertEvaluatorProfileUniqueness(plan.evaluator_profiles, 'experiment plan');
  const first = plan.attempts[0]!; const models: string[] = [];
  for (const attempt of plan.attempts) if (!models.includes(attempt.requested_model)) models.push(attempt.requested_model);
  const attemptsPerModel = plan.attempts.filter((attempt) => attempt.requested_model === models[0]).length;
  if (attemptsPerModel < 1 || plan.attempts.length !== models.length * attemptsPerModel) throw new Error('experiment attempt matrix is incomplete');
  const expectedEvaluators = plan.evaluator_profiles.map((profile) => ({ profile_id: profile.profileId, profile_version: profile.profileVersion,
    generation: profile.generation, kind: profile.kind, required: profile.required, config_hash: evaluatorProfileHash(profile) }));
  const baselineNonModel = nonModelInputHash(first);
  for (const model of models) {
    const attempts = plan.attempts.filter((attempt) => attempt.requested_model === model);
    if (attempts.some((attempt, index) => attempt.attempt_index !== index + 1 || attempt.case.case_id !== plan.case_path
        || attempt.case.kind !== plan.case_kind || attempt.harness_profile !== first.harness_profile
        || canonicalHash(attempt.evaluators) !== canonicalHash(expectedEvaluators) || nonModelInputHash(attempt) !== baselineNonModel)) {
      throw new Error('experiment attempt matrix/evaluator linkage is invalid');
    }
  }
  const normalized = object(first.case.normalized_input, 'planned normalized input');
  const controlled = plan.case_kind === 'workflow' && typeof normalized['controlled_model_variable'] === 'string'
    ? normalized['controlled_model_variable'] : null;
  const variables = controlled === null ? first.variables : Object.fromEntries(Object.entries(first.variables).filter(([key]) => key !== controlled));
  if (controlled !== null && plan.attempts.some((attempt) => attempt.variables[controlled] !== attempt.requested_model)) {
    throw new Error('experiment controlled-model matrix is invalid');
  }
  const expected = canonicalHash({ kind: plan.case_kind, case_path: plan.case_path, case_sha256: first.case.case_version, commit: plan.source_commit,
    models, attempts: attemptsPerModel, harness: first.harness_profile, evaluators: plan.evaluator_profiles, config_hash: plan.config_hash,
    variables, controlled_model_variable: controlled });
  if (plan.experiment_id !== expected) throw new Error('experiment identity derivation failed');
}

interface PersistedAttempt {
  readonly schema_version: 'yylo_benchmark_attempt_state.v2';
  readonly plan_hash: `sha256:${string}`;
  readonly attempt_id: string;
  readonly terminal_hash: `sha256:${string}`;
  readonly workspace_manifest_hash: `sha256:${string}`;
  readonly evidence: AttemptEvidenceV2;
  readonly evaluation_records: readonly RichEvaluationRecord[];
  readonly quality: 'resolved' | 'unresolved' | 'unknown';
  readonly validity: 'valid' | 'invalid';
  readonly state_hash: `sha256:${string}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unknown fields: ${extras.join(', ')}`);
}
function validateEvaluatorProfile(value: unknown, label: string): void {
  const profile = object(value, label); const kind = profile['kind'];
  const base = ['profileId', 'profileVersion', 'generation', 'kind', 'required'];
  if (typeof profile['profileId'] !== 'string' || !profile['profileId'].trim() || typeof profile['profileVersion'] !== 'string'
      || !profile['profileVersion'].trim() || !Number.isSafeInteger(profile['generation']) || (profile['generation'] as number) < 1
      || typeof profile['required'] !== 'boolean') throw new Error(`${label} identity is invalid`);
  if (kind === 'deterministic') {
    exactKeys(profile, [...base, 'correctnessGate'], label);
    if (profile['correctnessGate'] !== undefined && typeof profile['correctnessGate'] !== 'boolean') throw new Error(`${label}.correctnessGate is invalid`);
  } else if (kind === 'imported' || kind === 'human') exactKeys(profile, base, label);
  else if (kind === 'llm_judge') {
    exactKeys(profile, [...base, 'harnessProfile', 'requestedModel', 'systemPrompt', 'promptTemplate', 'rubric', 'evidenceFields', 'maxEvidenceBytes',
      'identityVisibility', 'mode', 'timeoutMs', 'repetitions', 'aggregation', 'parser', 'settings', 'reference'], label);
    for (const key of ['harnessProfile', 'requestedModel']) if (typeof profile[key] !== 'string' || !(profile[key] as string).trim()) throw new Error(`${label}.${key} is invalid`);
    for (const key of ['systemPrompt', 'promptTemplate', 'rubric', 'parser', 'settings']) object(profile[key], `${label}.${key}`);
    if (!Array.isArray(profile['evidenceFields']) || !Number.isSafeInteger(profile['maxEvidenceBytes']) || !Number.isSafeInteger(profile['timeoutMs'])
        || !Number.isSafeInteger(profile['repetitions'])) throw new Error(`${label} judge fields are invalid`);
  } else throw new Error(`${label}.kind is invalid`);
}
function string(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty`); return value; }
function integer(value: unknown, label: string, minimum = 1): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`); return value as number; }
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) throw new Error(`${label} must be an array of non-empty strings`);
  return [...value] as string[];
}
function safeRelative(value: string, label: string): string {
  if (path.isAbsolute(value) || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`${label} must be repository-relative`);
  return value;
}

export async function loadV2Config(cwd: string, configPath?: string): Promise<{ config: V2Config; path: string; hash: `sha256:${string}` }> {
  const pathname = path.resolve(cwd, configPath ?? 'yylo-benchmark.config.json');
  let bytes: Buffer;
  try { bytes = await readFile(pathname); } catch { throw new Error(`v2 config is missing: ${pathname}`); }
  let parsed: unknown; try { parsed = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new Error('v2 config is malformed JSON'); }
  const root = object(parsed, 'v2 config');
  if (root['schema_version'] !== V2_CONFIG_SCHEMA_VERSION) {
    if (root['schema_version'] === 'juno_benchmark_config.v1') {
      throw new Error('this is a governed-workflow configuration, not an isolated-v2 configuration; use `yylo-benchmark workflow ... --config <path>` or `yylo-benchmark workflow migrate-config --input <path>`. Do not change schema_version alone');
    }
    throw new Error(`isolated-v2 config requires schema_version ${V2_CONFIG_SCHEMA_VERSION}; inspect it with \`yylo-benchmark workflow migrate-config --input <path>\`. No file was changed`);
  }
  const workspaceInput = object(root['workspace'], 'workspace');
  const harnessInput = object(root['harnesses'], 'harnesses'); const harnesses: Record<string, HarnessConfig> = {};
  for (const [id, raw] of Object.entries(harnessInput)) {
    const item = object(raw, `harness ${id}`); const kind = item['kind'];
    if (kind === 'command') harnesses[id] = { kind, executable: string(item['executable'], `${id}.executable`), arguments: stringArray(item['arguments'] ?? [], `${id}.arguments`), timeout_ms: integer(item['timeout_ms'], `${id}.timeout_ms`) };
    else if (kind === 'yylo_pi') harnesses[id] = { kind, prompt: string(item['prompt'], `${id}.prompt`), ...(typeof item['executable'] === 'string' ? { executable: item['executable'] } : {}),
      ...(item['timeout_ms'] === undefined ? {} : { timeout_ms: integer(item['timeout_ms'], `${id}.timeout_ms`) }), ...(item['arguments'] === undefined ? {} : { arguments: stringArray(item['arguments'], `${id}.arguments`) }) };
    else if (kind === 'workflow_runner') harnesses[id] = { kind, executable: string(item['executable'], `${id}.executable`),
      ...(item['timeout_ms'] === undefined ? {} : { timeout_ms: integer(item['timeout_ms'], `${id}.timeout_ms`) }), ...(item['arguments'] === undefined ? {} : { arguments: stringArray(item['arguments'], `${id}.arguments`) }) };
    else throw new Error(`unsupported harness kind for ${id}`);
  }
  const evaluatorInput = object(root['evaluators'], 'evaluators'); const evaluators: Record<string, EvaluatorConfig> = {};
  for (const [id, raw] of Object.entries(evaluatorInput)) {
    const item = object(raw, `evaluator ${id}`); const kind = item['kind']; const common = { profile_version: string(item['profile_version'], `${id}.profile_version`), generation: integer(item['generation'], `${id}.generation`), required: item['required'] === true };
    if (kind === 'deterministic') evaluators[id] = { kind, ...common, ...(item['correctness_gate'] === undefined ? {} : { correctness_gate: item['correctness_gate'] === true }), command: stringArray(item['command'], `${id}.command`) };
    else if (kind === 'llm_judge') {
      if (!['blinded', 'visible'].includes(String(item['identity_visibility'])) || !['single', 'reference', 'pairwise'].includes(String(item['mode']))
          || !['majority', 'all', 'any'].includes(String(item['aggregation'])) || !['strict_json', 'legacy_verdict'].includes(String(item['parser']))) throw new Error(`judge evaluator enum is invalid: ${id}`);
      if (item['mode'] === 'pairwise') throw new Error(`pairwise judge requires an explicit counterpart evidence binding, which this config schema does not provide: ${id}`);
      if (item['mode'] === 'reference' && item['reference'] === undefined) throw new Error(`reference judge requires a hash-bound reference value: ${id}`);
      evaluators[id] = { kind, ...common, harness_profile: string(item['harness_profile'], `${id}.harness_profile`), requested_model: string(item['requested_model'], `${id}.requested_model`),
        system_prompt: string(item['system_prompt'], `${id}.system_prompt`), prompt_template: string(item['prompt_template'], `${id}.prompt_template`), rubric: string(item['rubric'], `${id}.rubric`),
        evidence_fields: stringArray(item['evidence_fields'], `${id}.evidence_fields`), max_evidence_bytes: integer(item['max_evidence_bytes'], `${id}.max_evidence_bytes`, 64),
        identity_visibility: item['identity_visibility'] as 'blinded' | 'visible', mode: item['mode'] as 'single' | 'reference' | 'pairwise', timeout_ms: integer(item['timeout_ms'], `${id}.timeout_ms`),
        repetitions: integer(item['repetitions'], `${id}.repetitions`), aggregation: item['aggregation'] as 'majority' | 'all' | 'any', parser: item['parser'] as 'strict_json' | 'legacy_verdict',
        settings: object(item['settings'] ?? {}, `${id}.settings`) as Record<string, JsonValue>,
        ...(item['reference'] === undefined ? {} : { reference: JSON.parse(JSON.stringify(item['reference'])) as JsonValue }) };
    } else throw new Error(`unsupported evaluator kind for ${id}`);
  }
  const config: V2Config = { schema_version: V2_CONFIG_SCHEMA_VERSION, yylo_version: string(root['yylo_version'], 'yylo_version'),
    workspace: { attempts_root: safeRelative(string(workspaceInput['attempts_root'], 'workspace.attempts_root'), 'workspace.attempts_root'), registry_root: safeRelative(string(workspaceInput['registry_root'], 'workspace.registry_root'), 'workspace.registry_root') },
    default_candidate_harness: string(root['default_candidate_harness'], 'default_candidate_harness'), harnesses,
    default_evaluators: stringArray(root['default_evaluators'], 'default_evaluators'), evaluators };
  if (config.harnesses[config.default_candidate_harness] === undefined) throw new Error('default candidate harness is unavailable');
  for (const id of config.default_evaluators) if (config.evaluators[id] === undefined) throw new Error(`default evaluator is unavailable: ${id}`);
  return { config: Object.freeze(config), path: pathname, hash: `sha256:${sha256Hex(bytes)}` };
}

function evaluatorProfileHash(profile: EvaluatorProfile): `sha256:${string}` {
  if (profile.kind !== 'llm_judge') return canonicalHash(profile);
  const binding = (value: typeof profile.systemPrompt) => 'inline' in value
    ? { source: 'inline', hash: `sha256:${sha256Hex(value.inline)}` }
    : { source: 'file', hash: value.sha256 };
  return canonicalHash({ ...profile, systemPrompt: binding(profile.systemPrompt), promptTemplate: binding(profile.promptTemplate), rubric: binding(profile.rubric) });
}

function evaluatorProfile(id: string, value: EvaluatorConfig): EvaluatorProfile {
  if (value.kind === 'deterministic') return { profileId: id, profileVersion: value.profile_version, generation: value.generation, kind: 'deterministic', required: value.required,
    ...(value.correctness_gate === undefined ? {} : { correctnessGate: value.correctness_gate }) };
  return { profileId: id, profileVersion: value.profile_version, generation: value.generation, kind: 'llm_judge', required: value.required,
    harnessProfile: value.harness_profile, requestedModel: value.requested_model, systemPrompt: { inline: value.system_prompt }, promptTemplate: { inline: value.prompt_template }, rubric: { inline: value.rubric },
    evidenceFields: value.evidence_fields, maxEvidenceBytes: value.max_evidence_bytes, identityVisibility: value.identity_visibility, mode: value.mode,
    timeoutMs: value.timeout_ms, repetitions: value.repetitions, aggregation: value.aggregation, parser: { kind: value.parser }, settings: value.settings,
    ...(value.reference === undefined ? {} : { reference: value.reference }) };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' } });
  return stdout.trim();
}
async function sourceRepositoryIdentity(cwd: string): Promise<string> {
  const remote = await git(cwd, ['config', '--get', 'remote.origin.url']).catch(() => '');
  if (remote) return remote;
  const topLevel = await git(cwd, ['rev-parse', '--show-toplevel']);
  return realpathSync(topLevel);
}
async function trackedBytes(cwd: string, commit: string, relative: string): Promise<Buffer> {
  safeRelative(relative, 'case path');
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'show', `${commit}:${relative}`], { encoding: 'buffer', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  return Buffer.from(stdout);
}

export async function createV2ExperimentPlan(input: {
  readonly cwd: string; readonly configPath?: string; readonly benchmarkVersion: string; readonly task?: string; readonly workflow?: string;
  readonly models: readonly string[]; readonly attempts: number; readonly harness?: string; readonly variables?: Readonly<Record<string, JsonValue>>;
  readonly controlledModelVariable?: string; readonly evaluatorIds?: readonly string[];
}): Promise<V2ExperimentPlan> {
  if ((input.task === undefined) === (input.workflow === undefined)) throw new Error('exactly one of --task or --workflow is required');
  if (input.models.length < 1 || input.models.some((item) => !item.trim()) || new Set(input.models).size !== input.models.length) throw new Error('opaque model selectors must be non-empty and unique');
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) throw new Error('attempt count must be positive');
  const loaded = await loadV2Config(input.cwd, input.configPath); const commit = await git(input.cwd, ['rev-parse', 'HEAD']); const tree = await git(input.cwd, ['rev-parse', 'HEAD^{tree}']);
  const casePath = input.task ?? input.workflow!; const caseBytes = await trackedBytes(input.cwd, commit, casePath);
  const harness = input.harness ?? loaded.config.default_candidate_harness;
  if (loaded.config.harnesses[harness] === undefined) throw new Error(`candidate harness is unavailable: ${harness}`);
  const evaluatorIds = input.evaluatorIds ?? loaded.config.default_evaluators;
  const evaluatorCatalog = Object.entries(loaded.config.evaluators).map(([id, config]) => evaluatorProfile(id, config));
  const profiles = evaluatorIds.map((id) => { const config = loaded.config.evaluators[id]; if (config === undefined) throw new Error(`evaluator is unavailable: ${id}`); return evaluatorProfile(id, config); });
  assertEvaluatorProfileUniqueness(profiles, 'plan');
  const configRelative = safeRelative(path.relative(path.resolve(input.cwd), loaded.path).split(path.sep).join('/'), 'config path');
  const snapshotExclusions = [...new Set(['.juno_task', 'hidden-graders', 'reference-solutions', configRelative])].sort();
  const candidateManifest = await deriveCandidateManifest({ sourceRepository: input.cwd, baseCommit: commit, excludedPaths: snapshotExclusions });
  const source = { repository: await sourceRepositoryIdentity(input.cwd), commit, tree,
    candidate_manifest_hash: candidateManifest.manifest_hash };
  const experimentId = canonicalHash({ kind: input.task === undefined ? 'workflow' : 'task', case_path: casePath, case_sha256: `sha256:${sha256Hex(caseBytes)}`, commit,
    models: input.models, attempts: input.attempts, harness, evaluators: profiles, config_hash: loaded.hash, variables: input.variables ?? {}, controlled_model_variable: input.controlledModelVariable ?? null });
  const evaluatorRefs = profiles.map((profile) => ({ profile_id: profile.profileId, profile_version: profile.profileVersion, generation: profile.generation,
    kind: profile.kind, required: profile.required, config_hash: evaluatorProfileHash(profile) }));
  const plans: AttemptPlanV2[] = [];
  for (const model of input.models) for (let attemptIndex = 1; attemptIndex <= input.attempts; attemptIndex += 1) {
    if (input.task !== undefined) plans.push(await compileTaskAttempt({ sourceRepository: input.cwd, baseCommit: commit, sourceIdentity: source, experimentId,
      attemptIndex, harnessProfile: harness, requestedModel: model, evaluators: evaluatorRefs, yyloVersion: loaded.config.yylo_version, benchmarkVersion: input.benchmarkVersion,
      taskId: casePath, taskVersion: `sha256:${sha256Hex(caseBytes)}`, prompt: caseBytes.toString('utf8'), variables: input.variables ?? {} }));
    else {
      const variables = { ...(input.variables ?? {}), ...(input.controlledModelVariable === undefined ? {} : { [input.controlledModelVariable]: model }) };
      plans.push(await compileWorkflowAttempt({ sourceRepository: input.cwd, baseCommit: commit, sourceIdentity: source, experimentId, attemptIndex,
        harnessProfile: harness, requestedModel: model, evaluators: evaluatorRefs, yyloVersion: loaded.config.yylo_version, benchmarkVersion: input.benchmarkVersion,
        workflowId: casePath, workflowVersion: `sha256:${sha256Hex(caseBytes)}`, workflowPath: casePath, variables,
        ...(input.controlledModelVariable === undefined ? {} : { controlledModelVariable: input.controlledModelVariable }) }));
    }
  }
  const core = { schema_version: V2_EXPERIMENT_PLAN_SCHEMA_VERSION, yylo_version: loaded.config.yylo_version, benchmark_version: input.benchmarkVersion,
    experiment_id: experimentId, config_hash: loaded.hash, config_path: configRelative, snapshot_exclusions: snapshotExclusions,
    source_repository: source.repository, source_commit: commit, source_tree: tree,
    comparison_kind: plans[0]!.comparison_kind, case_kind: input.task === undefined ? 'workflow' as const : 'task' as const,
    case_path: casePath, evaluator_profiles: profiles, evaluator_catalog: evaluatorCatalog, attempts: plans };
  return Object.freeze({ ...core, plan_hash: canonicalHash(core) });
}

export function parseV2ExperimentPlan(value: unknown): V2ExperimentPlan {
  const root = object(value, 'v2 experiment plan');
  exactKeys(root, ['schema_version', 'yylo_version', 'benchmark_version', 'experiment_id', 'plan_hash', 'config_hash', 'config_path', 'snapshot_exclusions', 'source_repository',
    'source_commit', 'source_tree', 'comparison_kind', 'case_kind', 'case_path', 'evaluator_profiles', 'evaluator_catalog', 'attempts'], 'v2 experiment plan');
  if (root['schema_version'] !== V2_EXPERIMENT_PLAN_SCHEMA_VERSION || typeof root['yylo_version'] !== 'string' || typeof root['benchmark_version'] !== 'string'
      || typeof root['experiment_id'] !== 'string' || typeof root['plan_hash'] !== 'string' || typeof root['config_hash'] !== 'string'
      || typeof root['config_path'] !== 'string' || !Array.isArray(root['snapshot_exclusions']) || root['snapshot_exclusions'].some((item) => typeof item !== 'string')
      || typeof root['source_repository'] !== 'string' || typeof root['source_commit'] !== 'string' || typeof root['source_tree'] !== 'string'
      || (root['comparison_kind'] !== 'model_only' && root['comparison_kind'] !== 'agent_system') || (root['case_kind'] !== 'task' && root['case_kind'] !== 'workflow')
      || typeof root['case_path'] !== 'string' || !Array.isArray(root['attempts']) || !Array.isArray(root['evaluator_profiles'])
      || !Array.isArray(root['evaluator_catalog'])) throw new Error('v2 experiment plan shape is invalid');
  if (!/^sha256:[0-9a-f]{64}$/u.test(root['experiment_id']) || !/^sha256:[0-9a-f]{64}$/u.test(root['plan_hash'])
      || !/^sha256:[0-9a-f]{64}$/u.test(root['config_hash']) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(root['source_commit'])
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(root['source_tree'])) throw new Error('v2 experiment plan identities are invalid');
  root['evaluator_profiles'].forEach((item, index) => validateEvaluatorProfile(item, `evaluator_profiles[${index}]`));
  root['evaluator_catalog'].forEach((item, index) => validateEvaluatorProfile(item, `evaluator_catalog[${index}]`));
  const { plan_hash: claimed, ...core } = root;
  if (claimed !== canonicalHash(core)) throw new Error('v2 experiment plan hash verification failed');
  let attempts: AttemptPlanV2[];
  try { attempts = root['attempts'].map((item) => AttemptPlanV2Schema.parse(item)); }
  catch (error) { throw new Error(`attempt plan schema verification failed: ${error instanceof Error ? error.message : String(error)}`); }
  const plan = Object.freeze({ ...root, attempts } as unknown as V2ExperimentPlan);
  assertPlannedAttemptCardinality(plan, 'plan');
  for (const attempt of attempts) verifyAttemptPlan(attempt, plan);
  verifyExperimentIdentity(plan);
  return plan;
}

export async function readV2Plan(cwd: string, planPath: string): Promise<V2ExperimentPlan> {
  let value: unknown; try { value = JSON.parse(await readFile(path.resolve(cwd, planPath), 'utf8')) as unknown; } catch { throw new Error(`cannot read v2 plan: ${planPath}`); }
  return parseV2ExperimentPlan(value);
}
export async function writeV2Plan(cwd: string, planPath: string, plan: V2ExperimentPlan): Promise<void> {
  await writeFile(path.resolve(cwd, planPath), `${serializeV2(plan)}\n`, { flag: 'wx', mode: 0o600 });
}

/** Resolve controller-only retained paths without exposing them to a candidate environment. */
export async function resolveV2RuntimePaths(input: { readonly cwd: string; readonly configPath?: string; readonly plan: V2ExperimentPlan;
  readonly attemptIndex: number }): Promise<{ attemptsRoot: string; workspaceRoot: string; repository: string; registry: string; intents: string }> {
  const loaded = await loadV2Config(input.cwd, input.configPath);
  const attempt = input.plan.attempts[input.attemptIndex];
  if (attempt === undefined) throw new Error('runtime path attempt index is out of range');
  const root = roots(input.cwd, loaded.config); const attemptsRoot = attemptWorkspaceRoot(root, attempt);
  const workspaceRoot = path.join(attemptsRoot, attempt.attempt_id.slice(7));
  return { attemptsRoot, workspaceRoot, repository: path.join(workspaceRoot, 'repository'), registry: root.registry, intents: root.intents };
}

class CommandHarnessAdapter implements HarnessAdapter {
  public readonly profileId: string; public readonly version = '2'; readonly #config: CommandHarnessConfig;
  public constructor(profileId: string, config: CommandHarnessConfig) { this.profileId = profileId; this.#config = config; }
  public async probe(): Promise<{ ready: true }> { return { ready: true }; }
  public async prepare(): Promise<{ prepared: true }> { return { prepared: true }; }
  public async reconcile(): Promise<HarnessReconcileResult> { return { state: 'ambiguous', reason: 'command harness has durable intent without a terminal; manual reconciliation is required' }; }
  public async run(request: HarnessRequest): Promise<HarnessTerminalInput> {
    const started = new Date();
    const output = await captured(this.#config.executable, this.#config.arguments, request.cwd, { ...request.environment,
      YYLO_BENCHMARK_REQUEST_JSON: canonicalJson({ attemptId: request.attemptId, requestedModel: request.requestedModel, invocation: request.invocation ?? null }) },
      request.timeoutMs ?? this.#config.timeout_ms, undefined, request.deniedPaths);
    if (output.timedOut) {
      const ended = new Date(); return { status: 'timeout', exit_code: output.code, signal: output.signal, session_id: null,
        resolved_provider: null, resolved_model: null, observed_provider: null, observed_model: null, harness_version: this.version,
        started_at: started.toISOString(), ended_at: ended.toISOString(), runtime_ms: output.runtimeMs, cost: { completeness: 'unavailable', usd: null }, process: { pid: output.pid, command: [this.#config.executable, ...this.#config.arguments] }, artifacts: [], raw_output: output.stdout };
    }
    let parsed: unknown; try { parsed = JSON.parse(output.stdout) as unknown; } catch {
      // Sandbox launch failures commonly have no stdout. Retain a bounded stderr
      // diagnostic so the invalid terminal explains the fail-closed denial.
      parsed = { status: 'malformed_json', raw_output: boundedCommandHarnessDiagnostic(output.stdout, output.stderr) };
    }
    const terminal = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed : { status: 'malformed_payload', raw_output: output.stdout }) as unknown as HarnessTerminalInput; const ended = new Date();
    const measuredFailure = output.code !== 0 || output.signal !== null;
    const measured = { ...terminal, exit_code: output.code, signal: output.signal,
      started_at: started.toISOString(), ended_at: ended.toISOString(), runtime_ms: output.runtimeMs,
      process: { pid: output.pid, command: [this.#config.executable, ...this.#config.arguments] } };
    return measuredFailure ? withMeasuredProcessFailure(measured) : measured;
  }
}

function resolvedExecutable(executable: string): string {
  if (path.isAbsolute(executable) || executable.includes(path.sep)) return executable;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch { /* continue */ }
  }
  return executable;
}

function harnessAdapter(id: string, config: HarnessConfig): HarnessAdapter {
  if (config.kind === 'command') return new CommandHarnessAdapter(id, { ...config, executable: resolvedExecutable(config.executable) });
  if (config.kind === 'yylo_pi') return new YyloPiHarnessAdapter({ profileId: id, prompt: config.prompt, executable: resolvedExecutable(config.executable ?? 'yy'),
    ...(config.timeout_ms === undefined ? {} : { timeoutMs: config.timeout_ms }), ...(config.arguments === undefined ? {} : { extraArgs: config.arguments }) });
  return new WorkflowRunnerHarnessAdapter({ profileId: id, executable: resolvedExecutable(config.executable), ...(config.timeout_ms === undefined ? {} : { timeoutMs: config.timeout_ms }),
    ...(config.arguments === undefined ? {} : { extraArgs: config.arguments }) });
}

async function captured(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs: number, stdin?: string,
  deniedPaths?: readonly string[]): Promise<{
  pid: number | null; code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; runtimeMs: number;
}> {
  const result = await runCapturedProcess(executable, args, { cwd, environment, timeoutMs, ...(stdin === undefined ? {} : { stdin }),
    ...(deniedPaths === undefined ? {} : { deniedPaths }) });
  return { pid: result.pid, code: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
    timedOut: result.timedOut, runtimeMs: result.runtimeMs };
}

function deterministicRunner(config: DeterministicEvaluatorConfig, cwd: string): DeterministicEvaluator {
  return async (evidence) => {
    const [executable, ...args] = config.command; if (executable === undefined) throw new Error('deterministic evaluator command is empty');
    const result = await captured(executable, args, cwd, { ...process.env }, 60_000, canonicalJson(evidence));
    if (result.timedOut) throw new Error('deterministic evaluator timed out');
    if (result.code !== 0) throw new Error(`deterministic evaluator exited ${result.code ?? result.signal}`);
    const parsed = object(JSON.parse(result.stdout) as unknown, 'deterministic evaluator output');
    if (typeof parsed['passed'] !== 'boolean' || typeof parsed['rawOutput'] !== 'string' || !Array.isArray(parsed['findings'])) {
      throw new Error('deterministic evaluator output requires boolean passed, findings array, and string rawOutput');
    }
    return { passed: parsed['passed'], findings: parsed['findings'] as never[], rawOutput: parsed['rawOutput'], runtimeMs: result.runtimeMs };
  };
}

function runtimeEvaluators(config: V2Config, profiles: readonly EvaluatorProfile[], cwd: string): {
  deterministic: Record<string, DeterministicEvaluator>; judges: Record<string, HarnessAdapter>;
} {
  const deterministic: Record<string, DeterministicEvaluator> = {}; const judges: Record<string, HarnessAdapter> = {};
  for (const profile of profiles) {
    const source = config.evaluators[profile.profileId];
    if (source?.kind === 'deterministic') deterministic[profile.profileId] = deterministicRunner(source, cwd);
    if (profile.kind === 'llm_judge') {
      const harness = config.harnesses[profile.harnessProfile]; if (harness !== undefined) judges[profile.harnessProfile] = harnessAdapter(profile.harnessProfile, harness);
    }
  }
  return { deterministic, judges };
}

function assertPlanConfigBinding(plan: V2ExperimentPlan, config: V2Config): void {
  assertPlannedAttemptCardinality(plan, 'plan');
  const expectedCatalog = Object.entries(config.evaluators).map(([id, value]) => evaluatorProfile(id, value));
  if (canonicalHash(plan.evaluator_catalog) !== canonicalHash(expectedCatalog)
      || plan.evaluator_profiles.some((profile) => !expectedCatalog.some((expected) => canonicalHash(expected) === canonicalHash(profile)))) {
    throw new Error('v2 plan evaluator catalog/config binding failed');
  }
}

function roots(cwd: string, config: V2Config): { attempts: string; registry: string; intents: string; evaluations: string; isolatedAttempts: boolean; enforcedBoundary: boolean } {
  const enforcedBoundary = config.workspace.attempts_root === '.yylo-benchmark/attempts'
    && config.workspace.registry_root === '.yylo-benchmark/registry';
  if (!enforcedBoundary) {
    const registry = path.resolve(cwd, config.workspace.registry_root);
    return { attempts: path.resolve(cwd, config.workspace.attempts_root), registry, intents: path.join(registry, 'v2', 'intents'),
      evaluations: path.join(registry, 'v2', 'evaluations'), isolatedAttempts: false, enforcedBoundary: false };
  }
  const namespace = canonicalHash({ source_repository: realpathSync(cwd), attempts_root: config.workspace.attempts_root,
    registry_root: config.workspace.registry_root }).slice(7);
  const attempts = path.join(os.tmpdir(), `yylo-benchmark-attempt-${namespace}`);
  const registry = path.join(os.homedir(), '.local', 'state', 'yylo-benchmark', 'registry', namespace);
  return { attempts, registry, intents: path.join(registry, 'v2', 'intents'), evaluations: path.join(registry, 'v2', 'evaluations'),
    isolatedAttempts: true, enforcedBoundary };
}
function attemptWorkspaceRoot(root: ReturnType<typeof roots>, attempt: AttemptPlanV2): string {
  return root.isolatedAttempts
    ? `${root.attempts}-${canonicalHash({ attempt_id: attempt.attempt_id, plan_hash: attempt.plan_hash }).slice(7)}`
    : root.attempts;
}
async function retainedAttemptRoots(root: ReturnType<typeof roots>): Promise<string[]> {
  if (!root.enforcedBoundary) return [];
  const parent = path.dirname(root.attempts); const prefix = `${path.basename(root.attempts)}-`;
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.name.startsWith(prefix) && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => path.join(parent, entry.name));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function attemptBoundaryPaths(cwd: string, root: ReturnType<typeof roots>, plan: V2ExperimentPlan, attempt: AttemptPlanV2): Promise<{
  protectedPaths: string[]; deniedPaths: string[];
}> {
  const ownRoot = path.resolve(attemptWorkspaceRoot(root, attempt));
  const explicitControllerRoots = ['CONTROLLER_ROOT', 'PROJECT_ROOT', 'JUNO_CONTROLLER_ROOT', 'JUNO_PROJECT_ROOT']
    .flatMap((name) => { const value = process.env[name]; return value !== undefined && path.isAbsolute(value) ? [value] : []; });
  const candidates = [root.registry, ...explicitControllerRoots, ...(await retainedAttemptRoots(root)),
    ...plan.attempts.filter((item) => item.attempt_id !== attempt.attempt_id).map((item) => attemptWorkspaceRoot(root, item))];
  const protectedPaths = [...new Set(candidates.map((item) => path.resolve(item)))]
    .filter((item) => item !== ownRoot && !ownRoot.startsWith(`${item}${path.sep}`));
  return { protectedPaths, deniedPaths: root.enforcedBoundary ? [path.resolve(cwd), ...protectedPaths] : [] };
}

async function verifySourceIdentity(cwd: string, plan: V2ExperimentPlan): Promise<void> {
  const commit = await git(cwd, ['rev-parse', 'HEAD']);
  const tree = await git(cwd, ['rev-parse', 'HEAD^{tree}']);
  const repository = await sourceRepositoryIdentity(cwd);
  const manifest = await deriveCandidateManifest({ sourceRepository: cwd, baseCommit: commit, excludedPaths: plan.snapshot_exclusions });
  if (repository !== plan.source_repository) throw new Error('actual source repository differs from the immutable experiment plan');
  if (commit !== plan.source_commit || tree !== plan.source_tree) throw new Error('actual source commit/tree differs from the immutable experiment plan');
  if (manifest.source_commit !== commit || manifest.source_tree !== tree
      || plan.attempts.some((attempt) => attempt.case.source.candidate_manifest_hash !== manifest.manifest_hash)) {
    throw new Error('actual source candidate manifest differs from the immutable experiment plan');
  }
  const caseBytes = await trackedBytes(cwd, commit, plan.case_path);
  const caseHash = `sha256:${sha256Hex(caseBytes)}`;
  for (const attempt of plan.attempts) {
    const normalized = object(attempt.case.normalized_input, 'planned normalized input');
    const bound = attempt.case.case_version === caseHash && (plan.case_kind === 'task'
      ? normalized['prompt'] === caseBytes.toString('utf8')
      : normalized['workflow_path'] === plan.case_path && normalized['workflow_sha256'] === caseHash);
    if (!bound) throw new Error('planned case input differs from the tracked source case');
  }
}
function statePath(registry: string, plan: V2ExperimentPlan, attempt: AttemptPlanV2): string {
  return path.join(registry, 'v2', 'runs', plan.experiment_id.slice(7), `${attempt.attempt_id.slice(7)}.json`);
}
async function atomicJson(destination: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await chmod(path.dirname(destination), 0o700);
  const temporary = `${destination}.${process.pid}.tmp`; await writeFile(temporary, `${canonicalJson(value)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination); await chmod(destination, 0o600);
}
function makeState(input: Omit<PersistedAttempt, 'state_hash'>): PersistedAttempt { return Object.freeze({ ...input, state_hash: canonicalHash(input) }); }
function verifyAttemptPlan(plan: AttemptPlanV2, experiment: V2ExperimentPlan): void {
  const parsed = AttemptPlanV2Schema.safeParse(plan);
  if (!parsed.success) throw new Error(`attempt plan schema verification failed: ${parsed.error.issues.map((item) => item.message).join('; ')}`);
  const { plan_hash: claimed, ...core } = plan;
  if (claimed !== canonicalHash(core)) throw new Error('attempt plan integrity failed');
  const expectedAttemptId = canonicalHash({ experiment_id: plan.experiment_id, case_hash: plan.case.normalized_input_hash, attempt_index: plan.attempt_index,
    harness_profile: plan.harness_profile, requested_model: plan.requested_model });
  if (plan.attempt_id !== expectedAttemptId || plan.experiment_id !== experiment.experiment_id
      || plan.yylo_version !== experiment.yylo_version || plan.benchmark_version !== experiment.benchmark_version
      || plan.case.yylo_version !== plan.yylo_version || plan.case.yylo_version !== experiment.yylo_version
      || plan.case.source.repository !== experiment.source_repository || plan.case.source.commit !== experiment.source_commit
      || plan.case.source.tree !== experiment.source_tree || plan.case.kind !== experiment.case_kind
      || plan.comparison_kind !== experiment.comparison_kind) throw new Error('attempt plan identity failed');
  for (const evaluator of plan.evaluators) {
    const profile = experiment.evaluator_catalog.find((item) => item.profileId === evaluator.profile_id && item.generation === evaluator.generation);
    if (profile === undefined || profile.profileVersion !== evaluator.profile_version || profile.kind !== evaluator.kind
        || profile.required !== evaluator.required || evaluator.config_hash !== evaluatorProfileHash(profile)) {
      throw new Error('attempt evaluator configuration linkage failed');
    }
  }
}

function assertConfigPathBinding(cwd: string, plan: V2ExperimentPlan, loadedPath: string): void {
  const relative = path.relative(path.resolve(cwd), loadedPath).split(path.sep).join('/');
  if (relative !== plan.config_path) throw new Error('v2 config path drifted from the immutable plan');
  const expected = [...new Set(['.juno_task', 'hidden-graders', 'reference-solutions', plan.config_path])].sort();
  if (canonicalHash(plan.snapshot_exclusions) !== canonicalHash(expected)) throw new Error('v2 snapshot exclusion binding failed');
}

async function loadState(file: string, plan: V2ExperimentPlan, attempt: AttemptPlanV2): Promise<PersistedAttempt | null> {
  let value: unknown; try { value = JSON.parse(await readFile(file, 'utf8')) as unknown; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  verifyAttemptPlan(attempt, plan);
  const state = object(value, 'attempt state') as unknown as PersistedAttempt; const { state_hash: claimed, ...core } = state;
  if (state.schema_version !== 'yylo_benchmark_attempt_state.v2' || claimed !== canonicalHash(core)) throw new Error(`attempt state integrity failed: ${file}`);
  if (state.plan_hash !== plan.plan_hash || state.attempt_id !== attempt.attempt_id
      || !/^sha256:[0-9a-f]{64}$/u.test(state.workspace_manifest_hash)) throw new Error(`attempt state identity/linkage mismatch: ${file}`);
  const evidence = AttemptEvidenceV2Schema.parse(state.evidence); const { evidence_hash: evidenceHash, ...evidenceCore } = evidence;
  if (evidence.attempt_id !== attempt.attempt_id || evidence.plan_hash !== attempt.plan_hash || evidenceHash !== canonicalHash(evidenceCore)
      || evidence.workspace_manifest_hash !== state.workspace_manifest_hash
      || evidence.identity.harness_profile !== attempt.harness_profile || evidence.identity.requested_model !== attempt.requested_model) {
    throw new Error(`attempt evidence identity/linkage mismatch: ${file}`);
  }
  if (!Array.isArray(state.evaluation_records)) throw new Error(`evaluation record linkage is malformed: ${file}`);
  for (const rawRecord of state.evaluation_records) {
    const record = EvaluationRecordV2Schema.parse(rawRecord) as RichEvaluationRecord;
    const { evaluation_id: evaluationId, ...recordCore } = record;
    const catalogProfile = plan.evaluator_catalog.find((item) => item.profileId === record.evaluator_profile_id);
    const profile = catalogProfile === undefined ? undefined : { ...catalogProfile, generation: record.evaluator_generation } as EvaluatorProfile;
    const failures = [
      evaluationId !== canonicalHash(recordCore) ? 'evaluation_id' : null,
      record.attempt_id !== attempt.attempt_id ? 'attempt_id' : null,
      record.evidence_hash !== evidence.evidence_hash ? 'evidence_hash' : null,
      profile === undefined ? 'profile_missing' : null,
      profile !== undefined && profile.kind !== record.evaluator_kind ? 'profile_kind' : null,
      profile !== undefined && profile.required !== record.required_gate ? 'required_gate' : null,
      profile !== undefined && record.profile_hash !== evaluatorProfileHash(profile) ? 'profile_hash' : null,
      record.raw_output !== undefined && record.raw_output_hash !== canonicalHash(record.raw_output) ? 'raw_output_hash' : null,
    ].filter((item): item is string => item !== null);
    if (failures.length > 0) throw new Error(`evaluation identity/config/evidence linkage mismatch (${failures.join(',')}): ${file}`);
  }
  return Object.freeze(state);
}
async function verifyRetainedArtifacts(input: { cwd: string; root: ReturnType<typeof roots>; plan: V2ExperimentPlan; attempt: AttemptPlanV2;
  state: PersistedAttempt; harness: HarnessConfig; protectedPaths?: readonly string[]; deniedPaths?: readonly string[] }): Promise<void> {
  const boundary = await attemptBoundaryPaths(input.cwd, input.root, input.plan, input.attempt);
  const workspace = await loadAttemptWorkspace({ attemptId: input.attempt.attempt_id as `sha256:${string}`, attemptsRoot: attemptWorkspaceRoot(input.root, input.attempt),
    sourceRepository: input.cwd, privateRegistryRoot: input.root.registry, controllerPaths: input.protectedPaths ?? boundary.protectedPaths,
    deniedPaths: input.deniedPaths ?? boundary.deniedPaths });
  if (workspace.resultManifest === null) throw new Error('retained post-execution repository/workspace manifest is missing');
  await doctorAttemptWorkspace(workspace, { sourceRepository: input.cwd });
  if (workspace.receipt.receipt_hash !== input.state.evidence.workspace_receipt_hash) throw new Error('retained workspace receipt linkage mismatch');
  if (workspace.resultManifest.manifest_hash !== input.state.workspace_manifest_hash
      || workspace.resultManifest.manifest_hash !== input.state.evidence.workspace_manifest_hash) throw new Error('retained workspace manifest state/evidence linkage mismatch');
  const adapter = harnessAdapter(input.attempt.harness_profile, input.harness);
  const terminal = await loadHarnessTerminalForVerification({ attemptId: input.attempt.attempt_id as `sha256:${string}`,
    requestedModel: input.attempt.requested_model, cwd: workspace.repository, environment: workspace.candidateEnvironment,
    invocation: caseInvocation(input.attempt), intentRoot: input.root.intents, adapter });
  if (terminal.terminal_hash !== input.state.terminal_hash || terminal.workspace_manifest_hash !== input.state.workspace_manifest_hash) throw new Error('retained terminal/workspace manifest hash linkage mismatch');
  const evidence = evidenceFromTerminal(input.attempt, workspace, terminal);
  if (canonicalHash(evidence) !== canonicalHash(input.state.evidence)) throw new Error('retained terminal/workspace evidence linkage mismatch');
}

async function exists(destination: string): Promise<boolean> { try { await stat(destination); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }

export async function runV2Experiment(input: { readonly cwd: string; readonly configPath?: string; readonly plan: V2ExperimentPlan; readonly recovery?: boolean; readonly dryRun?: boolean }): Promise<Record<string, unknown>> {
  parseV2ExperimentPlan(input.plan);
  await verifySourceIdentity(input.cwd, input.plan);
  const loaded = await loadV2Config(input.cwd, input.configPath); if (loaded.hash !== input.plan.config_hash) throw new Error('v2 config drifted from the immutable plan');
  assertConfigPathBinding(input.cwd, input.plan, loaded.path);
  assertPlanConfigBinding(input.plan, loaded.config);
  for (const attempt of input.plan.attempts) verifyAttemptPlan(attempt, input.plan);
  if (input.dryRun === true) return { schema_version: 'yylo_benchmark_run_dry_run.v2', yylo_version: input.plan.yylo_version, plan_hash: input.plan.plan_hash,
    dispatch_count: 0, attempt_count: input.plan.attempts.length, comparison_kind: input.plan.comparison_kind };
  const root = roots(input.cwd, loaded.config); const attempts: Array<Record<string, unknown>> = []; let dispatched = 0; let reused = 0; let ambiguous = 0;
  for (const attempt of input.plan.attempts) {
    const { protectedPaths, deniedPaths } = await attemptBoundaryPaths(input.cwd, root, input.plan, attempt);
    const file = statePath(root.registry, input.plan, attempt); const retained = await loadState(file, input.plan, attempt);
    if (retained !== null) {
      const retainedHarness = loaded.config.harnesses[attempt.harness_profile]; if (retainedHarness === undefined) throw new Error(`candidate harness unavailable: ${attempt.harness_profile}`);
      await verifyRetainedArtifacts({ cwd: input.cwd, root, plan: input.plan, attempt, state: retained, harness: retainedHarness, protectedPaths, deniedPaths });
      reused += 1; attempts.push({ attempt_id: attempt.attempt_id, reused: true, evidence: retained.evidence,
      evaluation: { records: retained.evaluation_records, quality: retained.quality, validity: retained.validity } }); continue; }
    const attemptsRoot = attemptWorkspaceRoot(root, attempt);
    const attemptDirectory = path.join(attemptsRoot, attempt.attempt_id.slice(7));
    const harnessConfig = loaded.config.harnesses[attempt.harness_profile]; if (harnessConfig === undefined) throw new Error(`candidate harness unavailable: ${attempt.harness_profile}`);
    let executed: { evidence: AttemptEvidenceV2; terminal: { terminal_hash: `sha256:${string}`; workspace_manifest_hash: `sha256:${string}` } };
    if (await exists(attemptDirectory)) {
      if (input.recovery !== true) { ambiguous += 1; attempts.push({ attempt_id: attempt.attempt_id, reused: false, recovery: 'manual', quality: 'unknown' }); continue; }
      try {
        const workspace = await loadAttemptWorkspace({ attemptId: attempt.attempt_id as `sha256:${string}`, attemptsRoot, sourceRepository: input.cwd,
          privateRegistryRoot: root.registry, controllerPaths: protectedPaths, deniedPaths });
        await doctorAttemptWorkspace(workspace, { sourceRepository: input.cwd });
        const terminal = await recoverCaseAttempt({ plan: attempt, workspace, intentRoot: root.intents, adapter: harnessAdapter(attempt.harness_profile, harnessConfig) });
        if (terminal.recovery === 'manual') { ambiguous += 1; attempts.push({ attempt_id: attempt.attempt_id, reused: false, recovery: 'manual', quality: 'unknown' }); continue; }
        executed = { terminal, evidence: evidenceFromTerminal(attempt, workspace, terminal) };
        reused += 1;
      } catch { ambiguous += 1; attempts.push({ attempt_id: attempt.attempt_id, reused: false, recovery: 'manual', quality: 'unknown' }); continue; }
    } else {
      executed = await executeCaseAttempt({ plan: attempt, sourceRepository: input.cwd, attemptsRoot, privateRegistryRoot: root.registry, excludedPaths: input.plan.snapshot_exclusions,
        controllerPaths: protectedPaths, deniedPaths, intentRoot: root.intents, adapter: harnessAdapter(attempt.harness_profile, harnessConfig) });
      dispatched += 1;
    }
    const profiles = input.plan.evaluator_profiles; const runtime = runtimeEvaluators(loaded.config, profiles, input.cwd);
    const evaluation = await evaluateAttempt({ evidence: executed.evidence, caseKind: input.plan.case_kind, profiles, composition: { kind: 'all_required' },
      deterministicEvaluators: runtime.deterministic, judgeAdapters: runtime.judges, intentRoot: root.evaluations, cwd: input.cwd });
    const state = makeState({ schema_version: 'yylo_benchmark_attempt_state.v2', plan_hash: input.plan.plan_hash, attempt_id: attempt.attempt_id,
      terminal_hash: executed.terminal.terminal_hash, workspace_manifest_hash: executed.terminal.workspace_manifest_hash, evidence: executed.evidence, evaluation_records: evaluation.records, quality: evaluation.quality, validity: evaluation.validity });
    await atomicJson(file, state); attempts.push({ attempt_id: attempt.attempt_id, reused: false, evidence: state.evidence,
      evaluation: { records: state.evaluation_records, quality: state.quality, validity: state.validity } });
  }
  return { schema_version: 'yylo_benchmark_run_receipt.v2', yylo_version: input.plan.yylo_version, plan_hash: input.plan.plan_hash,
    operation: input.recovery === true ? 'recover' : 'run', candidate_dispatch_count: dispatched, reused_terminal_count: reused, ambiguous_count: ambiguous, attempts };
}

export async function reevaluateV2Experiment(input: { readonly cwd: string; readonly configPath?: string; readonly plan: V2ExperimentPlan; readonly profileId: string; readonly kind: 'regrade' | 'rejudge' }): Promise<Record<string, unknown>> {
  parseV2ExperimentPlan(input.plan);
  await verifySourceIdentity(input.cwd, input.plan);
  const loaded = await loadV2Config(input.cwd, input.configPath); if (loaded.hash !== input.plan.config_hash) throw new Error('v2 config drifted from the immutable plan');
  assertConfigPathBinding(input.cwd, input.plan, loaded.path);
  assertPlanConfigBinding(input.plan, loaded.config);
  const config = loaded.config.evaluators[input.profileId]; if (config === undefined || (input.kind === 'regrade') !== (config.kind === 'deterministic')) throw new Error(`${input.kind} profile kind is invalid: ${input.profileId}`);
  const profile = evaluatorProfile(input.profileId, config);
  if (!input.plan.evaluator_catalog.some((item) => item.profileId === profile.profileId && item.generation === profile.generation
      && canonicalHash(item) === canonicalHash(profile))) throw new Error(`re-evaluation profile drifted from the immutable plan catalog: ${input.profileId}`);
  const root = roots(input.cwd, loaded.config); const attempts: Array<Record<string, unknown>> = [];
  const verified: Array<{ attempt: AttemptPlanV2; retained: PersistedAttempt; file: string }> = [];
  for (const attempt of input.plan.attempts) {
    const file = statePath(root.registry, input.plan, attempt); const retained = await loadState(file, input.plan, attempt); if (retained === null) throw new Error('re-evaluation requires retained candidate evidence');
    const retainedHarness = loaded.config.harnesses[attempt.harness_profile]; if (retainedHarness === undefined) throw new Error(`candidate harness unavailable: ${attempt.harness_profile}`);
    await verifyRetainedArtifacts({ cwd: input.cwd, root, plan: input.plan, attempt, state: retained, harness: retainedHarness }); verified.push({ attempt, retained, file });
  }
  for (const { attempt, retained, file } of verified) {
    const priorGenerations = retained.evaluation_records.filter((item) => item.evaluator_profile_id === profile.profileId).map((item) => item.evaluator_generation);
    const nextGeneration = priorGenerations.length === 0 ? profile.generation : Math.max(...priorGenerations) + 1;
    const generatedProfile = { ...profile, generation: nextGeneration } as EvaluatorProfile;
    const derivationProfiles = [...input.plan.evaluator_catalog.filter((item) => item.profileId !== profile.profileId), generatedProfile];
    const runtime = runtimeEvaluators(loaded.config, [generatedProfile], input.cwd);
    const evaluation = await reevaluateAttempt({ evidence: retained.evidence, caseKind: input.plan.case_kind, existingRecords: retained.evaluation_records,
      profiles: derivationProfiles, composition: { kind: 'explicit', profileIds: [generatedProfile.profileId], aggregation: 'all' }, deterministicEvaluators: runtime.deterministic,
      judgeAdapters: runtime.judges, intentRoot: root.evaluations, cwd: input.cwd });
    const updated = makeState({ schema_version: retained.schema_version, plan_hash: retained.plan_hash, attempt_id: retained.attempt_id,
      terminal_hash: retained.terminal_hash, workspace_manifest_hash: retained.workspace_manifest_hash, evidence: retained.evidence, evaluation_records: evaluation.records, quality: evaluation.quality, validity: evaluation.validity });
    await atomicJson(file, updated); attempts.push({ attempt_id: attempt.attempt_id, evaluation_records: updated.evaluation_records, quality: updated.quality, validity: updated.validity });
  }
  return { schema_version: `yylo_benchmark_${input.kind}_receipt.v2`, yylo_version: input.plan.yylo_version, plan_hash: input.plan.plan_hash,
    candidate_dispatch_count: 0, evaluator_dispatch_count: input.plan.attempts.length, attempts };
}

function runtimeAggregate(values: readonly number[]): { count: number; total_ms: number; min_ms: number | null; max_ms: number | null; mean_ms: number | null } {
  const total = values.reduce((sum, value) => sum + value, 0);
  return { count: values.length, total_ms: total, min_ms: values.length === 0 ? null : Math.min(...values),
    max_ms: values.length === 0 ? null : Math.max(...values), mean_ms: values.length === 0 ? null : total / values.length };
}

function sumCosts(values: readonly { completeness: string; usd: number | null }[]): { completeness: 'complete' | 'partial' | 'unavailable' | 'not_applicable'; usd: number | null } {
  if (values.length === 0 || values.every((item) => item.completeness === 'not_applicable')) return { completeness: 'not_applicable', usd: null };
  const known = values.filter((item) => item.usd !== null); if (known.length === 0) return { completeness: 'unavailable', usd: null };
  return { completeness: known.length === values.length && values.every((item) => item.completeness === 'complete') ? 'complete' : 'partial', usd: known.reduce((sum, item) => sum + item.usd!, 0) };
}

export async function doctorV2Experiment(input: { readonly cwd: string; readonly configPath?: string; readonly plan: V2ExperimentPlan }): Promise<Record<string, unknown>> {
  parseV2ExperimentPlan(input.plan);
  await verifySourceIdentity(input.cwd, input.plan);
  const loaded = await loadV2Config(input.cwd, input.configPath); if (loaded.hash !== input.plan.config_hash) throw new Error('v2 config drifted from the immutable plan');
  assertConfigPathBinding(input.cwd, input.plan, loaded.path);
  assertPlanConfigBinding(input.plan, loaded.config);
  const root = roots(input.cwd, loaded.config); let retained = 0; let ambiguous = 0; const evidenceIds: string[] = []; const evaluationIds: string[] = [];
  for (const attempt of input.plan.attempts) {
    const state = await loadState(statePath(root.registry, input.plan, attempt), input.plan, attempt);
    if (state !== null) {
      const retainedHarness = loaded.config.harnesses[attempt.harness_profile]; if (retainedHarness === undefined) throw new Error(`candidate harness unavailable: ${attempt.harness_profile}`);
      await verifyRetainedArtifacts({ cwd: input.cwd, root, plan: input.plan, attempt, state, harness: retainedHarness });
      retained += 1; evidenceIds.push(state.evidence.evidence_hash); evaluationIds.push(...state.evaluation_records.map((item) => item.evaluation_id));
    }
    else if (await exists(path.join(attemptWorkspaceRoot(root, attempt), attempt.attempt_id.slice(7)))) ambiguous += 1;
  }
  const missing = input.plan.attempts.length - retained - ambiguous;
  if (missing > 0 || ambiguous > 0) throw new Error(`doctor: planned attempt chain is incomplete (missing=${missing}, ambiguous=${ambiguous})`);
  return { schema_version: 'yylo_benchmark_doctor.v2', yylo_version: input.plan.yylo_version, ok: ambiguous === 0,
    plan_hash: input.plan.plan_hash, candidate_dispatch_count: retained, missing_count: missing, ambiguous_count: ambiguous,
    evidence_ids: evidenceIds, evaluation_ids: evaluationIds };
}

export async function reportV2Experiment(input: { readonly cwd: string; readonly configPath?: string; readonly plan: V2ExperimentPlan }): Promise<Record<string, unknown>> {
  parseV2ExperimentPlan(input.plan);
  await verifySourceIdentity(input.cwd, input.plan);
  const loaded = await loadV2Config(input.cwd, input.configPath); if (loaded.hash !== input.plan.config_hash) throw new Error('v2 config drifted from the immutable plan');
  assertConfigPathBinding(input.cwd, input.plan, loaded.path);
  assertPlanConfigBinding(input.plan, loaded.config);
  const root = roots(input.cwd, loaded.config); const states: PersistedAttempt[] = [];
  for (const attempt of input.plan.attempts) {
    const state = await loadState(statePath(root.registry, input.plan, attempt), input.plan, attempt);
    if (state !== null) {
      const retainedHarness = loaded.config.harnesses[attempt.harness_profile]; if (retainedHarness === undefined) throw new Error(`candidate harness unavailable: ${attempt.harness_profile}`);
      await verifyRetainedArtifacts({ cwd: input.cwd, root, plan: input.plan, attempt, state, harness: retainedHarness }); states.push(state);
    }
  }
  if (states.length !== input.plan.attempts.length) throw new Error(`report: planned attempt chain is incomplete (retained=${states.length}, planned=${input.plan.attempts.length})`);
  const evidenceIds = states.map((item) => item.evidence.evidence_hash); const records = states.flatMap((item) => item.evaluation_records);
  const candidateRuntime = states.map((item) => item.evidence.candidate.runtime_ms); const evaluatorRuntime = records.map((item) => item.runtime_ms);
  const runtime = { unit: 'milliseconds' as const, provenance: 'measured_wall_clock' as const,
    attempts: states.map((item) => ({ attempt_id: item.attempt_id, evidence_hash: item.evidence.evidence_hash, runtime_ms: item.evidence.candidate.runtime_ms,
      started_at: item.evidence.candidate.started_at, ended_at: item.evidence.candidate.ended_at })),
    evaluators: records.map((item) => ({ evaluation_id: item.evaluation_id, attempt_id: item.attempt_id, evaluator_profile_id: item.evaluator_profile_id,
      evaluator_generation: item.evaluator_generation, runtime_ms: item.runtime_ms })),
    aggregate: { candidate: runtimeAggregate(candidateRuntime), evaluators: runtimeAggregate(evaluatorRuntime),
      total_ms: candidateRuntime.reduce((sum, value) => sum + value, 0) + evaluatorRuntime.reduce((sum, value) => sum + value, 0) } };
  const provenance = ReportProvenanceV2Schema.parse({ schema_version: 'yylo_benchmark_report_provenance.v2', yylo_version: input.plan.yylo_version,
    report_id: canonicalHash({ plan_hash: input.plan.plan_hash, evidence_ids: evidenceIds, evaluation_ids: records.map((item) => item.evaluation_id) }),
    attempt_evidence_ids: evidenceIds, evaluation_ids: records.map((item) => item.evaluation_id),
    evaluator_generations: [...new Map(records.map((item) => [`${item.evaluator_profile_id}:${item.evaluator_generation}`, { profile_id: item.evaluator_profile_id, generation: item.evaluator_generation }])).values()],
    derived_at: new Date().toISOString() });
  return ReportV2Schema.parse({ schema_version: 'yylo_benchmark_report.v2', yylo_version: input.plan.yylo_version, plan_hash: input.plan.plan_hash,
    comparison_kind: input.plan.comparison_kind, evidence_count: states.length, valid_resolved: states.filter((item) => item.validity === 'valid' && item.quality === 'resolved').length,
    valid_unresolved: states.filter((item) => item.validity === 'valid' && item.quality === 'unresolved').length,
    invalid: states.filter((item) => item.validity === 'invalid').length, unknown_quality: states.filter((item) => item.quality === 'unknown').length,
    candidate_cost: sumCosts(states.map((item) => item.evidence.candidate.cost)), judge_cost: sumCosts(records.filter((item) => item.evaluator_kind === 'llm_judge').map((item) => item.cost)),
    runtime, evaluator_generations: provenance.evaluator_generations, provenance });
}

export function parseVariables(values: readonly string[]): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const value of values) { const index = value.indexOf('='); if (index < 1) throw new Error('--var requires key=value'); const key = value.slice(0, index); if (result[key] !== undefined) throw new Error(`duplicate variable: ${key}`);
    const raw = value.slice(index + 1); try { result[key] = JSON.parse(raw) as JsonValue; } catch { result[key] = raw; } }
  return result;
}

export function defaultV2Config(): V2Config {
  return { schema_version: V2_CONFIG_SCHEMA_VERSION, yylo_version: 'set-to-installed-yylo-version',
    workspace: { attempts_root: '.yylo-benchmark/attempts', registry_root: '.yylo-benchmark/registry' }, default_candidate_harness: 'candidate',
    harnesses: { candidate: { kind: 'yylo_pi', prompt: 'Complete the configured benchmark case.' } }, default_evaluators: [], evaluators: {} };
}

export function compositionForProfiles(_profiles: readonly EvaluatorProfile[]): EvaluationComposition { return { kind: 'all_required' }; }
