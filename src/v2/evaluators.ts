import { readFile } from 'node:fs/promises';
import { canonicalHash, sha256Hex, type JsonValue } from '../contracts/canonical.js';
import { CostEvidenceSchema, type CostEvidence } from '../contracts/schemas.js';
import { AttemptEvidenceV2Schema, EvaluationRecordV2Schema, type AttemptEvidenceV2, type EvaluationRecordV2 } from './contracts.js';
import { runHarnessAttempt, type HarnessAdapter, type HarnessTerminalV2 } from './harness.js';

export type FindingSeverity = 'info' | 'warning' | 'error';
export interface EvaluationFinding { readonly code: string; readonly message: string; readonly severity: FindingSeverity }
export interface TextBindingInline { readonly inline: string }
export interface TextBindingFile { readonly file: string; readonly sha256: `sha256:${string}` }
export type TextBinding = TextBindingInline | TextBindingFile;

interface EvaluatorProfileBase {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly generation: number;
  readonly required: boolean;
}
export interface DeterministicEvaluatorProfile extends EvaluatorProfileBase {
  readonly kind: 'deterministic';
  readonly correctnessGate?: boolean;
  readonly timeoutMs?: number;
}
export interface ImportedEvaluatorProfile extends EvaluatorProfileBase { readonly kind: 'imported' | 'human' }
export interface LlmJudgeProfile extends EvaluatorProfileBase {
  readonly kind: 'llm_judge';
  readonly harnessProfile: string;
  readonly requestedModel: string;
  readonly systemPrompt: TextBinding;
  readonly promptTemplate: TextBinding;
  readonly rubric: TextBinding;
  readonly evidenceFields: readonly string[];
  readonly maxEvidenceBytes: number;
  readonly identityVisibility: 'blinded' | 'visible';
  readonly mode: 'single' | 'reference' | 'pairwise';
  readonly timeoutMs: number;
  readonly repetitions: number;
  readonly aggregation: 'majority' | 'all' | 'any';
  readonly parser: { readonly kind: 'strict_json' | 'legacy_verdict' | 'custom'; readonly parserId?: string };
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly reference?: JsonValue;
}
export type EvaluatorProfile = DeterministicEvaluatorProfile | ImportedEvaluatorProfile | LlmJudgeProfile;

export type EvaluationComposition =
  | { readonly kind: 'deterministic_only' | 'judge_only' | 'all_required' }
  | { readonly kind: 'explicit'; readonly profileIds: readonly string[]; readonly aggregation: 'all' | 'any' };

export interface DeterministicEvaluatorResult {
  readonly passed: boolean;
  readonly findings: readonly EvaluationFinding[];
  readonly rawOutput: string;
  readonly runtimeMs?: number;
}
export type DeterministicEvaluator = (evidence: AttemptEvidenceV2) => Promise<DeterministicEvaluatorResult>;
export type CustomOutputParser = (output: string) => { readonly quality: 'resolved' | 'unresolved'; readonly findings?: readonly EvaluationFinding[] };

export interface RichEvaluationRecord extends EvaluationRecordV2 {
  readonly profile_hash: `sha256:${string}`;
  readonly prompt_hash: `sha256:${string}` | null;
  readonly rubric_hash: `sha256:${string}` | null;
  readonly raw_output: string;
  readonly raw_output_hash: `sha256:${string}`;
  readonly evaluator_session_ids: string[];
  readonly evaluator_identity: {
    readonly harness_profile: string; readonly requested_model: string;
    readonly resolved_provider: string | null; readonly resolved_model: string | null;
    readonly observed_provider: string | null; readonly observed_model: string | null; readonly observed_harness_version: string | null;
  } | null;
}

export interface EvaluateAttemptOptions {
  readonly evidence: AttemptEvidenceV2;
  readonly caseKind: 'task' | 'workflow' | 'custom';
  readonly profiles: readonly EvaluatorProfile[];
  readonly composition: EvaluationComposition;
  readonly deterministicEvaluators: Readonly<Record<string, DeterministicEvaluator>>;
  readonly judgeAdapters: Readonly<Record<string, HarnessAdapter>>;
  readonly customParsers?: Readonly<Record<string, CustomOutputParser>>;
  readonly intentRoot: string;
  readonly cwd: string;
  readonly existingRecords?: readonly RichEvaluationRecord[];
}

