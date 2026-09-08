import { canonicalHash, canonicalJson, sha256Hex } from '../contracts/canonical.js';
import { CostEvidenceSchema, type CostEvidence } from '../contracts/schemas.js';
import { PersistentTypedResourceLocks } from '../execution/resource-lock.js';
import { ImmutableArtifactRegistry, type ArtifactReference, type ManifestEntry } from '../registry/index.js';
import type { WorkflowExecutionPlan } from './plan.js';

export const WORKFLOW_CANDIDATE_TRUTH_SCHEMA_VERSION = 'juno_benchmark_workflow_candidate_truth.v1' as const;
export const WORKFLOW_EVIDENCE_RECEIPT_SCHEMA_VERSION = 'juno_benchmark_workflow_evidence_receipt.v3' as const;
export const WORKFLOW_JUDGEMENT_SCHEMA_VERSION = 'juno_benchmark_workflow_judgement.v2' as const;
export const GOVERNED_JUDGE_ENVELOPE_SCHEMA_VERSION = 'juno_benchmark_governed_judge_envelope.v1' as const;
export const BLINDED_JUDGE_PACKET_SCHEMA_VERSION = 'juno_benchmark_blinded_judge_packet.v2' as const;
export const WORKFLOW_REJUDGE_RECEIPT_SCHEMA_VERSION = 'juno_benchmark_workflow_rejudge_receipt.v2' as const;
export const WORKFLOW_REPORT_SCHEMA_VERSION = 'juno_benchmark_workflow_report.v2' as const;

export type Hash = `sha256:${string}`;
export type JudgeTerminalClass = 'judge_acceptance' | 'judge_rejection' | 'judge_harness_failure' | 'judge_invalid_evidence' | 'judge_timeout';
export type GovernedWorkflowTerminalClass = 'resolved' | 'candidate_failure' | 'harness_invalid' | Exclude<JudgeTerminalClass, 'judge_acceptance'>;

export interface WorkflowCandidateEvidence {
  readonly outer_session_id: string; readonly nested_session_ids: readonly string[];
  readonly started_at: string; readonly ended_at: string; readonly runtime_ms: number; readonly cost: CostEvidence;
  readonly candidate_outcome: { readonly status: 'success' | 'failure' };
  readonly harness_validity: { readonly status: 'valid' | 'invalid'; readonly reason: string | null };
  readonly transcript: string; readonly candidate_response?: string; readonly artifacts: Readonly<Record<string, string>>;
}
export interface GovernedJudgeExecutionEnvelope {
  readonly schema_version: typeof GOVERNED_JUDGE_ENVELOPE_SCHEMA_VERSION;
  readonly judge_dispatch_id: Hash;
  readonly requested: { readonly provider: string; readonly model: string; readonly juno_version: string };
  readonly observed: { readonly provider: string | null; readonly model: string | null; readonly juno_version: string | null };
  readonly session_id: string | null;
  readonly started_at: string; readonly ended_at: string; readonly runtime_ms: number;
  readonly cost: CostEvidence; readonly exit_status: { readonly code: number | null; readonly signal: string | null };
  readonly dispatched: boolean; readonly dispatch_proof: 'terminal' | 'proven_not_dispatched' | 'ambiguous';
  readonly verdict: 'pass' | 'fail' | null; readonly justification: string;
  readonly terminal_class: JudgeTerminalClass;
}
export type GovernedWorkflowJudgeRunner = (input: {
  readonly judge: WorkflowExecutionPlan['policy']['judge']; readonly scoring_id: string; readonly blinded_candidate: string;
  readonly judge_dispatch_id: Hash; readonly requested_juno_version: string;
}) => Promise<GovernedJudgeExecutionEnvelope>;

export interface WorkflowJudgement {
  readonly schema_version: typeof WORKFLOW_JUDGEMENT_SCHEMA_VERSION;
  readonly judgement_id: Hash; readonly candidate_truth_hash: Hash; readonly scoring_id: string;
  readonly judge: WorkflowExecutionPlan['policy']['judge']; readonly judge_policy_hash: Hash; readonly generation: number;
  readonly valid: boolean; readonly verdict: 'pass' | 'fail' | null; readonly resolved: boolean | null;
  readonly terminal_class: JudgeTerminalClass; readonly packet_hash: Hash; readonly packet_ref: ArtifactReference;
  readonly envelope_hash: Hash; readonly envelope_ref: ArtifactReference;
  readonly justification_hash: Hash; readonly justification_ref: ArtifactReference;
}
export interface WorkflowEvidenceReceipt {
  readonly schema_version: typeof WORKFLOW_EVIDENCE_RECEIPT_SCHEMA_VERSION;
  readonly plan_id: Hash; readonly policy_semantics_sha256: Hash; readonly dispatch_id: Hash; readonly invocation_hash: Hash;
  readonly model: string; readonly attempt: number; readonly step_id: string; readonly scoring_id: string;
  readonly identity: { readonly requested_selector: string; readonly requested_provider: string; readonly requested_model: string;
    readonly observed_provider: string; readonly observed_model: string; readonly requested_juno_version: string; readonly observed_juno_version: string };
  readonly sessions: { readonly outer_session_id: string; readonly nested_session_ids: readonly string[] };
  readonly runtime: { readonly started_at: string; readonly ended_at: string; readonly runtime_ms: number }; readonly cost: CostEvidence;
  readonly candidate_outcome: { readonly status: 'success' | 'failure' };
  readonly harness_validity: { readonly status: 'valid' | 'invalid'; readonly reason: string | null };
  readonly judge_outcome: WorkflowJudgement;
  readonly dispatch_recovery: { readonly recovered: boolean; readonly dispatch_count: 1; readonly recovery_count: number; readonly runner_run_id: string; readonly effect: 'none' | 'completed' };
  readonly evidence_ref: ArtifactReference; readonly artifacts_ref: ArtifactReference; readonly candidate_truth_ref: ArtifactReference; readonly candidate_truth_hash: Hash;
  readonly redaction: { readonly patterns: number; readonly replacements: number; readonly clean: true; readonly retained_prompt: boolean; readonly evidence_hash: Hash };
  readonly terminal_class: GovernedWorkflowTerminalClass; readonly receipt_hash: Hash;
  /** In-memory projection of immutable v2 evidence; never persisted or rewritten. */
  readonly legacy?: true;
}

interface CandidateTruth { readonly schema_version: typeof WORKFLOW_CANDIDATE_TRUTH_SCHEMA_VERSION; readonly plan_id: Hash; readonly dispatch_id: Hash;
  readonly invocation_hash: Hash; readonly step_id: string; readonly scoring_id: string; readonly candidate_outcome: WorkflowEvidenceReceipt['candidate_outcome'];
  readonly harness_validity: WorkflowEvidenceReceipt['harness_validity']; readonly evidence_ref: ArtifactReference; readonly artifacts_ref: ArtifactReference }
