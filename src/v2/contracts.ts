import { z } from 'zod';

const text = z.string().min(1);
const argv = z.array(z.string()).default([]);
export const CommandSchema = z.object({ executable: text, args: argv }).strict();
export const TreatmentSchema = z.object({
  name: text,
  model: text,
  harness: z.enum(['yylo_pi', 'command', 'workflow_runner']),
  executable: text,
  args: argv,
  timeout_ms: z.number().int().positive().default(1_800_000),
  configuration: z.record(z.unknown()).default({}),
  setup: CommandSchema.optional(),
  workflow: z.object({
    model_variable: text,
    variables: z.record(z.unknown()).default({}),
    through: text.optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.harness === 'workflow_runner' && !value.workflow || value.harness === 'yylo_pi' && value.workflow) {
    ctx.addIssue({ code: 'custom', message: 'workflow_runner requires workflow configuration; yylo_pi is a single-session adapter' });
  }
});
export type Treatment = z.infer<typeof TreatmentSchema>;
export type Command = z.infer<typeof CommandSchema>;
export const EvaluatorSchema = z.object({
  name: text,
  kind: z.enum(['check', 'judge', 'human']),
  command: CommandSchema.optional(),
  judge: TreatmentSchema.optional(),
  rubric: z.string().default(''),
  max_packet_bytes: z.number().int().positive().default(1_000_000),
  timeout_ms: z.number().int().positive().default(600_000),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'check' && (!value.command || value.judge)
      || value.kind === 'judge' && (!value.judge || value.command || value.judge.harness === 'workflow_runner' || value.judge.workflow !== undefined)
      || value.kind === 'human' && (value.command || value.judge)) {
    ctx.addIssue({ code: 'custom', message: 'check needs command; judge needs a non-workflow treatment; human has neither' });
  }
});
export type Evaluator = z.infer<typeof EvaluatorSchema>;
export const AssessmentSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'unknown']),
  findings: z.array(z.string()).default([]),
}).strict();
export type Assessment = z.infer<typeof AssessmentSchema>;
export interface FileEntry { path: string; sha256: string; executable: boolean }
export interface CaseRecord {
  schema: 'yylo_benchmark_case.v3';
  source_commit: string;
  reference_commit: string | null;
  ledger_task_id: string | null;
  reviewed: true;
  prompt: string;
  workflow: string | null;
  exclusions: string[];
  inclusions: string[];
  files: FileEntry[];
  sha256: string;
}
export type ExecutionStatus = 'completed' | 'failed' | 'timed_out' | 'error';
export interface Execution {
  status: ExecutionStatus;
  exit_code: number | null;
  signal: string | null;
  runtime_ms: number;
  stdout: string;
  stderr: string;
  response: string;
  observed_model: string | null;
  session_id: string | null;
  cost_usd: number | null;
  cost_completeness: 'reported' | 'partial' | 'unknown';
  diagnostic: string | null;
}
export interface AttemptIntent {
  schema: 'yylo_benchmark_attempt.v3';
  id: string;
  case_hash: string;
  ledger_task_id: string | null;
  source_commit: string;
  case_prompt: string;
  treatment: Treatment;
  scope: 'task' | 'workflow' | 'workflow_prefix';
  started_at: string;
}
export interface AttemptResult {
  schema: 'yylo_benchmark_result.v3';
  attempt_id: string;
  intent_hash: string;
  execution: Execution;
  output_files: FileEntry[];
  output_error: string | null;
  patch_sha256: string;
  ended_at: string;
  sha256: string;
}
export interface EvaluationRecord {
  schema: 'yylo_benchmark_evaluation.v3';
  id: string;
  attempt_id: string;
  result_hash: string;
  evaluator: Evaluator;
  validity: 'valid' | 'error';
  assessment: Assessment;
  execution: Execution | null;
  error: string | null;
  created_at: string;
  sha256: string;
}