export interface EvaluationPipelineResult {
  readonly records: readonly RichEvaluationRecord[];
  readonly quality: 'resolved' | 'unresolved' | 'unknown';
  readonly validity: 'valid' | 'invalid';
  readonly required_gate_failures: readonly string[];
  readonly candidate_identity: AttemptEvidenceV2['identity'];
  readonly raw_outputs: Readonly<Record<string, string>>;
}

interface ResolvedText { readonly text: string; readonly hash: `sha256:${string}`; readonly source: 'inline' | 'file' }

function assertProfile(profile: EvaluatorProfile): void {
  if (!profile.profileId.trim() || !profile.profileVersion.trim() || !Number.isSafeInteger(profile.generation) || profile.generation < 1) throw new Error('evaluator profile identity is invalid');
  if (profile.kind === 'deterministic' && profile.timeoutMs !== undefined
      && (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1)) throw new Error('deterministic timeout must be a positive integer');
  if (profile.kind === 'llm_judge') {
    if (!profile.harnessProfile.trim() || !profile.requestedModel.trim() || !Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1
        || !Number.isSafeInteger(profile.repetitions) || profile.repetitions < 1 || profile.repetitions > 25
        || !Number.isSafeInteger(profile.maxEvidenceBytes) || profile.maxEvidenceBytes < 64) throw new Error(`judge profile is invalid: ${profile.profileId}`);
  }
}

async function resolveText(binding: TextBinding): Promise<ResolvedText> {
  if ('inline' in binding) return { text: binding.inline, hash: `sha256:${sha256Hex(binding.inline)}`, source: 'inline' };
  const bytes = await readFile(binding.file);
  const actual = `sha256:${sha256Hex(bytes)}` as const;
  if (actual !== binding.sha256) throw new Error(`file-backed evaluator text hash mismatch: ${binding.file}`);
  return { text: bytes.toString('utf8'), hash: actual, source: 'file' };
}

function selectPath(value: unknown, dotted: string): unknown {
  let current = value;
  for (const part of dotted.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? null;
}

function boundedUtf8(value: string, maximum: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum) return value;
  return `${bytes.subarray(0, Math.max(0, maximum - 24)).toString('utf8')}\n[TRUNCATED BY POLICY]`;
}

function retainedOutput(raw: string): { readonly raw_output: string; readonly raw_output_hash: `sha256:${string}` } {
  const raw_output = boundedUtf8(raw, 1024 * 1024);
  return { raw_output, raw_output_hash: canonicalHash(raw_output) };
}

function redactEvidence(evidence: AttemptEvidenceV2, profile: LlmJudgeProfile): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const field of profile.evidenceFields) selected[field] = selectPath(evidence, field);
  if (profile.identityVisibility === 'blinded') {
    for (const key of Object.keys(selected)) if (key === 'identity' || key.startsWith('identity.')) selected[key] = { redacted: true };
  }
  return selected;
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(case_kind|rubric|evidence|reference)\}\}/gu, (_match, key: string) => values[key] ?? '');
}

/** Same declared text identity for dispatched and skipped judges; skipping never reads files. */
export function evaluatorProfileHash(profile: EvaluatorProfile): `sha256:${string}` {
  if (profile.kind !== 'llm_judge') return canonicalHash(profile);
  const binding = (value: TextBinding) => 'inline' in value
    ? { source: 'inline', hash: `sha256:${sha256Hex(value.inline)}` }
    : { source: 'file', hash: value.sha256 };
  return canonicalHash({ ...profile, systemPrompt: binding(profile.systemPrompt),
    promptTemplate: binding(profile.promptTemplate), rubric: binding(profile.rubric) });
}

function normalizeFindings(value: unknown): EvaluationFinding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => {
    if (typeof item === 'string') return { code: 'judge_finding', message: item, severity: 'info' as const };
    if (typeof item === 'object' && item !== null) {
      const candidate = item as Record<string, unknown>;
      return { code: typeof candidate['code'] === 'string' && candidate['code'] ? candidate['code'] : 'judge_finding',
        message: typeof candidate['message'] === 'string' && candidate['message'] ? candidate['message'] : JSON.stringify(item),
        severity: candidate['severity'] === 'warning' || candidate['severity'] === 'error' ? candidate['severity'] : 'info' };
    }
    return { code: 'judge_finding', message: String(item), severity: 'info' as const };
  });
}

