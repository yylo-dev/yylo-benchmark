# YYLO Benchmark

A thin **trusted-host experiment runner** for historical Ledger tasks, supplied coding prompts, and workflows. Compare models, harnesses and configurations; evaluate retained outputs with different checks or judges later.

```text
reviewed case -> independent attempts -> retained outputs
                                          |   |   |
                                      checks  A   B  <- new judges at any time
                                          |   |   |
                                      comparison rows
```

Benchmark does not choose a winner or combine judge opinions with test results. It does not implement a workflow engine, production authority, provider catalog, repair loop or automatic retry.

## Breaking redesign

The source now uses v3 case/attempt/evaluation records. The old v1/v2 APIs, configuration, plan/recover/doctor/regrade/rejudge commands, plugin registry and governed-production workflow boundary are retired. Ordinary Workflow Runner execution remains supported through delegation. Old plans and evidence are **not migrated, overwritten, deleted or reinterpreted**. Use their original pinned implementation if historical inspection is necessary. This source change is not a package publication or global runtime upgrade.

The historical [ten-task retrospective](https://yylo.dev/blog/ten-task-cli-benchmark) describes an exploratory study, not a ranking or certification of this implementation. Historical evidence remains historical.

## Requirements and boundaries

Node 20.10+, Git, tar and POSIX process groups. The selected harness and its setup dependencies must be installed. Tests require no paid provider calls. Windows execution is unsupported.

Every independent attempt starts with a fresh repository containing the reviewed pre-solution files, **not a linked worktree or cloned future history**. Default exclusions are `.juno_task`, `.gitmodules`, `hidden-graders`, and `reference-solutions`. Add case-specific answer paths with `--exclude`. When a historical task genuinely edits controller-owned product source, use a narrowly reviewed `--include .juno_task/scripts` to override the default exclusion for that source subtree only; never include task/completion/answer storage. Explicit `--exclude` always wins. Symlinks and gitlinks are rejected unless excluded or materialized in a separately reviewed input repository. Setup and generated dependencies belong in ignore rules; retained output includes tracked files and unignored new files.

Reference solutions, completion responses, hidden checks, and other attempts must not be supplied as candidate context. Preparation requires explicit review; Benchmark cannot discover every answer-bearing document. Known exposure is a disqualification, not a model failure.

This is **workspace/context hygiene, not filesystem/account/network isolation**. The process inherits host authentication and can deliberately access other host paths or public answers. Shared authentication is not a private account boundary. Routing/Git/Pi override environment variables are discarded to avoid accidental inherited sessions/controller routing. Pi receives a private session directory. Workflows own their own sessions. Never use this runner as an authorization grant for production workflows.

## 1. Prepare a case once

Ask Ledger for an assisted proposal (read-only; no candidate dispatch):

```bash
yylo-benchmark case draft --ledger-task TASK_ID > /tmp/case-draft.json
```

The draft includes the task body and reference-commit candidate, **not the completion response**. It deliberately leaves the base unset: reconstruct the original development range, review original requirements, and create a prompt file. Do not blindly use an integration repair's parent as the original baseline. The latest task body may itself need historical review. The tool does not promise automatic historical reconstruction or a perfect oracle.

For either a historical task or your own prompt:

```bash
yylo-benchmark case create \
  --source /path/to/repository --base PRE_SOLUTION_COMMIT \
  --reference SOLUTION_COMMIT \
  --prompt /tmp/requirements.md --exclude private-answers \
  --output /tmp/cases/my-case --reviewed
```

`--reference` and `--ledger-task` are optional provenance; the reference must differ from and descend from the base. It is never copied into candidate input. Case storage must be outside the source repository. `--workflow path/in/source.yaml` captures a tracked workflow at the chosen base. No models are launched during case creation. Use baseline/reference controls to review behavior-based checks before scoring; this is evaluation work, not a new orchestration framework.

## 2. Run treatments

A treatment JSON file chooses one model, harness and configuration:

```json
{
  "name": "pi-model-a",
  "model": "provider/model-a",
  "harness": "yylo_pi",
  "executable": "yy",
  "args": ["--thinking", "medium"],
  "timeout_ms": 1800000,
  "configuration": {}
}
```

```bash
yylo-benchmark run --case /tmp/cases/my-case \
  --treatment /tmp/model-a.json --treatment /tmp/model-b.json \
  --attempts 1 --output /tmp/experiments/comparison-1
```

The output directory must be new. `run` emits one JSON line per attempt; `report` emits a JSON array unless `--table` is selected. Runs are sequential in explicit treatment order; repetitions are independent. There is no hidden retry or resume. Each attempt writes an intent before dispatch and a result afterward. An unfinished intent is reported as `interrupted_or_running`, never automatically relaunched. Rerun explicitly into a new directory if authorized. SIGINT/SIGTERM cancel the active process group; a cancelled matrix does not dispatch remaining variants. The harness owns any deliberately detached descendants; this is not a general process sandbox.

The optional `setup: {"executable":"...","args":["..."]}` runs once in the new workspace within the same timeout. It owns dependency installation/local initialization. Benchmark does not silently install, borrow dependencies, repair setup or change controller registration. YYLO Pi and Workflow Runner must be initialized in their supported local topology by that setup if needed; a missing prerequisite is retained as an error/failure, not repaired. For example, the current Workflow Runner needs its own `.juno_task` and `.venv_juno`; Simple mode currently rejects orchestration. Do not route a benchmark workspace to your real controller to bypass that refusal.

Pi receives `--execution-envelope`, the selected model, file-backed prompt and a fresh session directory. Reserved model/prompt/resume/session arguments cannot be overridden. Requested and observed identities stay separate because selectors may be aliases. Captured reported cost is not an invoice; missing cost stays null. Most pre-envelope timeouts have unknown usage. The prompt file proves harness input, **not necessarily the final provider message**: YYLO preprocessing or harness instructions can transform it. Review actual delivery for experiments requiring literal fidelity.

### Generic command adapter

Use `harness: "command"` with an executable and argv. No shell interpolation occurs; explicitly select a shell if you need one. The process runs in the candidate workspace, receives the prompt on stdin, and receives this environment value:

```text
YYLO_BENCHMARK_REQUEST_JSON = { model, configuration, prompt, workflow }
```

The adapter/command owns interpreting its model/configuration. With optional `workflow` configuration, the request also supplies `{path, variables, through}` for the retained YAML prefix; otherwise `workflow` is null. A custom workflow harness must consume that supplied projection rather than silently executing a different full workflow. Exit zero means execution completed, not that the task passed. Nonzero exit is failure; launch errors, cancellation and output overflow are errors. Each captured stream is bounded at 8 MiB; overflow terminates execution and marks the retained stream incomplete. Generic commands do not claim observed model identity or cost.

### Workflows and selected steps

```json
{
  "name": "workflow-model-a",
  "model": "provider/model-a",
  "harness": "workflow_runner",
  "executable": "python3",
  "args": ["/absolute/installed/workflow_runner.sh"],
  "timeout_ms": 1800000,
  "configuration": {},
  "workflow": {
    "model_variable": "candidate_model",
    "variables": {"reasoning": "medium"},
    "through": "review"
  }
}
```

Omit `through` for a complete workflow. The workflow must use the declared model variable for its agent calls; Benchmark does not rewrite commands or claim every arbitrary command used the requested model. Configuration is supplied through the same request environment; workflow-native variables are explicit. The workflow owns session reuse, ordering, dependencies and errors.

For a selected step, Benchmark retains a YAML projection containing the original prefix through that unique step ID, then passes it to the **existing Workflow Runner** with `--workflow`, `--run-root`, `--out-dir` and `--var`. It does not interpret commands or translate session state. Unsupported dependencies/variables remain runner errors. Resume-style `continue_from_step` is not a prefix experiment.

```text
same case -> model/harness A: first -> review -> STOP
          -> model/harness B: first -> review -> STOP
```

This compares **the prefix through review**, not review independently. Model selection is fixed for each run; cross-harness compatibility is not guaranteed. The native runner's manifest is checked because it can report failed steps even when its process exits zero. Pi is a single-session adapter, not a workflow engine. A different workflow harness can be supplied as a generic command with the same `workflow` configuration: it receives the prefix path/variables through the request environment and owns execution/error reporting. Both native and custom workflow attempts are labelled `workflow_prefix` when a stop step is selected.

## 3. Evaluate retained output independently

A check profile uses a regular command receiving a JSON packet on stdin. It must return exactly a JSON assessment and exit zero; test failure is `verdict: "fail"`, whereas nonzero exit or malformed output is an **evaluator error**:

```json
{
  "name": "behavior-checks",
  "kind": "check",
  "command": {"executable": "python3", "args": ["/private/checks.py"]},
  "timeout_ms": 600000
}
```

```json
{"verdict":"fail","findings":["Missing required behavior"]}
```

A judge profile uses a Pi or command treatment:

```json
{
  "name": "judge-a",
  "kind": "judge",
  "rubric": "Assess correctness and missing validation separately.",
  "max_packet_bytes": 1000000,
  "judge": {
    "name": "judge-a",
    "model": "provider/judge-model",
    "harness": "yylo_pi",
    "executable": "yy",
    "args": [],
    "timeout_ms": 600000
  }
}
```

```bash
yylo-benchmark evaluate --attempt /tmp/experiments/comparison-1/1-1 \
  --evaluator /tmp/judge-a.json
# Months later: a new judge or rubric; no original catalog prebinding needed.
yylo-benchmark evaluate --attempt /tmp/experiments/comparison-1/1-1 \
  --evaluator /tmp/judge-b.json
```

Each evaluation has its own ID, specification and retained result, and runs in a fresh copy of retained candidate files. Candidates are never rerun. Packets include requirements, execution status, patch, response and rubric; final files are available in the evaluator workspace. Oversized packets are rejected, not silently truncated. Candidate identity metadata is omitted, but candidate-authored text may disclose it: do not claim perfect blinding. Treat candidate text as untrusted evidence.

Human profiles use `{"name":"reviewer","kind":"human"}` plus `--assessment /tmp/assessment.json`. Checks/judges/humans may assess a retained failed attempt, but their verdict cannot change its execution status. Judge disagreements remain independent rows.

## 4. Report and disqualify

```bash
yylo-benchmark report --root /tmp/experiments/comparison-1 --table
yylo-benchmark report --root /tmp/experiments/comparison-1
yylo-benchmark disqualify --attempt /tmp/experiments/comparison-1/1-1 \
  --reason 'Confirmed reference solution exposure'
```

JSON rows retain execution status, treatment, scope, each assessment/validity, timing, cost coverage, integrity errors and disqualification separately. Partial experiments are reportable, not presented as complete. Original results are not overwritten by disqualification. Checksums detect retained input/output/result drift; they are integrity checks, not protection from a malicious host rewriting everything. No automatic combined score, winner or capability inference is made.

```text
case/case.json + source/
experiment/1-1/attempt.json + result.json + patch.diff
experiment/1-1/workspace/             # original attempt, preserved
experiment/1-1/output/                # retained result files
experiment/1-1/evaluations/<id>/       # independent assessment and copied workspace
```

Keep bundles, attempts and evaluations outside candidate source repositories. Keep credentials out of prompt/config files and retained logs. Retention and cleanup are operator decisions, not automatic runner actions.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
npm pack --ignore-scripts --pack-destination /tmp
node scripts/verify-v2-packed-acceptance.mjs /tmp/yylo-benchmark-VERSION.tgz
```

The retained script filename is historical; it now verifies the thin v3 CLI from a local tarball with synthetic commands only. No publication, global installation or live model calls occur. Package version changes/publication remain a separate maintainer action.