interface BlindedPacket { readonly schema_version: typeof BLINDED_JUDGE_PACKET_SCHEMA_VERSION; readonly scoring_id: string; readonly candidate_truth_hash: Hash;
  readonly task: { readonly schema_version: 'juno_benchmark_task_requirements.v1'; readonly content: string; readonly sha256: Hash };
  readonly rubric: { readonly schema_version: 'juno_benchmark_judge_rubric.v1'; readonly content: string; readonly sha256: Hash };
  readonly deterministic_evidence: { readonly candidate_outcome: WorkflowEvidenceReceipt['candidate_outcome']; readonly harness_validity: WorkflowEvidenceReceipt['harness_validity'] };
  readonly transcript: string; readonly artifacts: readonly { readonly name: string; readonly content: string; readonly sha256: Hash }[] }

function assertHash(value: string, label: string): asserts value is Hash { if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a canonical SHA-256`); }
function object(value: unknown, label: string): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
async function append(registry: ImmutableArtifactRegistry, experimentId: string, role: string, value: unknown): Promise<ArtifactReference> {
  const reference = await registry.put(role, `${canonicalJson(value)}\n`); const entries = await registry.verifyExperiment(experimentId);
  if (!entries.some((entry) => entry.role === role && entry.sha256 === reference.sha256)) await registry.append(experimentId, reference); return reference;
}
async function readJson(registry: ImmutableArtifactRegistry, entry: ArtifactReference): Promise<unknown> { return JSON.parse((await registry.read(entry)).toString('utf8')) as unknown; }
function patterns(values: readonly string[]): RegExp[] { return [...new Set(values)].map((value) => { try { return new RegExp(value, 'gu'); } catch { throw new Error(`invalid workflow redaction pattern: ${value}`); } }); }
function redact(text: string, configured: readonly RegExp[], count: { value: number }): string { let result = text; for (const pattern of configured) result = result.replace(pattern, () => { count.value += 1; return '[REDACTED]'; }); return result; }
function validTime(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function validateEvidence(evidence: WorkflowCandidateEvidence): void {
  if (!evidence.outer_session_id.trim() || evidence.nested_session_ids.length === 0 || evidence.nested_session_ids.some((id) => !id.trim()) || new Set(evidence.nested_session_ids).size !== evidence.nested_session_ids.length) throw new Error('workflow session identity is incomplete');
  if (!Number.isInteger(evidence.runtime_ms) || evidence.runtime_ms < 0 || !validTime(evidence.started_at) || !validTime(evidence.ended_at) || Date.parse(evidence.ended_at) < Date.parse(evidence.started_at)) throw new Error('workflow runtime evidence is invalid');
  CostEvidenceSchema.parse(evidence.cost); if ((evidence.harness_validity.status === 'valid') !== (evidence.harness_validity.reason === null)) throw new Error('workflow harness validity/reason is inconsistent');
}
function splitIdentity(exact: string): { provider: string; model: string } { const separator = exact.indexOf('/'); return separator < 1 ? { provider: '', model: exact } : { provider: exact.slice(0, separator), model: exact.slice(separator + 1) }; }
function scanBlindness(text: string, prohibited: readonly string[]): void { for (const value of prohibited.filter((item) => item.trim().length >= 3)) if (text.includes(value)) throw new Error('workflow blinded judge evidence contains candidate model/provider identity'); }
function classifyEnvelope(value: unknown, expected: { dispatchId: Hash; judgeModel: string; junoVersion: string }): GovernedJudgeExecutionEnvelope {
  const envelope = object(value, 'governed judge envelope') as unknown as GovernedJudgeExecutionEnvelope;
  if (envelope.schema_version !== GOVERNED_JUDGE_ENVELOPE_SCHEMA_VERSION) throw new Error('governed judge envelope schema is invalid');
  assertHash(envelope.judge_dispatch_id, 'judge_dispatch_id'); if (envelope.judge_dispatch_id !== expected.dispatchId) throw new Error('governed judge dispatch identity drifted');
  const requested = splitIdentity(expected.judgeModel); CostEvidenceSchema.parse(envelope.cost);
  if (!validTime(envelope.started_at) || !validTime(envelope.ended_at) || Date.parse(envelope.ended_at) < Date.parse(envelope.started_at) || !Number.isInteger(envelope.runtime_ms) || envelope.runtime_ms < 0) throw new Error('governed judge runtime evidence is invalid');
  if (envelope.requested.provider !== requested.provider || envelope.requested.model !== requested.model || envelope.requested.juno_version !== expected.junoVersion) throw new Error('governed judge requested identity drifted');
  if (!['judge_acceptance', 'judge_rejection', 'judge_harness_failure', 'judge_invalid_evidence', 'judge_timeout'].includes(envelope.terminal_class)) throw new Error('governed judge terminal class is invalid');
  if (envelope.terminal_class === 'judge_acceptance' || envelope.terminal_class === 'judge_rejection') {
    if (!envelope.dispatched || envelope.dispatch_proof !== 'terminal' || envelope.exit_status.code !== 0 || envelope.exit_status.signal !== null || envelope.observed.provider !== requested.provider || envelope.observed.model !== requested.model || envelope.observed.juno_version !== expected.junoVersion || envelope.session_id === null || envelope.session_id.trim() === '' || envelope.verdict === null || envelope.justification.trim() === '') throw new Error('governed judge valid terminal identity/evidence is incomplete');
    if ((envelope.terminal_class === 'judge_acceptance') !== (envelope.verdict === 'pass')) throw new Error('governed judge verdict and terminal class disagree');
  }
  return envelope;
}
function judgementCore(input: { candidateTruthHash: Hash; scoringId: string; judge: WorkflowExecutionPlan['policy']['judge']; generation: number; valid: boolean;
  verdict: 'pass' | 'fail' | null; terminalClass: JudgeTerminalClass; packetRef: ArtifactReference; envelopeRef: ArtifactReference; justificationRef: ArtifactReference }): Omit<WorkflowJudgement, 'judgement_id'> {
  return { schema_version: WORKFLOW_JUDGEMENT_SCHEMA_VERSION, candidate_truth_hash: input.candidateTruthHash, scoring_id: input.scoringId, judge: input.judge,
    judge_policy_hash: canonicalHash(input.judge), generation: input.generation, valid: input.valid, verdict: input.verdict, resolved: input.valid ? input.verdict === 'pass' : null,
    terminal_class: input.terminalClass, packet_hash: input.packetRef.sha256, packet_ref: input.packetRef, envelope_hash: input.envelopeRef.sha256, envelope_ref: input.envelopeRef,
    justification_hash: input.justificationRef.sha256, justification_ref: input.justificationRef };
}
function validateJudgement(value: unknown): WorkflowJudgement {
  const item = object(value, 'workflow judgement') as unknown as WorkflowJudgement;
  if (item.schema_version !== WORKFLOW_JUDGEMENT_SCHEMA_VERSION) throw new Error('legacy workflow judgement is judge-invalid and requires rejudge');
  for (const [label, hash] of [['judgement_id', item.judgement_id], ['candidate_truth_hash', item.candidate_truth_hash], ['judge_policy_hash', item.judge_policy_hash], ['packet_hash', item.packet_hash], ['envelope_hash', item.envelope_hash], ['justification_hash', item.justification_hash]] as const) assertHash(hash, label);
  const { judgement_id, ...core } = item; const valid = item.terminal_class === 'judge_acceptance' || item.terminal_class === 'judge_rejection';
  if (judgement_id !== canonicalHash(core) || item.judge_policy_hash !== canonicalHash(item.judge) || !Number.isInteger(item.generation) || item.generation < 1 || item.valid !== valid || item.resolved !== (valid ? item.verdict === 'pass' : null)) throw new Error('workflow judgement integrity is invalid');
  return item;
}
function terminalClass(candidate: { candidate_outcome: WorkflowEvidenceReceipt['candidate_outcome']; harness_validity: WorkflowEvidenceReceipt['harness_validity'] }, judgement: WorkflowJudgement): GovernedWorkflowTerminalClass {
  if (candidate.harness_validity.status === 'invalid') return 'harness_invalid'; if (candidate.candidate_outcome.status === 'failure') return 'candidate_failure';
  return judgement.terminal_class === 'judge_acceptance' ? 'resolved' : judgement.terminal_class;
}

export function verifyWorkflowEvidenceReceiptValue(value: unknown): WorkflowEvidenceReceipt {
  const raw = object(value, 'workflow evidence receipt');
  if (raw['schema_version'] === 'juno_benchmark_workflow_evidence_receipt.v2') {
    const legacy = raw as unknown as Omit<WorkflowEvidenceReceipt, 'schema_version' | 'judge_outcome' | 'terminal_class'> & { schema_version: string; terminal_class: string;
      judge_outcome: { schema_version: string; judgement_id: Hash; candidate_truth_hash: Hash; scoring_id: string; judge: WorkflowExecutionPlan['policy']['judge']; judge_policy_hash: Hash; generation: number; resolved: boolean; evidence_hash: Hash } };
    for (const [label, hash] of [['plan_id', legacy.plan_id], ['policy_semantics_sha256', legacy.policy_semantics_sha256], ['dispatch_id', legacy.dispatch_id], ['invocation_hash', legacy.invocation_hash], ['candidate_truth_hash', legacy.candidate_truth_hash], ['receipt_hash', legacy.receipt_hash]] as const) assertHash(hash, label);
    const { receipt_hash, ...legacyCore } = legacy; if (receipt_hash !== canonicalHash(legacyCore)) throw new Error('legacy workflow evidence receipt integrity failed');
    const old = legacy.judge_outcome; const { judgement_id, ...oldCore } = old;
    if (old.schema_version !== 'juno_benchmark_workflow_judgement.v1' || judgement_id !== canonicalHash(oldCore) || old.judge_policy_hash !== canonicalHash(old.judge)) throw new Error('legacy workflow judgement integrity is invalid');
    const dummy = legacy.candidate_truth_ref; const projected: WorkflowJudgement = { schema_version: WORKFLOW_JUDGEMENT_SCHEMA_VERSION, judgement_id, candidate_truth_hash: old.candidate_truth_hash,
      scoring_id: old.scoring_id, judge: old.judge, judge_policy_hash: old.judge_policy_hash, generation: old.generation, valid: false, verdict: null, resolved: null,
      terminal_class: 'judge_invalid_evidence', packet_hash: dummy.sha256, packet_ref: dummy, envelope_hash: dummy.sha256, envelope_ref: dummy, justification_hash: dummy.sha256, justification_ref: dummy };
    return { ...legacy, schema_version: WORKFLOW_EVIDENCE_RECEIPT_SCHEMA_VERSION, judge_outcome: projected,
      terminal_class: legacy.harness_validity.status === 'invalid' ? 'harness_invalid' : legacy.candidate_outcome.status === 'failure' ? 'candidate_failure' : 'judge_invalid_evidence', legacy: true };
  }
  const receipt = raw as unknown as WorkflowEvidenceReceipt;
  if (receipt.schema_version !== WORKFLOW_EVIDENCE_RECEIPT_SCHEMA_VERSION) throw new Error('workflow evidence receipt schema is invalid');
  for (const [label, hash] of [['plan_id', receipt.plan_id], ['policy_semantics_sha256', receipt.policy_semantics_sha256], ['dispatch_id', receipt.dispatch_id], ['invocation_hash', receipt.invocation_hash], ['candidate_truth_hash', receipt.candidate_truth_hash], ['receipt_hash', receipt.receipt_hash]] as const) assertHash(hash, label);
  CostEvidenceSchema.parse(receipt.cost); validateJudgement(receipt.judge_outcome); const { receipt_hash, ...core } = receipt;
  if (receipt_hash !== canonicalHash(core)) throw new Error(`workflow evidence receipt integrity failed for ${receipt.dispatch_id}`);
  if (receipt.judge_outcome.candidate_truth_hash !== receipt.candidate_truth_hash || receipt.judge_outcome.scoring_id !== receipt.scoring_id) throw new Error('workflow evidence judge binding is invalid');
  if (!Number.isInteger(receipt.dispatch_recovery.recovery_count) || receipt.dispatch_recovery.recovery_count < 0 || typeof receipt.dispatch_recovery.recovered !== 'boolean' || (receipt.dispatch_recovery.recovery_count > 0 && !receipt.dispatch_recovery.recovered)) throw new Error('workflow recovery evidence is invalid');
  if (receipt.terminal_class !== terminalClass(receipt, receipt.judge_outcome)) throw new Error('workflow terminal class is inconsistent'); return receipt;
}

export function buildBlindedJudgePacket(plan: WorkflowExecutionPlan, stepId: string, scoringId: string, candidateTruthHash: Hash, transcript: string, artifacts: Readonly<Record<string, string>>, candidate: Pick<WorkflowEvidenceReceipt, 'candidate_outcome' | 'harness_validity'>, rubricOverride?: string): BlindedPacket {
  const policy = plan.policy.steps.find((item) => item.step_id === stepId)!; const rubric = rubricOverride ?? (plan.policy.judge as { rubric?: string }).rubric;
  if (rubric === undefined || rubric.trim() === '' || `sha256:${sha256Hex(Buffer.from(rubric, 'utf8'))}` !== plan.policy.judge.rubric_hash) throw new Error('governed judge rubric bytes are missing or do not match rubric_hash');
  const steps = plan.normalized_workflow['steps']; const task = Array.isArray(steps) ? steps.find((item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>)['id'] === stepId) : undefined;
  if (task === undefined) throw new Error('governed judge task requirement bytes are missing'); const taskContent = canonicalJson(task);
  const required = (policy as { required_artifacts?: readonly string[] }).required_artifacts ?? [];
  if (required.some((name) => artifacts[name] === undefined || artifacts[name] === '')) throw new Error('governed judge required artifact evidence is absent');
  if (Buffer.byteLength(transcript, 'utf8') > 1024 * 1024 || Object.keys(artifacts).length > 64
      || Object.entries(artifacts).some(([name, content]) => Buffer.byteLength(name, 'utf8') > 256 || Buffer.byteLength(content, 'utf8') > 256 * 1024)) {
    throw new Error('governed judge transcript or artifact evidence exceeds the bounded packet limits');
  }
  return { schema_version: BLINDED_JUDGE_PACKET_SCHEMA_VERSION, scoring_id: scoringId, candidate_truth_hash: candidateTruthHash,
    task: { schema_version: 'juno_benchmark_task_requirements.v1', content: taskContent, sha256: canonicalHash(taskContent) },
    rubric: { schema_version: 'juno_benchmark_judge_rubric.v1', content: rubric, sha256: `sha256:${sha256Hex(Buffer.from(rubric, 'utf8'))}` }, deterministic_evidence: candidate,
    transcript, artifacts: Object.entries(artifacts).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => ({ name, content, sha256: canonicalHash(content) })) };
}
async function invalidEnvelope(dispatchId: Hash, judgeModel: string, junoVersion: string, terminal: JudgeTerminalClass, justification: string): Promise<GovernedJudgeExecutionEnvelope> {
  const identity = splitIdentity(judgeModel); const now = new Date().toISOString(); return { schema_version: GOVERNED_JUDGE_ENVELOPE_SCHEMA_VERSION, judge_dispatch_id: dispatchId,
    requested: { provider: identity.provider, model: identity.model, juno_version: junoVersion }, observed: { provider: null, model: null, juno_version: null }, session_id: null,
    started_at: now, ended_at: now, runtime_ms: 0, cost: { completeness: 'unavailable', usd: null }, exit_status: { code: null, signal: null }, dispatched: false,
    dispatch_proof: 'proven_not_dispatched', verdict: null, justification, terminal_class: terminal };
}
async function runJudge(input: { registry: ImmutableArtifactRegistry; experimentId: string; plan: WorkflowExecutionPlan; judge: GovernedWorkflowJudgeRunner; packet: BlindedPacket;
  configured: readonly RegExp[]; replacements: { value: number }; judgeDispatchId: Hash; generation: number; candidateTruthHash: Hash; scoringId: string }): Promise<WorkflowJudgement> {
  const packetRef = await append(input.registry, input.experimentId, 'workflow-judge-packet', input.packet); let envelope: GovernedJudgeExecutionEnvelope;
  try { envelope = classifyEnvelope(await input.judge({ judge: input.plan.policy.judge, scoring_id: input.scoringId, blinded_candidate: canonicalJson(input.packet), judge_dispatch_id: input.judgeDispatchId,
      requested_juno_version: input.plan.runtime_binding.juno_version }), { dispatchId: input.judgeDispatchId, judgeModel: input.plan.policy.judge.model, junoVersion: input.plan.runtime_binding.juno_version }); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); envelope = { ...(await invalidEnvelope(input.judgeDispatchId, input.plan.policy.judge.model, input.plan.runtime_binding.juno_version,
      /timed out|timeout/iu.test(message) ? 'judge_timeout'
        : /identity|session|dispatch|provider|model|exit|nonzero/iu.test(message) ? 'judge_harness_failure'
          : /rubric|task|artifact|redaction|malformed|schema|verdict|evidence/iu.test(message) ? 'judge_invalid_evidence' : 'judge_harness_failure', message)), dispatched: true, dispatch_proof: 'ambiguous' }; }
  let justification = redact(envelope.justification, input.configured, input.replacements);
  try { for (const pattern of input.configured) { pattern.lastIndex = 0; if (pattern.test(justification)) throw new Error('workflow judge justification redaction failed'); }
    scanBlindness(justification, [input.plan.models.join('\0'), ...input.plan.models, ...input.plan.models.flatMap((model) => Object.values(splitIdentity(model)))]); }
  catch (error) { envelope = { ...(await invalidEnvelope(input.judgeDispatchId, input.plan.policy.judge.model, input.plan.runtime_binding.juno_version, 'judge_invalid_evidence', error instanceof Error ? error.message : String(error))), dispatched: envelope.dispatched, dispatch_proof: envelope.dispatch_proof }; justification = envelope.justification; }
  const retainedEnvelope = { ...envelope, justification }; const envelopeRef = await append(input.registry, input.experimentId, 'workflow-judge-envelope', retainedEnvelope);
  const justificationObject = { schema_version: 'juno_benchmark_judge_justification.v1', judge_dispatch_id: input.judgeDispatchId, text: justification };
  const justificationRef = await append(input.registry, input.experimentId, 'workflow-judge-justification', justificationObject);
  const valid = retainedEnvelope.terminal_class === 'judge_acceptance' || retainedEnvelope.terminal_class === 'judge_rejection';
  const core = judgementCore({ candidateTruthHash: input.candidateTruthHash, scoringId: input.scoringId, judge: input.plan.policy.judge, generation: input.generation, valid,
    verdict: valid ? retainedEnvelope.verdict : null, terminalClass: retainedEnvelope.terminal_class, packetRef, envelopeRef, justificationRef });
  const judgement: WorkflowJudgement = { ...core, judgement_id: canonicalHash(core) }; await append(input.registry, input.experimentId, 'workflow-judgement', judgement); return judgement;
}

export async function retainAndGradeWorkflowStep(input: { readonly registry: ImmutableArtifactRegistry; readonly experimentId: string; readonly plan: WorkflowExecutionPlan;
  readonly dispatchId: Hash; readonly invocationHash: Hash; readonly model: string; readonly provider: string; readonly attempt: number; readonly stepId: string;
  readonly observedProvider: string; readonly observedModel: string; readonly observedJunoVersion: string; readonly runnerRunId: string; readonly effect: 'none' | 'completed';
  readonly recoveryCount: number; readonly recovered: boolean; readonly evidence: WorkflowCandidateEvidence; readonly judge: GovernedWorkflowJudgeRunner;
  readonly judgeDispatchId: Hash; readonly beforeJudgeDispatch: () => Promise<void> }): Promise<WorkflowEvidenceReceipt> {
  validateEvidence(input.evidence); if (input.observedProvider !== input.provider || input.observedModel !== input.model || input.observedJunoVersion !== input.plan.runtime_binding.juno_version) throw new Error('workflow observed provider/model/Juno identity is incomplete or mismatched');
  const policy = input.plan.policy.steps.find((item) => item.step_id === input.stepId); if (policy === undefined) throw new Error(`workflow evidence policy missing for ${input.stepId}`);
  const configured = patterns([...input.plan.policy.redaction.secret_patterns, ...policy.redaction.patterns]); const replacements = { value: 0 };
  const transcript = redact(input.evidence.transcript, configured, replacements); const artifacts = Object.fromEntries(Object.entries(input.evidence.artifacts).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, redact(value, configured, replacements)]));
  const retainedText = JSON.stringify({ transcript, artifacts }); for (const pattern of configured) { pattern.lastIndex = 0; if (pattern.test(retainedText)) throw new Error('workflow evidence redaction failed closed'); }
  const evidenceRef = await append(input.registry, input.experimentId, 'workflow-evidence', { transcript }); const artifactsRef = await append(input.registry, input.experimentId, 'workflow-artifacts', artifacts);
  const candidateTruth: CandidateTruth = { schema_version: WORKFLOW_CANDIDATE_TRUTH_SCHEMA_VERSION, plan_id: input.plan.plan_id as Hash, dispatch_id: input.dispatchId, invocation_hash: input.invocationHash,
    step_id: input.stepId, scoring_id: policy.scoring_id, candidate_outcome: input.evidence.candidate_outcome, harness_validity: input.evidence.harness_validity, evidence_ref: evidenceRef, artifacts_ref: artifactsRef };
  const candidateTruthRef = await append(input.registry, input.experimentId, 'workflow-candidate-truth', candidateTruth); const candidateTruthHash = canonicalHash(candidateTruth);
  let packet: BlindedPacket; let packetFailure: Error | null = null;
  try { packet = buildBlindedJudgePacket(input.plan, input.stepId, policy.scoring_id, candidateTruthHash, transcript, artifacts, { candidate_outcome: input.evidence.candidate_outcome, harness_validity: input.evidence.harness_validity });
    scanBlindness(canonicalJson(packet), [...input.plan.models, ...input.plan.models.flatMap((model) => Object.values(splitIdentity(model)))]); }
  catch (error) { packetFailure = error instanceof Error ? error : new Error(String(error)); packet = { schema_version: BLINDED_JUDGE_PACKET_SCHEMA_VERSION, scoring_id: policy.scoring_id, candidate_truth_hash: candidateTruthHash,
      task: { schema_version: 'juno_benchmark_task_requirements.v1', content: '', sha256: canonicalHash('') }, rubric: { schema_version: 'juno_benchmark_judge_rubric.v1', content: '', sha256: canonicalHash('') },
      deterministic_evidence: { candidate_outcome: input.evidence.candidate_outcome, harness_validity: input.evidence.harness_validity }, transcript: '', artifacts: [] }; }
  const eligible = input.evidence.candidate_outcome.status === 'success' && input.evidence.harness_validity.status === 'valid';
  if (eligible) await input.beforeJudgeDispatch();
  const runner = !eligible
    ? async () => invalidEnvelope(input.judgeDispatchId, input.plan.policy.judge.model, input.plan.runtime_binding.juno_version, 'judge_invalid_evidence', 'judge not applicable: candidate execution was not valid')
    : packetFailure === null ? input.judge : async () => invalidEnvelope(input.judgeDispatchId, input.plan.policy.judge.model, input.plan.runtime_binding.juno_version, 'judge_invalid_evidence', packetFailure!.message);
  const judgement = await runJudge({ registry: input.registry, experimentId: input.experimentId, plan: input.plan, judge: runner, packet, configured, replacements, judgeDispatchId: input.judgeDispatchId, generation: 1, candidateTruthHash, scoringId: policy.scoring_id });
  const redactionCore = { patterns: configured.length, replacements: replacements.value, clean: true as const, retained_prompt: input.plan.policy.redaction.retain_prompts && policy.redaction.retain_prompt };
  const core = { schema_version: WORKFLOW_EVIDENCE_RECEIPT_SCHEMA_VERSION, plan_id: input.plan.plan_id as Hash, policy_semantics_sha256: input.plan.policy_semantics_sha256 as Hash,
    dispatch_id: input.dispatchId, invocation_hash: input.invocationHash, model: input.model, attempt: input.attempt, step_id: input.stepId, scoring_id: policy.scoring_id,
    identity: { requested_selector: input.plan.model_selectors[input.model]!, requested_provider: input.provider, requested_model: input.model, observed_provider: input.observedProvider, observed_model: input.observedModel,
      requested_juno_version: input.plan.runtime_binding.juno_version, observed_juno_version: input.observedJunoVersion }, sessions: { outer_session_id: input.evidence.outer_session_id, nested_session_ids: input.evidence.nested_session_ids },
    runtime: { started_at: input.evidence.started_at, ended_at: input.evidence.ended_at, runtime_ms: input.evidence.runtime_ms }, cost: input.evidence.cost, candidate_outcome: input.evidence.candidate_outcome,
    harness_validity: input.evidence.harness_validity, judge_outcome: judgement, dispatch_recovery: { recovered: input.recovered, dispatch_count: 1 as const, recovery_count: input.recoveryCount, runner_run_id: input.runnerRunId, effect: input.effect },
    evidence_ref: evidenceRef, artifacts_ref: artifactsRef, candidate_truth_ref: candidateTruthRef, candidate_truth_hash: candidateTruthHash,
    redaction: { ...redactionCore, evidence_hash: canonicalHash(redactionCore) }, terminal_class: terminalClass(input.evidence, judgement) };
  const receipt: WorkflowEvidenceReceipt = { ...core, receipt_hash: canonicalHash(core) }; await append(input.registry, input.experimentId, 'workflow-evidence-receipt', receipt); return verifyWorkflowEvidenceReceiptValue(receipt);
}

interface RejudgeReceipt { readonly schema_version: typeof WORKFLOW_REJUDGE_RECEIPT_SCHEMA_VERSION; readonly source_receipt_hash: Hash; readonly candidate_truth_hash: Hash; readonly prior_judgement_id: Hash; readonly judgement: WorkflowJudgement; readonly integrity_hash: Hash }
function validateRejudgeReceipt(value: unknown): RejudgeReceipt { const receipt = object(value, 'workflow rejudge receipt') as unknown as RejudgeReceipt; if (receipt.schema_version !== WORKFLOW_REJUDGE_RECEIPT_SCHEMA_VERSION) throw new Error('legacy workflow rejudge receipt is judge-invalid');
  const judgement = validateJudgement(receipt.judgement); const { integrity_hash, ...core } = receipt; if (integrity_hash !== canonicalHash(core) || judgement.candidate_truth_hash !== receipt.candidate_truth_hash) throw new Error('workflow rejudge receipt integrity is invalid'); return receipt; }
async function rejudgeHistory(registry: ImmutableArtifactRegistry, experimentId: string, receipt: WorkflowEvidenceReceipt): Promise<readonly RejudgeReceipt[]> { const history: RejudgeReceipt[] = [];
  for (const entry of (await registry.verifyExperiment(experimentId)).filter((item) => item.role === 'workflow-rejudge-receipt')) { const candidate = validateRejudgeReceipt(await readJson(registry, entry)); if (candidate.source_receipt_hash === receipt.receipt_hash) history.push(candidate); }
  history.sort((a, b) => a.judgement.generation - b.judgement.generation); let prior = receipt.judge_outcome; for (const item of history) { if (item.prior_judgement_id !== prior.judgement_id || item.judgement.generation !== prior.generation + 1 || item.candidate_truth_hash !== receipt.candidate_truth_hash) throw new Error('workflow rejudge generation chain is invalid'); prior = item.judgement; } return history; }
export async function verifyWorkflowEvidenceReceipt(registry: ImmutableArtifactRegistry, receipt: WorkflowEvidenceReceipt): Promise<WorkflowEvidenceReceipt> { const verified = receipt.legacy === true ? receipt : verifyWorkflowEvidenceReceiptValue(receipt);
  const references = verified.legacy === true ? [verified.evidence_ref, verified.artifacts_ref, verified.candidate_truth_ref]
    : [verified.evidence_ref, verified.artifacts_ref, verified.candidate_truth_ref, verified.judge_outcome.packet_ref, verified.judge_outcome.envelope_ref, verified.judge_outcome.justification_ref];
  for (const reference of references) await registry.read(reference);
  const truth = object(await readJson(registry, verified.candidate_truth_ref), 'candidate truth') as unknown as CandidateTruth;
  if (canonicalHash(truth) !== verified.candidate_truth_hash || truth.plan_id !== verified.plan_id || truth.dispatch_id !== verified.dispatch_id || truth.invocation_hash !== verified.invocation_hash || truth.scoring_id !== verified.scoring_id) throw new Error('workflow candidate truth binding is invalid');
  if (verified.legacy !== true && (verified.judge_outcome.packet_ref.sha256 !== verified.judge_outcome.packet_hash || verified.judge_outcome.envelope_ref.sha256 !== verified.judge_outcome.envelope_hash || verified.judge_outcome.justification_ref.sha256 !== verified.judge_outcome.justification_hash)) throw new Error('workflow judge retained-object binding is invalid'); return verified; }
export async function workflowReceiptNeedsRejudge(registry: ImmutableArtifactRegistry, experimentId: string, receipt: WorkflowEvidenceReceipt): Promise<boolean> {
  const effective = (await rejudgeHistory(registry, experimentId, receipt)).at(-1)?.judgement ?? receipt.judge_outcome;
  return receipt.candidate_outcome.status === 'success' && receipt.harness_validity.status === 'valid' && !effective.valid;
}
export async function rejudgeRetainedWorkflowStep(input: { readonly registry: ImmutableArtifactRegistry; readonly experimentId: string; readonly receipt: WorkflowEvidenceReceipt; readonly trustedReceiptHash: Hash;
  readonly expectedPolicySemanticsHash: Hash; readonly judge: WorkflowExecutionPlan['policy']['judge']; readonly runner: GovernedWorkflowJudgeRunner; readonly locks: PersistentTypedResourceLocks;
  readonly plan?: WorkflowExecutionPlan; readonly rubricBytes?: string }): Promise<WorkflowJudgement> {
  const receipt = await verifyWorkflowEvidenceReceipt(input.registry, input.receipt); if (receipt.receipt_hash !== input.trustedReceiptHash) throw new Error('workflow receipt does not match trusted immutable digest');
  if (receipt.policy_semantics_sha256 !== input.expectedPolicySemanticsHash) throw new Error('workflow grader-policy drift detected'); const historyBefore = await rejudgeHistory(input.registry, input.experimentId, receipt); const priorBefore = historyBefore.at(-1)?.judgement ?? receipt.judge_outcome;
  if (priorBefore.valid || !await workflowReceiptNeedsRejudge(input.registry, input.experimentId, receipt)) return priorBefore;
  if (receipt.legacy !== true) {
    const priorEnvelope = object(await readJson(input.registry, priorBefore.envelope_ref), 'prior governed judge envelope');
    if (priorEnvelope['dispatch_proof'] === 'ambiguous') throw new Error('manual recovery required: prior governed judge dispatch has an ambiguous external effect');
  }
  if (input.plan === undefined) throw new Error('workflow rejudge requires the immutable plan bytes');
  const lease = await input.locks.acquire([{ type: 'workflow_rejudge', id: canonicalHash({ experiment_id: input.experimentId, plan_id: receipt.plan_id, source_receipt_hash: receipt.receipt_hash }) }]);
  try { const truth = object(await readJson(input.registry, receipt.candidate_truth_ref), 'candidate truth') as unknown as CandidateTruth; const evidence = object(await readJson(input.registry, truth.evidence_ref), 'candidate evidence'); const artifacts = object(await readJson(input.registry, truth.artifacts_ref), 'candidate artifacts') as Record<string, string>;
    const history = await rejudgeHistory(input.registry, input.experimentId, receipt); const prior = history.at(-1)?.judgement ?? receipt.judge_outcome; if (prior.judgement_id !== priorBefore.judgement_id) throw new Error('workflow rejudge generation changed while waiting for durable admission');
    const generation = prior.generation + 1; const judgeDispatchId = canonicalHash({ plan_id: receipt.plan_id, source_receipt_hash: receipt.receipt_hash, generation, judge_policy_hash: canonicalHash(input.judge), purpose: 'rejudge' });
    const packet = buildBlindedJudgePacket(input.plan, receipt.step_id, receipt.scoring_id, receipt.candidate_truth_hash, String(evidence['transcript'] ?? ''), artifacts, receipt, input.rubricBytes); const configured = patterns([...input.plan.policy.redaction.secret_patterns, ...input.plan.policy.steps.find((item) => item.step_id === receipt.step_id)!.redaction.patterns]); const replacements = { value: 0 };
    for (const entry of (await input.registry.verifyExperiment(input.experimentId)).filter((item) => item.role === 'workflow-rejudge-intent')) {
      const priorIntent = object(await readJson(input.registry, entry), 'workflow rejudge intent');
      if (priorIntent['source_receipt_hash'] === receipt.receipt_hash && priorIntent['generation'] === generation) throw new Error('manual recovery required: prior governed rejudge dispatch has an ambiguous external effect');
    }
    const intentCore = { schema_version: 'juno_benchmark_workflow_rejudge_intent.v2', plan_id: receipt.plan_id, source_receipt_hash: receipt.receipt_hash, generation, judge_dispatch_id: judgeDispatchId, purpose: 'rejudge' as const, judge_policy_hash: canonicalHash(input.judge) }; await append(input.registry, input.experimentId, 'workflow-rejudge-intent', intentCore);
    const judgement = await runJudge({ registry: input.registry, experimentId: input.experimentId, plan: input.plan, judge: input.runner, packet, configured, replacements, judgeDispatchId, generation, candidateTruthHash: receipt.candidate_truth_hash, scoringId: receipt.scoring_id });
    const core = { schema_version: WORKFLOW_REJUDGE_RECEIPT_SCHEMA_VERSION, source_receipt_hash: receipt.receipt_hash, candidate_truth_hash: receipt.candidate_truth_hash, prior_judgement_id: prior.judgement_id, judgement };
    await append(input.registry, input.experimentId, 'workflow-rejudge-receipt', { ...core, integrity_hash: canonicalHash(core) }); return judgement;
  } finally { await lease.release(); }
}

export interface WorkflowExperimentReport { readonly schema_version: typeof WORKFLOW_REPORT_SCHEMA_VERSION; readonly report_id: Hash; readonly plan_id: Hash; readonly receipt_count: number; readonly expected_receipt_count: number;
  readonly totals: { readonly resolved: number; readonly candidate_failures: number; readonly harness_invalid: number; readonly judge_valid: number; readonly judge_rejections: number; readonly judge_invalid: number; readonly quality_unknown: number; readonly runtime_ms: number; readonly complete_cost_usd: number; readonly observed_cost_usd: number; readonly incomplete_cost_receipts: number };
  readonly invalidity: Readonly<Record<string, number>>; readonly steps: readonly { readonly step_id: string; readonly scoring_id: string; readonly receipts: number; readonly candidate_result: 'success' | 'failure' | 'mixed'; readonly candidate_harness: 'valid' | 'invalid' | 'mixed'; readonly judge_validity: 'valid' | 'invalid' | 'mixed'; readonly quality_verdict: 'pass' | 'fail' | 'unknown' | 'mixed' }[];
  readonly models: readonly { readonly model: string; readonly receipts: number; readonly resolved: number; readonly harness_invalid: number; readonly judge_invalid: number; readonly runtime_ms: number; readonly complete_cost_usd: number; readonly observed_cost_usd: number;
    readonly resolved_steps: number; readonly judge_passes: number; readonly model_failures: number; readonly median_runtime_ms: number | null;
    readonly candidate_cost: { readonly observed_usd: number; readonly median_usd: number | null; readonly complete: boolean };
    readonly judge_cost: { readonly observed_usd: number; readonly median_usd: number | null; readonly complete: boolean };
    readonly missing_session_identities: number; readonly consistency: 'consistent' | 'inconsistent' | 'not_measurable' }[];
  readonly comparison: readonly { readonly step_id: string; readonly by_model: Readonly<Record<string, 'pass' | 'fail' | 'unknown'>> }[];
  readonly matrix: readonly { readonly step_id: string; readonly by_model: Readonly<Record<string, { readonly works: 'yes' | 'no' | 'unknown'; readonly judge: 'pass' | 'fail' | 'invalid'; readonly candidate_cost_usd: number | null; readonly judge_cost_usd: number | null; readonly runtime_ms: number | null }>> }[];
  readonly winner: string | null }
export async function buildWorkflowExperimentReport(registry: ImmutableArtifactRegistry, plan: WorkflowExecutionPlan): Promise<WorkflowExperimentReport> {
  const experimentId = `workflow-${plan.plan_id.slice(7)}`; const receipts = [...await readWorkflowEvidenceReceipts(registry, experimentId)]; const effective = new Map<Hash, WorkflowJudgement>();
  for (const receipt of receipts) effective.set(receipt.receipt_hash, (await rejudgeHistory(registry, experimentId, receipt)).at(-1)?.judgement ?? receipt.judge_outcome);
  const expected = plan.execution_order.map((item) => `${item.model}\0${item.attempt}\0${item.step_id}`); const observed = receipts.map((item) => `${item.model}\0${item.attempt}\0${item.step_id}`);
  if (receipts.length !== expected.length || new Set(observed).size !== observed.length || expected.some((key) => !observed.includes(key))) throw new Error('workflow evidence receipt cardinality/bindings are incomplete');
  const quality = (item: WorkflowEvidenceReceipt): 'pass' | 'fail' | 'unknown' => { const judge = effective.get(item.receipt_hash)!; return item.candidate_outcome.status !== 'success' || item.harness_validity.status !== 'valid' || !judge.valid ? 'unknown' : judge.verdict === 'pass' ? 'pass' : 'fail'; };
  const invalidity: Record<string, number> = {}; for (const receipt of receipts.filter((item) => item.harness_validity.status === 'invalid')) { const reason = receipt.harness_validity.reason ?? 'unspecified'; invalidity[reason] = (invalidity[reason] ?? 0) + 1; }
  const summarize = (items: readonly WorkflowEvidenceReceipt[]) => ({ receipts: items.length, resolved: items.filter((item) => quality(item) === 'pass').length, harness_invalid: items.filter((item) => item.harness_validity.status === 'invalid').length,
    judge_invalid: items.filter((item) => item.candidate_outcome.status === 'success' && item.harness_validity.status === 'valid' && !effective.get(item.receipt_hash)!.valid).length, runtime_ms: items.reduce((sum, item) => sum + item.runtime.runtime_ms, 0), complete_cost_usd: items.reduce((sum, item) => sum + (item.cost.completeness === 'complete' ? item.cost.usd : 0), 0), observed_cost_usd: items.reduce((sum, item) => sum + (item.cost.usd ?? 0), 0) });
  const judgeEconomics = new Map<Hash, { cost: CostEvidence; runtime_ms: number }>();
  for (const receipt of receipts) {
    const judgement = effective.get(receipt.receipt_hash)!;
    if (receipt.legacy === true) continue;
    const envelope = object(await readJson(registry, judgement.envelope_ref), 'governed judge economics') as unknown as GovernedJudgeExecutionEnvelope;
    judgeEconomics.set(receipt.receipt_hash, { cost: CostEvidenceSchema.parse(envelope.cost), runtime_ms: envelope.runtime_ms });
  }
  const median = (values: readonly number[]): number | null => { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!; };
  const models = plan.models.map((model) => {
    const items = receipts.filter((item) => item.model === model); const base = summarize(items);
    const candidateKnown = items.flatMap((item) => item.cost.usd === null ? [] : [item.cost.usd]);
    const judgeKnown = items.flatMap((item) => { const value = judgeEconomics.get(item.receipt_hash)?.cost.usd; return value === null || value === undefined ? [] : [value]; });
    const stepQualities = plan.selected_step_ids.map((step) => items.filter((item) => item.step_id === step).map(quality));
    return { model, ...base, resolved_steps: stepQualities.filter((values) => values.length > 0 && values.every((value) => value === 'pass')).length,
      judge_passes: items.filter((item) => effective.get(item.receipt_hash)!.valid && effective.get(item.receipt_hash)!.verdict === 'pass').length,
      model_failures: items.filter((item) => item.harness_validity.status === 'valid' && item.candidate_outcome.status === 'failure').length,
      median_runtime_ms: median(items.map((item) => item.runtime.runtime_ms)),
      candidate_cost: { observed_usd: candidateKnown.reduce((sum, value) => sum + value, 0), median_usd: median(candidateKnown), complete: items.every((item) => item.cost.completeness === 'complete' || item.cost.completeness === 'not_applicable') },
      judge_cost: { observed_usd: judgeKnown.reduce((sum, value) => sum + value, 0), median_usd: median(judgeKnown), complete: items.every((item) => { const cost = judgeEconomics.get(item.receipt_hash)?.cost; return cost !== undefined && (cost.completeness === 'complete' || cost.completeness === 'not_applicable'); }) },
      missing_session_identities: items.filter((item) => !item.sessions.outer_session_id || item.sessions.nested_session_ids.length === 0).length,
      consistency: plan.attempts < 2 ? 'not_measurable' as const : stepQualities.every((values) => new Set(values).size === 1) ? 'consistent' as const : 'inconsistent' as const };
  });
  const comparison: WorkflowExperimentReport['comparison'] = plan.selected_step_ids.map((stepId) => ({ step_id: stepId, by_model: Object.fromEntries(plan.models.map((model) => { const values = receipts.filter((item) => item.step_id === stepId && item.model === model).map(quality); const result: 'pass' | 'fail' | 'unknown' = values.includes('unknown') ? 'unknown' : values.every((value) => value === 'pass') ? 'pass' : 'fail'; return [model, result]; })) }));
  const matrix: WorkflowExperimentReport['matrix'] = plan.selected_step_ids.map((stepId) => ({ step_id: stepId, by_model: Object.fromEntries(plan.models.map((model) => {
    const items = receipts.filter((item) => item.step_id === stepId && item.model === model); const values = items.map(quality);
    const works: 'yes' | 'no' | 'unknown' = values.includes('unknown') ? 'unknown' : values.every((value) => value === 'pass') ? 'yes' : 'no';
    const judges = items.map((item) => effective.get(item.receipt_hash)!); const judge = judges.some((item) => !item.valid) ? 'invalid' : judges.every((item) => item.verdict === 'pass') ? 'pass' : 'fail';
    const candidateCosts = items.flatMap((item) => item.cost.usd === null ? [] : [item.cost.usd]); const judgeCosts = items.flatMap((item) => { const cost = judgeEconomics.get(item.receipt_hash)?.cost.usd; return cost === null || cost === undefined ? [] : [cost]; });
    return [model, { works, judge, candidate_cost_usd: candidateCosts.length === 0 ? null : candidateCosts.reduce((sum, value) => sum + value, 0), judge_cost_usd: judgeCosts.length === 0 ? null : judgeCosts.reduce((sum, value) => sum + value, 0), runtime_ms: items.length === 0 ? null : items.reduce((sum, item) => sum + item.runtime.runtime_ms, 0) }];
  })) }));
  const state = <T extends string>(values: readonly T[]): T | 'mixed' => new Set(values).size === 1 ? values[0]! : 'mixed'; const steps = plan.selected_step_ids.map((stepId) => { const items = receipts.filter((item) => item.step_id === stepId); const policy = plan.policy.steps.find((item) => item.step_id === stepId)!; return { step_id: stepId, scoring_id: policy.scoring_id, receipts: items.length,
    candidate_result: state(items.map((item) => item.candidate_outcome.status)), candidate_harness: state(items.map((item) => item.harness_validity.status)), judge_validity: state(items.map((item) => effective.get(item.receipt_hash)!.valid ? 'valid' as const : 'invalid' as const)), quality_verdict: state(items.map(quality)) }; });
  const totals = { resolved: receipts.filter((item) => quality(item) === 'pass').length, candidate_failures: receipts.filter((item) => item.candidate_outcome.status === 'failure' && item.harness_validity.status === 'valid').length, harness_invalid: receipts.filter((item) => item.harness_validity.status === 'invalid').length,
    judge_valid: receipts.filter((item) => effective.get(item.receipt_hash)!.valid).length, judge_rejections: receipts.filter((item) => effective.get(item.receipt_hash)!.terminal_class === 'judge_rejection').length,
    judge_invalid: receipts.filter((item) => item.candidate_outcome.status === 'success' && item.harness_validity.status === 'valid' && !effective.get(item.receipt_hash)!.valid).length, quality_unknown: receipts.filter((item) => quality(item) === 'unknown').length,
    runtime_ms: receipts.reduce((sum, item) => sum + item.runtime.runtime_ms, 0), complete_cost_usd: receipts.reduce((sum, item) => sum + (item.cost.completeness === 'complete' ? item.cost.usd : 0), 0), observed_cost_usd: receipts.reduce((sum, item) => sum + (item.cost.usd ?? 0), 0), incomplete_cost_receipts: receipts.filter((item) => item.cost.completeness !== 'complete').length };
  const passCounts = new Map(plan.models.map((model) => [model, comparison.filter((item) => item.by_model[model] === 'pass').length]));
  const best = Math.max(...passCounts.values()); const leaders = [...passCounts].filter(([, count]) => count === best).map(([model]) => model);
  const core = { schema_version: WORKFLOW_REPORT_SCHEMA_VERSION, plan_id: plan.plan_id as Hash, receipt_count: receipts.length, expected_receipt_count: expected.length, totals, invalidity: Object.fromEntries(Object.entries(invalidity).sort(([a], [b]) => a.localeCompare(b))), steps, models, comparison, matrix, winner: totals.quality_unknown > 0 || leaders.length !== 1 ? null : leaders[0]! };
  return { ...core, report_id: canonicalHash(core) };
}
export async function storeWorkflowExperimentReport(registry: ImmutableArtifactRegistry, plan: WorkflowExecutionPlan): Promise<WorkflowExperimentReport> { const report = await buildWorkflowExperimentReport(registry, plan); const experimentId = `workflow-${plan.plan_id.slice(7)}`; await append(registry, experimentId, 'workflow-report', report); return report; }
export async function readWorkflowEvidenceReceipts(registry: ImmutableArtifactRegistry, experimentId: string): Promise<readonly WorkflowEvidenceReceipt[]> { const entries: readonly ManifestEntry[] = await registry.verifyExperiment(experimentId); const receipts: WorkflowEvidenceReceipt[] = [];
  for (const entry of entries.filter((item) => item.role === 'workflow-evidence-receipt')) receipts.push(await verifyWorkflowEvidenceReceipt(registry, verifyWorkflowEvidenceReceiptValue(await readJson(registry, entry)))); return Object.freeze(receipts); }
