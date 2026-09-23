import { describe, expect, it } from 'vitest';
import { AssessmentSchema, EvaluatorSchema, TreatmentSchema } from '../../src/v2/contracts.js';
import { workflowPrefix } from '../../src/v2/harness.js';

describe('small explicit contracts', () => {
  it('allows arbitrary model selectors and configurations without provider catalogs', () => {
    const value = TreatmentSchema.parse({ name: 'v', model: 'new/model', harness: 'command', executable: 'runner', configuration: { tools: ['read'], reasoning: 'high' } });
    expect(value.args).toEqual([]); expect(value.configuration).toEqual({ tools: ['read'], reasoning: 'high' });
  });
  it('rejects invalid bounds, missing workflow selection and mixed evaluator kinds', () => {
    expect(() => TreatmentSchema.parse({ name: 'v', model: 'm', harness: 'command', executable: 'x', timeout_ms: 0 })).toThrow();
    expect(() => TreatmentSchema.parse({ name: 'v', model: 'm', harness: 'workflow_runner', executable: 'x' })).toThrow();
    expect(() => EvaluatorSchema.parse({ name: 'check', kind: 'check' })).toThrow();
    expect(() => EvaluatorSchema.parse({ name: 'judge', kind: 'judge', command: { executable: 'x' } })).toThrow();
    expect(() => AssessmentSchema.parse({ verdict: 'maybe' })).toThrow();
  });
  it('projects only the prefix container and rejects ambiguous steps', () => {
    const yaml = 'id: example\nsteps:\n  - id: a\n    command: echo a\n  - id: b\n    command: echo b\n  - id: c\n    command: echo c\n';
    expect(workflowPrefix(yaml)).toBe(yaml);
    expect(workflowPrefix(yaml, 'b')).toContain('command: echo b');
    expect(workflowPrefix(yaml, 'b')).not.toContain('command: echo c');
    expect(() => workflowPrefix(yaml, 'missing')).toThrow('unknown');
    expect(() => workflowPrefix('steps: [{id: a}, {id: a}]', 'a')).toThrow('unique');
    expect(() => workflowPrefix('continue_from_step: a\nsteps: [{id: a}]', 'a')).toThrow('continue_from_step');
  });
});