function parseOutput(profile: LlmJudgeProfile, output: string, customParsers: Readonly<Record<string, CustomOutputParser>>): {
  quality: 'resolved' | 'unresolved'; findings: EvaluationFinding[];
} {
  if (profile.parser.kind === 'legacy_verdict') {
    const matches = [...output.matchAll(/^\s*VERDICT:\s*(PASS|FAIL)\s*$/gimu)];
    if (matches.length !== 1) throw new Error('legacy verdict output must contain exactly one VERDICT: PASS|FAIL line');
    return { quality: matches[0]![1]!.toUpperCase() === 'PASS' ? 'resolved' : 'unresolved', findings: [] };
  }
  if (profile.parser.kind === 'custom') {
    const parser = profile.parser.parserId === undefined ? undefined : customParsers[profile.parser.parserId];
    if (parser === undefined) throw new Error(`custom judge parser is unavailable: ${profile.parser.parserId ?? '(missing)'}`);
    const parsed = parser(output); return { quality: parsed.quality, findings: [...(parsed.findings ?? [])] };
  }
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error('strict JSON judge output is malformed'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('strict JSON judge output must be an object');
  const candidate = value as Record<string, unknown>;
  if (candidate['verdict'] !== 'pass' && candidate['verdict'] !== 'fail') throw new Error('strict JSON judge verdict must be pass or fail');
  return { quality: candidate['verdict'] === 'pass' ? 'resolved' : 'unresolved', findings: normalizeFindings(candidate['findings']) };
}

function richRecord(core: Omit<RichEvaluationRecord, 'evaluation_id'>): RichEvaluationRecord {
  const evaluationId = canonicalHash(core);
  return Object.freeze(EvaluationRecordV2Schema.parse({ ...core, evaluation_id: evaluationId }) as RichEvaluationRecord);
}

async function deterministicRecord(profile: DeterministicEvaluatorProfile | ImportedEvaluatorProfile, evidence: AttemptEvidenceV2,
  runner: DeterministicEvaluator): Promise<{ record: RichEvaluationRecord; raw: string }> {
  const started = Date.now();
  try {
    const result: unknown = await runner(evidence);
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('deterministic evaluator output must be an object');
    const candidate = result as Record<string, unknown>;
    if (typeof candidate['passed'] !== 'boolean') throw new Error('deterministic evaluator output passed must be boolean');
    if (typeof candidate['rawOutput'] !== 'string') throw new Error('deterministic evaluator output rawOutput must be a string');
    if (!Array.isArray(candidate['findings']) || candidate['findings'].some((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return true;
      const finding = item as Record<string, unknown>;
      return typeof finding['code'] !== 'string' || !finding['code'] || typeof finding['message'] !== 'string' || !finding['message']
        || !['info', 'warning', 'error'].includes(String(finding['severity']));
    })) throw new Error('deterministic evaluator output findings are malformed');
    if (candidate['runtimeMs'] !== undefined && (!Number.isSafeInteger(candidate['runtimeMs']) || (candidate['runtimeMs'] as number) < 0)) {
      throw new Error('deterministic evaluator output runtimeMs is malformed');
    }
    const validated = candidate as unknown as DeterministicEvaluatorResult; const raw = validated.rawOutput;
    const profileHash = evaluatorProfileHash(profile);
    return { raw, record: richRecord({ schema_version: 'yylo_benchmark_evaluation_record.v2', yylo_version: evidence.yylo_version,
      attempt_id: evidence.attempt_id, evidence_hash: evidence.evidence_hash, evaluator_profile_id: profile.profileId,
      evaluator_generation: profile.generation, evaluator_kind: profile.kind, validity: 'valid', quality: validated.passed ? 'resolved' : 'unresolved',
      required_gate: profile.required, findings: [...validated.findings], cost: { completeness: 'not_applicable', usd: null },
      runtime_ms: validated.runtimeMs ?? Math.max(0, Date.now() - started), provenance_hash: canonicalHash({ profile_hash: profileHash, evidence_hash: evidence.evidence_hash }),
      profile_hash: profileHash, prompt_hash: null, rubric_hash: null, ...retainedOutput(raw), evaluator_session_ids: [], evaluator_identity: null }) };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error); const profileHash = evaluatorProfileHash(profile);
    return { raw, record: richRecord({ schema_version: 'yylo_benchmark_evaluation_record.v2', yylo_version: evidence.yylo_version,
      attempt_id: evidence.attempt_id, evidence_hash: evidence.evidence_hash, evaluator_profile_id: profile.profileId,
      evaluator_generation: profile.generation, evaluator_kind: profile.kind, validity: 'invalid', quality: 'unknown', required_gate: profile.required,
      findings: [{ code: 'evaluator_failure', message: raw || 'deterministic evaluator failed', severity: 'error' }], cost: { completeness: 'not_applicable', usd: null },
      runtime_ms: Math.max(0, Date.now() - started), provenance_hash: canonicalHash({ profile_hash: profileHash, evidence_hash: evidence.evidence_hash, error: raw }),
      profile_hash: profileHash, prompt_hash: null, rubric_hash: null, ...retainedOutput(raw), evaluator_session_ids: [], evaluator_identity: null }) };
  }
}

