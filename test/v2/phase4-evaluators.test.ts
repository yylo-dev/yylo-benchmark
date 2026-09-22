import { mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

async function phase4() { return import('../../src/v2/evaluators.js').catch(() => null); }

const hash = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const textHash = (value: string): `sha256:${string}` => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const evidence = (attempt: string, kind: 'task' | 'workflow') => ({
  schema_version: 'yylo_benchmark_attempt_evidence.v2' as const,
  yylo_version: '2.0.0', benchmark_version: '2.0.0', attempt_id: hash(attempt), plan_hash: hash('a'),
  candidate: { status: 'success' as const, exit_code: 0, signal: null, session_id: `candidate-${kind}`, started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:01.000Z', runtime_ms: 1000, cost: { completeness: 'partial' as const, usd: 0.2 }, output: 'candidate supplied factual analysis' },
  identity: { harness_profile: 'candidate-harness', requested_model: 'candidate-provider/secret-model', resolved_provider: 'candidate-provider', resolved_model: 'secret-model', observed_provider: 'candidate-provider', observed_model: 'secret-model', observed_harness_version: '1' },
  workspace_receipt_hash: hash('b'), workspace_manifest_hash: hash('e'), artifacts: [{ role: 'patch', sha256: hash('c'), size: 10 }], evidence_hash: hash('d'),
});

function judgeTerminal(model: string, output: string, overrides: Record<string, unknown> = {}) {
  return { status: 'success' as const, exit_code: 0, signal: null, session_id: 'judge-session', resolved_provider: model.split('/')[0]!, resolved_model: model, observed_provider: model.split('/')[0]!, observed_model: model, harness_version: 'judge-harness-1', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:01.000Z', runtime_ms: 1000, cost: { completeness: 'complete' as const, usd: 0.05 }, process: { pid: 2, command: ['judge'] }, artifacts: [], raw_output: output, ...overrides };
}

const deterministicProfile = { profileId: 'checks', profileVersion: '1', generation: 1, kind: 'deterministic' as const, required: true, correctnessGate: true };
const jsonJudge = { profileId: 'json-judge', profileVersion: '1', generation: 1, kind: 'llm_judge' as const, required: true, harnessProfile: 'judge-harness', requestedModel: 'judge-provider/judge-model', systemPrompt: { inline: 'You are the evaluator.' }, promptTemplate: { inline: 'CASE={{case_kind}}\nRUBRIC={{rubric}}\nEVIDENCE={{evidence}}' }, rubric: { inline: 'Must be correct and safe.' }, evidenceFields: ['candidate.status', 'candidate.output', 'artifacts', 'identity'], maxEvidenceBytes: 4096, identityVisibility: 'blinded' as const, mode: 'single' as const, timeoutMs: 1000, repetitions: 1, aggregation: 'majority' as const, parser: { kind: 'strict_json' as const }, settings: { temperature: 0 } };

async function runRoot() { return await mkdtemp(path.join(os.tmpdir(), 'yylo-phase4-')); }

function adapter(output: string, terminalOverrides: Record<string, unknown> = {}) {
  const run = vi.fn(async (request: { requestedModel: string }) => judgeTerminal(request.requestedModel, output, terminalOverrides));
  return { run, value: { profileId: 'judge-harness', version: '1', probe: async () => ({ ready: true as const }), prepare: async () => ({ prepared: true as const }), run, reconcile: async () => ({ state: 'ambiguous' as const, reason: 'manual' }) } };
}

describe('F7ZPw7 phase 4 shared configurable evaluator pipeline', () => {
  it('P4-A1 applies the same ordered deterministic and LLM profiles to task and workflow evidence', async () => {
    const api = await phase4();
    expect(api, 'v2 evaluator module must exist').not.toBeNull();
    for (const kind of ['task', 'workflow'] as const) {
      const judge = adapter('{"verdict":"pass","findings":["clear"]}');
      const result = await api!.evaluateAttempt({ evidence: evidence(kind === 'task' ? '1' : '2', kind), caseKind: kind, profiles: [deterministicProfile, jsonJudge], composition: { kind: 'all_required' }, deterministicEvaluators: { checks: async () => ({ passed: true, findings: [], rawOutput: 'ok' }) }, judgeAdapters: { 'judge-harness': judge.value }, intentRoot: path.join(await runRoot(), 'intents'), cwd: await runRoot() });
      expect(result.records.map((record: { evaluator_kind: string }) => record.evaluator_kind)).toEqual(['deterministic', 'llm_judge']);
      expect(result.quality).toBe('resolved');
    }
  });

  it('P4-A2 keeps candidate and judge harness/model selection independent and provider-agnostic', async () => {
    const api = await phase4();
    expect(api, 'v2 evaluator module must exist').not.toBeNull();
    const judge = adapter('{"verdict":"pass"}');
    const result = await api!.evaluateAttempt({ evidence: evidence('3', 'task'), caseKind: 'task', profiles: [jsonJudge], composition: { kind: 'judge_only' }, deterministicEvaluators: {}, judgeAdapters: { 'judge-harness': judge.value }, intentRoot: path.join(await runRoot(), 'intents'), cwd: await runRoot() });
    expect(judge.run).toHaveBeenCalledWith(expect.objectContaining({ requestedModel: 'judge-provider/judge-model' }));
    expect(result.records[0].evaluator_identity).toMatchObject({ requested_model: 'judge-provider/judge-model', observed_provider: 'judge-provider' });
    expect(result.records[0].evaluator_session_ids).toEqual(['judge-session']);
    expect(result.candidate_identity.requested_model).toBe('candidate-provider/secret-model');
  });

  it('P4-A3 hash-binds custom prompt/rubric and supports strict JSON, legacy PASS/FAIL, blinded and identity-visible packets', async () => {
    const api = await phase4();
    expect(api, 'v2 evaluator module must exist').not.toBeNull();
    const blinded = adapter('{"verdict":"pass","score":0.9}');
    const root = await runRoot();
    const first = await api!.evaluateAttempt({ evidence: evidence('4', 'task'), caseKind: 'task', profiles: [jsonJudge], composition: { kind: 'judge_only' }, deterministicEvaluators: {}, judgeAdapters: { 'judge-harness': blinded.value }, intentRoot: path.join(root, 'json'), cwd: root });
    const blindedPacket = blinded.run.mock.calls[0]![0].invocation;
    expect(JSON.stringify(blindedPacket)).not.toContain('secret-model');
    expect(JSON.stringify(blindedPacket)).toContain('candidate supplied factual analysis');
    expect(first.records[0].profile_hash).toMatch(/^sha256:/u);
    expect(first.records[0].prompt_hash).toMatch(/^sha256:/u);
    expect(first.records[0].rubric_hash).toMatch(/^sha256:/u);

    const legacyAdapter = adapter('analysis\nVERDICT: FAIL\nunsafe');
    const legacyProfile = { ...jsonJudge, profileId: 'legacy', generation: 2, identityVisibility: 'visible' as const, parser: { kind: 'legacy_verdict' as const } };
    const second = await api!.evaluateAttempt({ evidence: evidence('5', 'workflow'), caseKind: 'workflow', profiles: [legacyProfile], composition: { kind: 'judge_only' }, deterministicEvaluators: {}, judgeAdapters: { 'judge-harness': legacyAdapter.value }, intentRoot: path.join(root, 'legacy'), cwd: root });
    expect(JSON.stringify(legacyAdapter.run.mock.calls[0]![0].invocation)).toContain('secret-model');
    expect(second.records[0]).toMatchObject({ quality: 'unresolved', evaluator_generation: 2 });
  });

  it('P4-A4 appends a new rejudge generation over retained evidence without candidate dispatch or prior mutation', async () => {
    const api = await phase4();
    expect(api, 'v2 evaluator module must exist').not.toBeNull();
    const candidateDispatch = vi.fn();
    const firstJudge = adapter('{"verdict":"fail"}');
    const root = await runRoot();
    const first = await api!.evaluateAttempt({ evidence: evidence('6', 'task'), caseKind: 'task', profiles: [jsonJudge], composition: { kind: 'judge_only' }, deterministicEvaluators: {}, judgeAdapters: { 'judge-harness': firstJudge.value }, intentRoot: path.join(root, 'first'), cwd: root });
    const retainedBytes = JSON.stringify(first.records);
    const secondJudge = adapter('{"verdict":"pass"}');
    const rejudged = await api!.reevaluateAttempt({ evidence: evidence('6', 'task'), caseKind: 'task', existingRecords: first.records, profiles: [{ ...jsonJudge, generation: 2 }], composition: { kind: 'judge_only' }, deterministicEvaluators: {}, judgeAdapters: { 'judge-harness': secondJudge.value }, intentRoot: path.join(root, 'second'), cwd: root });
    expect(rejudged.records).toHaveLength(2);
    expect(rejudged.records.map((record: { evaluator_generation: number }) => record.evaluator_generation)).toEqual([1, 2]);
    expect(JSON.stringify(first.records)).toBe(retainedBytes);
    expect(candidateDispatch).not.toHaveBeenCalled();
  });

  it('P4-A5 prevents favorable judge prose from overriding a required deterministic correctness failure', async () => {
    const api = await phase4();
    expect(api, 'v2 evaluator module must exist').not.toBeNull();
    const judge = adapter('{"verdict":"pass"}');
    const result = await api!.evaluateAttempt({ evidence: evidence('7', 'task'), caseKind: 'task', profiles: [deterministicProfile, jsonJudge], composition: { kind: 'all_required' }, deterministicEvaluators: { checks: async () => ({ passed: false, findings: [{ code: 'tests_failed', message: 'tests failed', severity: 'error' }], rawOutput: 'failed' }) }, judgeAdapters: { 'judge-harness': judge.value }, intentRoot: path.join(await runRoot(), 'intents'), cwd: await runRoot() });
    expect(result.records[1].quality).toBe('resolved');
    expect(result.records[1].raw_output).toBe('{"verdict":"pass"}');
    expect(result.records[1].raw_output_hash).toBe(textHash(result.records[1].raw_output));
    expect(result.quality).toBe('unresolved');
    expect(result.required_gate_failures).toContain('checks');
  });

  it('P4-A6 preserves malformed, timeout, missing-identity, privacy, and harness failures as invalid unknown quality', async () => {
    const api = await phase4();
    expect(api, 'v2 evaluator module must exist').not.toBeNull();
    for (const [output, overrides, code] of [
      ['not json', {}, 'malformed_output'],
      ['{"verdict":"pass"}', { status: 'timeout', exit_code: null }, 'evaluator_timeout'],
      ['{"verdict":"pass"}', { session_id: null }, 'missing_session'],
    ] as const) {
      const judge = adapter(output, overrides);
      const root = await runRoot();
      const result = await api!.evaluateAttempt({ evidence: evidence('8', 'workflow'), caseKind: 'workflow', profiles: [{ ...jsonJudge, profileId: `invalid-${code}` }], composition: { kind: 'judge_only' }, deterministicEvaluators: {}, judgeAdapters: { 'judge-harness': judge.value }, intentRoot: path.join(root, code), cwd: root });
      expect(result.quality).toBe('unknown');
      expect(result.records[0].validity).toBe('invalid');
      expect(result.records[0].findings.map((item: { code: string }) => item.code)).toContain(code);
      expect(result.records[0].raw_output_hash).toMatch(/^sha256:/u);
      expect(result.records[0].raw_output).toBe(output);
    }

    const root = await runRoot();
    const failed = await api!.evaluateAttempt({ evidence: evidence('9', 'task'), caseKind: 'task', profiles: [jsonJudge], composition: { kind: 'judge_only' },
      deterministicEvaluators: {}, judgeAdapters: { 'judge-harness': { profileId: 'judge-harness', version: '1', probe: async () => { throw new Error('ENOENT judge'); },
        prepare: async () => ({ prepared: true as const }), run: async () => judgeTerminal('judge-provider/judge-model', '{"verdict":"pass"}'),
        reconcile: async () => ({ state: 'ambiguous' as const, reason: 'manual' }) } }, intentRoot: path.join(root, 'launch-failure'), cwd: root });
    expect(failed).toMatchObject({ quality: 'unknown', validity: 'invalid' });
    expect(failed.records[0].findings[0]).toMatchObject({ code: 'harness_failure', message: 'ENOENT judge' });
  });

  it('does not dispatch a judge after required checks fail to produce evidence, regardless of profile order', async () => {
    const api = await phase4(); const root = await runRoot(); const judge = adapter('{"verdict":"pass"}');
    const checks = { profileId: 'checks', profileVersion: '1', generation: 1, kind: 'deterministic' as const, required: true };
    const result = await api!.evaluateAttempt({ evidence: evidence('b', 'task'), caseKind: 'task', profiles: [jsonJudge, checks],
      composition: { kind: 'all_required' }, deterministicEvaluators: { checks: async () => { throw new Error('packet missing'); } },
      judgeAdapters: { 'judge-harness': judge.value }, intentRoot: root, cwd: root });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ validity: 'invalid', quality: 'unknown' });
    expect(result.records[1].findings[0].code).toBe('judge_not_dispatched');
  });

  it('skips invalid candidates by default and binds an explicit diagnostic override', async () => {
    const api = await phase4();
    expect(api).not.toBeNull();
    const judge = adapter('{"verdict":"pass"}');
    const invalidEvidence = { ...evidence('a', 'task'), candidate: { ...evidence('a', 'task').candidate, status: 'invalid' as const,
      validity: 'invalid' as const, diagnostics: [{ code: 'missing_session', message: 'missing' }] } };
    const root = await runRoot();
    const result = await api!.evaluateAttempt({ evidence: invalidEvidence, caseKind: 'task', profiles: [jsonJudge], composition: { kind: 'judge_only' },
      deterministicEvaluators: {}, judgeAdapters: { 'judge-harness': judge.value }, intentRoot: path.join(root, 'invalid-candidate'), cwd: root });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ quality: 'unknown', validity: 'invalid' });
    expect(result.records[0]).toMatchObject({ cost: { completeness: 'not_applicable', usd: null }, evaluator_session_ids: [],
      findings: [{ code: 'judge_not_dispatched' }] });
    const diagnostic = await api!.evaluateAttempt({ evidence: invalidEvidence, caseKind: 'task',
      profiles: [{ ...jsonJudge, settings: { diagnostic_on_invalid: true } }], composition: { kind: 'judge_only' },
      deterministicEvaluators: {}, judgeAdapters: { 'judge-harness': judge.value }, intentRoot: path.join(root, 'diagnostic'), cwd: root });
    expect(judge.run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1000 }));
    expect(diagnostic).toMatchObject({ quality: 'unknown', validity: 'invalid' });
  });
});