function evaluatorIdentity(profile: LlmJudgeProfile, terminal: HarnessTerminalV2): RichEvaluationRecord['evaluator_identity'] {
  return { harness_profile: terminal.harness_profile, requested_model: profile.requestedModel,
    resolved_provider: terminal.resolved_provider, resolved_model: terminal.resolved_model,
    observed_provider: terminal.observed_provider, observed_model: terminal.observed_model,
    observed_harness_version: terminal.observed_harness_version };
}

function invalidJudgeRecord(profile: LlmJudgeProfile, evidence: AttemptEvidenceV2, terminal: HarnessTerminalV2 | null,
  profileHash: `sha256:${string}`, promptHash: `sha256:${string}`, rubricHash: `sha256:${string}`, raw: string,
  code: string, message: string, started: number): RichEvaluationRecord {
  return richRecord({ schema_version: 'yylo_benchmark_evaluation_record.v2', yylo_version: evidence.yylo_version,
    attempt_id: evidence.attempt_id, evidence_hash: evidence.evidence_hash, evaluator_profile_id: profile.profileId,
    evaluator_generation: profile.generation, evaluator_kind: 'llm_judge', validity: 'invalid', quality: 'unknown', required_gate: profile.required,
    findings: [{ code, message, severity: 'error' }], cost: terminal?.cost ?? { completeness: 'unavailable', usd: null },
    runtime_ms: terminal?.runtime_ms ?? Math.max(0, Date.now() - started), provenance_hash: canonicalHash({ profile_hash: profileHash, terminal_hash: terminal?.terminal_hash ?? null, code }),
    profile_hash: profileHash, prompt_hash: promptHash, rubric_hash: rubricHash, ...retainedOutput(raw),
    evaluator_session_ids: terminal?.session_id === null || terminal === null ? [] : [terminal.session_id],
    evaluator_identity: terminal === null ? null : evaluatorIdentity(profile, terminal) });
}

async function judgeRecord(profile: LlmJudgeProfile, options: EvaluateAttemptOptions): Promise<{ record: RichEvaluationRecord; raw: string }> {
  const started = Date.now();
  const system = await resolveText(profile.systemPrompt); const promptTemplate = await resolveText(profile.promptTemplate); const rubric = await resolveText(profile.rubric);
  const profileHash = evaluatorProfileHash(profile);
  const packet = redactEvidence(options.evidence, profile);
  const packetJson = boundedUtf8(JSON.stringify(packet), profile.maxEvidenceBytes);
  const prompt = `${system.text}\n\n${render(promptTemplate.text, { case_kind: options.caseKind, rubric: rubric.text, evidence: packetJson,
    reference: profile.reference === undefined ? '' : JSON.stringify(profile.reference) })}`;
  const promptHash = canonicalHash(prompt);
  if (profile.identityVisibility === 'blinded') {
    const secrets = [options.evidence.identity.requested_model, options.evidence.identity.resolved_provider,
      options.evidence.identity.resolved_model, options.evidence.identity.observed_provider, options.evidence.identity.observed_model].filter((item): item is string => item !== null);
    if (secrets.some((secret) => secret.length > 2 && prompt.includes(secret))) {
      const record = invalidJudgeRecord(profile, options.evidence, null, profileHash, promptHash, rubric.hash, prompt, 'privacy_failure', 'blinded judge packet contains candidate identity', started);
      return { record, raw: prompt };
    }
  }
  const adapter = options.judgeAdapters[profile.harnessProfile];
  if (adapter === undefined) {
    const record = invalidJudgeRecord(profile, options.evidence, null, profileHash, promptHash, rubric.hash, '', 'harness_failure', `judge harness is unavailable: ${profile.harnessProfile}`, started);
    return { record, raw: '' };
  }
  const qualities: Array<'resolved' | 'unresolved'> = []; const findings: EvaluationFinding[] = []; const terminals: HarnessTerminalV2[] = []; const outputs: string[] = [];
  for (let repetition = 1; repetition <= profile.repetitions; repetition += 1) {
    const evaluatorAttempt = canonicalHash({ evidence_hash: options.evidence.evidence_hash, profile_hash: profileHash, generation: profile.generation, repetition });
    let terminal: HarnessTerminalV2;
    try {
      terminal = await runHarnessAttempt({ attemptId: evaluatorAttempt, requestedModel: profile.requestedModel, cwd: options.cwd,
        environment: { PATH: process.env.PATH }, timeoutMs: profile.timeoutMs,
        invocation: { kind: 'evaluator', mode: profile.mode, prompt, prompt_hash: promptHash, rubric_hash: rubric.hash, settings: profile.settings,
          timeout_ms: profile.timeoutMs, repetition }, intentRoot: options.intentRoot, adapter });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { raw: outputs.join('\n--- repetition ---\n'), record: invalidJudgeRecord(profile, options.evidence, null, profileHash, promptHash, rubric.hash,
        message, 'harness_failure', message || 'judge harness failed', started) };
    }
    terminals.push(terminal); const raw = terminal.raw_output ?? ''; outputs.push(raw);
    const invalidDiagnostic = terminal.diagnostics.find((item) => ['missing_identity', 'identity_mismatch', 'missing_session', 'invalid_timing'].includes(item.code));
    if (terminal.terminal_status === 'timeout') {
      return { raw: outputs.join('\n--- repetition ---\n'), record: invalidJudgeRecord(profile, options.evidence, terminal, profileHash, promptHash, rubric.hash, raw, 'evaluator_timeout', 'judge timed out', started) };
    }
    if (invalidDiagnostic !== undefined || terminal.validity === 'invalid') {
      const code = invalidDiagnostic?.code ?? 'harness_failure';
      return { raw: outputs.join('\n--- repetition ---\n'), record: invalidJudgeRecord(profile, options.evidence, terminal, profileHash, promptHash, rubric.hash, raw, code, invalidDiagnostic?.message ?? 'judge harness returned invalid evidence', started) };
    }
    if (terminal.terminal_status !== 'success') {
      return { raw: outputs.join('\n--- repetition ---\n'), record: invalidJudgeRecord(profile, options.evidence, terminal, profileHash, promptHash, rubric.hash, raw, 'harness_failure', `judge terminal status is ${terminal.terminal_status}`, started) };
    }
    try { const parsed = parseOutput(profile, raw, options.customParsers ?? {}); qualities.push(parsed.quality); findings.push(...parsed.findings); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { raw: outputs.join('\n--- repetition ---\n'), record: invalidJudgeRecord(profile, options.evidence, terminal, profileHash, promptHash, rubric.hash, raw, 'malformed_output', message, started) };
    }
  }
  const passes = qualities.filter((item) => item === 'resolved').length;
  const quality = profile.aggregation === 'all' ? (passes === qualities.length ? 'resolved' : 'unresolved')
    : profile.aggregation === 'any' ? (passes > 0 ? 'resolved' : 'unresolved') : (passes > qualities.length / 2 ? 'resolved' : 'unresolved');
  const raw = outputs.join('\n--- repetition ---\n'); const terminal = terminals.at(-1)!;
  const totalCost: CostEvidence = terminals.every((item) => item.cost.completeness === 'complete')
    ? { completeness: 'complete', usd: terminals.reduce((sum, item) => sum + (item.cost.usd ?? 0), 0) }
    : terminals.some((item) => item.cost.usd !== null)
      ? { completeness: 'partial', usd: terminals.reduce((sum, item) => sum + (item.cost.usd ?? 0), 0) }
      : { completeness: 'unavailable', usd: null };
  CostEvidenceSchema.parse(totalCost);
  return { raw, record: richRecord({ schema_version: 'yylo_benchmark_evaluation_record.v2', yylo_version: options.evidence.yylo_version,
    attempt_id: options.evidence.attempt_id, evidence_hash: options.evidence.evidence_hash, evaluator_profile_id: profile.profileId,
    evaluator_generation: profile.generation, evaluator_kind: 'llm_judge', validity: 'valid', quality, required_gate: profile.required,
    findings, cost: totalCost, runtime_ms: terminals.reduce((sum, item) => sum + (item.runtime_ms ?? 0), 0),
    provenance_hash: canonicalHash({ profile_hash: profileHash, terminal_hashes: terminals.map((item) => item.terminal_hash) }), profile_hash: profileHash,
    prompt_hash: promptHash, rubric_hash: rubric.hash, ...retainedOutput(raw),
    evaluator_session_ids: terminals.map((item) => item.session_id).filter((item): item is string => item !== null),
    evaluator_identity: evaluatorIdentity(profile, terminal) }) };
}

function selectedProfiles(profiles: readonly EvaluatorProfile[], composition: EvaluationComposition): EvaluatorProfile[] {
  if (composition.kind === 'deterministic_only') return profiles.filter((item) => item.kind === 'deterministic');
  if (composition.kind === 'judge_only') return profiles.filter((item) => item.kind === 'llm_judge');
  if (composition.kind === 'explicit') {
    const selected = new Set(composition.profileIds); const result = profiles.filter((item) => selected.has(item.profileId));
    if (result.length !== selected.size) throw new Error('explicit evaluator policy names an unavailable profile');
    return result;
  }
  return [...profiles];
}

function derive(records: readonly RichEvaluationRecord[], profiles: readonly EvaluatorProfile[], composition: EvaluationComposition,
  candidateValid: boolean): {
  quality: EvaluationPipelineResult['quality']; validity: EvaluationPipelineResult['validity']; gateFailures: string[];
} {
  const profileByGeneration = new Map(profiles.map((profile) => [`${profile.profileId}\u0000${profile.generation}`, profile]));
  const latest = new Map<string, RichEvaluationRecord>();
  for (const record of records) {
    const prior = latest.get(record.evaluator_profile_id);
    if (prior === undefined || record.evaluator_generation > prior.evaluator_generation) latest.set(record.evaluator_profile_id, record);
  }
  const applicable = [...latest.values()].sort((left, right) => left.evaluator_profile_id.localeCompare(right.evaluator_profile_id));
  const gates = [...new Set(records.filter((record) => {
    const profile = profileByGeneration.get(`${record.evaluator_profile_id}\u0000${record.evaluator_generation}`)
      ?? profiles.find((item) => item.profileId === record.evaluator_profile_id);
    return profile?.kind === 'deterministic' && profile.required && profile.correctnessGate === true
      && record.validity === 'valid' && record.quality === 'unresolved';
  }).map((item) => item.evaluator_profile_id))].sort();
  if (!candidateValid) return { quality: 'unknown', validity: 'invalid', gateFailures: [] };
  const validity = applicable.every((item) => item.validity === 'valid') ? 'valid' as const : 'invalid' as const;
  if (gates.length > 0) return { quality: 'unresolved', validity, gateFailures: gates };
  const required = applicable.filter((item) => item.required_gate);
  if (required.some((item) => item.validity === 'invalid')) return { quality: 'unknown', validity: 'invalid', gateFailures: [] };
  const resolved = required.filter((item) => item.quality === 'resolved').length;
  const quality = composition.kind === 'explicit' && composition.aggregation === 'any'
    ? (resolved > 0 ? 'resolved' : 'unresolved') : (required.length > 0 && resolved === required.length ? 'resolved' : 'unresolved');
  return { quality, validity, gateFailures: [] };
}

export async function evaluateAttempt(options: EvaluateAttemptOptions): Promise<EvaluationPipelineResult> {
  const evidence = AttemptEvidenceV2Schema.parse(options.evidence);
  const profiles = selectedProfiles(options.profiles, options.composition); profiles.forEach(assertProfile);
  const keys = new Set<string>();
  for (const profile of profiles) {
    const key = `${profile.profileId}\u0000${profile.generation}`;
    if (keys.has(key)) throw new Error('evaluator profile/generation must be unique'); keys.add(key);
    const previous = (options.existingRecords ?? []).filter((item) => item.evaluator_profile_id === profile.profileId);
    if (previous.some((item) => item.evaluator_generation === profile.generation)) throw new Error('evaluation generation is append-only and already exists');
    if (previous.length > 0 && profile.generation <= Math.max(...previous.map((item) => item.evaluator_generation))) throw new Error('new evaluation generation must increase monotonically');
  }
  const added: RichEvaluationRecord[] = []; const rawOutputs: Record<string, string> = {};
  // Materialize deterministic prerequisites before judges, even when config lists a judge first.
  const ordered = [...profiles.filter((item) => item.kind !== 'llm_judge'), ...profiles.filter((item) => item.kind === 'llm_judge')];
  for (const profile of ordered) {
    let outcome: { record: RichEvaluationRecord; raw: string };
    if (profile.kind === 'llm_judge') {
      const invalidCandidate = evidence.candidate.validity !== 'valid' || evidence.candidate.status !== 'success';
      const invalidPrerequisite = added.some((item) => item.required_gate && item.validity === 'invalid');
      if ((invalidCandidate || invalidPrerequisite) && profile.settings['diagnostic_on_invalid'] !== true) {
        const raw = invalidCandidate ? 'judge not dispatched: candidate execution is unavailable or unsuccessful'
          : 'judge not dispatched: required deterministic evidence is invalid or unavailable';
        const profileHash = evaluatorProfileHash(profile);
        outcome = { raw, record: richRecord({ schema_version: 'yylo_benchmark_evaluation_record.v2', yylo_version: evidence.yylo_version,
          attempt_id: evidence.attempt_id, evidence_hash: evidence.evidence_hash, evaluator_profile_id: profile.profileId,
          evaluator_generation: profile.generation, evaluator_kind: 'llm_judge', validity: 'invalid', quality: 'unknown', required_gate: profile.required,
          findings: [{ code: 'judge_not_dispatched', message: raw, severity: 'warning' }], cost: { completeness: 'not_applicable', usd: null },
          runtime_ms: 0, provenance_hash: canonicalHash({ profile_hash: profileHash, evidence_hash: evidence.evidence_hash,
            prerequisite_ids: added.map((item) => item.evaluation_id), reason: raw }),
          profile_hash: profileHash, prompt_hash: null, rubric_hash: null, ...retainedOutput(raw), evaluator_session_ids: [], evaluator_identity: null }) };
      } else outcome = await judgeRecord(profile, { ...options, evidence });
    } else {
      const runner = options.deterministicEvaluators[profile.profileId];
      if (runner === undefined) {
        outcome = await deterministicRecord(profile, evidence, async () => { throw new Error(`evaluator implementation is unavailable: ${profile.profileId}`); });
      } else outcome = await deterministicRecord(profile, evidence, runner);
    }
    added.push(outcome.record); rawOutputs[`${profile.profileId}:${profile.generation}`] = outcome.raw;
  }
  const current = Object.freeze(added); const records = Object.freeze([...(options.existingRecords ?? []), ...current]);
  const derived = derive(records, options.profiles, options.composition,
    evidence.candidate.validity === 'valid' && evidence.candidate.status !== 'invalid');
  return Object.freeze({ records, quality: derived.quality, validity: derived.validity,
    required_gate_failures: Object.freeze(derived.gateFailures), candidate_identity: evidence.identity, raw_outputs: Object.freeze(rawOutputs) });
}

export async function reevaluateAttempt(options: EvaluateAttemptOptions & { readonly existingRecords: readonly RichEvaluationRecord[] }): Promise<EvaluationPipelineResult> {
  const frozenSnapshot = JSON.stringify(options.existingRecords);
  const result = await evaluateAttempt(options);
  if (JSON.stringify(options.existingRecords) !== frozenSnapshot) throw new Error('existing evaluation records were mutated');
  return result;
}
