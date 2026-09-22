# YYLO Benchmark

<p align="center">
  <a href="https://yylo.dev"><strong>yylo.dev</strong></a> ·
  <a href="https://github.com/yylo-dev/yylo">YYLO CLI</a> ·
  <a href="https://github.com/yylo-dev/yylo-ledger">YYLO Ledger</a> ·
  <a href="https://www.npmjs.com/package/%40yylo%2Fbenchmark">npm</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/%40yylo%2Fbenchmark"><img src="https://img.shields.io/npm/v/%40yylo%2Fbenchmark.svg" alt="npm version" /></a>
  <a href="https://github.com/yylo-dev/yylo-benchmark"><img src="https://img.shields.io/github/stars/yylo-dev/yylo-benchmark?style=social" alt="GitHub stars" /></a>
</p>

YYLO Benchmark provides two deliberately separate evaluation lanes:

- **Isolated v2 (default):** task prompts and ordinary Workflow Runner YAML execute in private fresh-repository attempt workspaces.
- **Governed workflow:** explicitly authorized production-touching workflows execute through a reviewed boundary with selected-step model overlays, typed exclusive locks, per-step envelopes, and blinded per-step judging.

The governed lane does not weaken or add production authority to isolated v2.

- Package: [`@yylo/benchmark`](https://www.npmjs.com/package/%40yylo%2Fbenchmark)
- CLI: `yylo-benchmark` (also delegated unchanged by `yy benchmark`)
- Source: [yylo-dev/yylo-benchmark](https://github.com/yylo-dev/yylo-benchmark)

## From the experiment log

[Ten CLI tasks, forty attempts: what our benchmark actually taught us](https://yylo.dev/blog/ten-task-cli-benchmark) covers our four-model, ten-task exploratory study: methodology, corrected results, cost coverage, and lessons from auditing the evaluator itself. It is **not a model ranking**: native integrity failures, changed prompt delivery, and unresolved evaluation uncertainty limit the findings.

## Boundaries

Benchmark owns case normalization, attempt isolation, retained evidence, evaluator provenance, recovery, doctor, and reports. The selected harness owns command/workflow interpretation, provider and model resolution, and process/session execution.

Model selectors are opaque. Benchmark has no provider allowlist, credential store, paid-command classifier, execution grant, reservation, or USD ceiling. Candidate and judge costs remain separate evidence; unavailable cost is never converted to zero. Running a plan grants no production or external authority.

## Install and inspect

Node.js 20.10 or newer is required. Pin the release selected by your operator:

```bash
npm install --global '@yylo/benchmark@VERSION'
yylo-benchmark --version
yylo-benchmark --help
yylo-benchmark init --stdout
```

These commands do not dispatch a candidate or judge. Publication and global installation are separate release-owner operations.

## Configuration

Create `yylo-benchmark.config.json` with `yylo-benchmark init`, then replace placeholders with project-approved profiles. The v2 shape is:

```json
{
  "schema_version": "yylo_benchmark_config.v2",
  "yylo_version": "INSTALLED_YYLO_VERSION",
  "workspace": {
    "attempts_root": ".yylo-benchmark/attempts",
    "registry_root": ".yylo-benchmark/registry"
  },
  "default_candidate_harness": "candidate",
  "harnesses": {
    "candidate": {
      "kind": "yylo_pi",
      "prompt": "Complete the configured benchmark case."
    }
  },
  "default_evaluators": [],
  "evaluators": {}
}
```

Supported harness kinds are `yylo_pi`, `workflow_runner`, and project-approved `command` adapters. Candidate and LLM-judge profiles select harnesses independently.

Evaluator profiles support deterministic commands and configurable LLM judges. The immutable plan binds both the initially selected profiles and the complete evaluator catalog available for later generation-only re-evaluation. Judge configuration binds prompt, rubric, selected evidence, byte limit, blinded or visible identity, single/reference/pairwise mode, settings, repetition/aggregation, and strict JSON or legacy `VERDICT: PASS|FAIL` parsing.

Deterministic evaluator profiles accept an optional positive integer `timeout_ms`.
Omitting it preserves the legacy 60,000 ms budget; an explicit value is bound into
the immutable evaluator profile and plan. Measure the complete check command,
including setup/build, rather than inheriting the candidate or judge budget.
For example, a reviewed long-running check profile may set `"timeout_ms": 600000`;
this is not a universal default. Changing the budget requires a new plan.

Required deterministic evaluations run before judges. Scoring judges are not
dispatched when candidate execution is invalid/unsuccessful or a required
non-judge evaluation is invalid. The retained `judge_not_dispatched` record has
unknown quality, no session and not-applicable cost, rather than a model failure.
A valid failed correctness check remains authoritative and is not an infrastructure
failure. Explicit diagnostic judging can opt in with judge profile
`"settings": {"diagnostic_on_invalid": true}`; this plan-bound diagnostic cannot
make an invalid candidate valid. External packet producers must fail their required
check when packets cannot be materialized; free-form prompt paths are not inferred
as prerequisites by Benchmark.

Keep workspace and registry roots ignored and private. The registry must be outside every candidate repository.
Prefer disjoint source, attempt and judge roots. For supported nested trusted-host
layouts, doctor distinguishes existing, resolved candidate-own paths in logs from
automatic source-prefix references; explicit protected bytes, routing environment,
Git configuration, credentials and manifest drift remain fail-closed. Missing,
ambiguous or escaping paths receive no exemption. This is evidence classification,
not filesystem isolation. Credential-like historical fixtures can still fail the
scanner: inspect and disclose them rather than weakening checks or deleting evidence.

A legacy `juno_benchmark_config.v1` file belongs to the governed-workflow lane; changing only its schema string is not a migration. Inspect configuration without mutation:

```bash
yylo-benchmark workflow migrate-config --input yylo-benchmark.config.json
```

When the input is isolated v2, pass an explicit unused `--output` path to create a governed template for review. Existing files are never overwritten.

## Governed production workflows

Use the explicit namespace for a tracked project workflow and policy sidecar, including paths under `.juno_task`:

```bash
yylo-benchmark --config yylo-benchmark.config.json workflow setup
yylo-benchmark --config yylo-benchmark.config.json workflow readiness \
  --models zai/glm-alpha,zai/glm-beta
yylo-benchmark --config yylo-benchmark.config.json workflow plan \
  --workflow .juno_task/workflows/daily_product_ops.yaml \
  --steps-file .juno_task/specs/benchmark/daily-ops-policy.yaml \
  --steps first,second,third \
  --models zai/glm-alpha,zai/glm-beta \
  --attempts 1 --output governed-plan.json --dry-run
yylo-benchmark --config yylo-benchmark.config.json workflow run \
  --plan governed-plan.json \
  --steps-file .juno_task/specs/benchmark/daily-ops-policy.yaml --dry-run
```

Planning and dry-run report `dispatch_count: 0`. Planning preserves canonical selected-step order and expands model × attempt × selected step. It hash-binds workflow and policy bytes/semantics, variables, selected scope, compiled per-model workflow bytes, source tree, installed YYLO version, and reviewed boundary identity. The compiler injects the exact selector only at recognized `yy pi` dispatches; the trusted boundary owns exactly one `--execution-envelope` transport and reconciles requested identity against observed child evidence.

Live `workflow run` requires the exact hash-pinned boundary and consumer-owned credentials. Credentials remain in child-process memory and must not be written to plans or evidence. Production resources execute under typed exclusive locks in strict plan order. Completed missing/malformed envelopes are durable harness failures; only genuinely unknown effects require manual recovery.

```bash
yylo-benchmark workflow recover --plan governed-plan.json --steps-file POLICY
yylo-benchmark workflow rejudge --plan governed-plan.json --steps-file POLICY
yylo-benchmark workflow doctor --plan governed-plan.json --steps-file POLICY
yylo-benchmark workflow report --plan governed-plan.json
```

Recovery reuses retained terminals, rejudge dispatches no candidate, doctor verifies the retained chain, and report derives per-step/per-model outcomes. Paid/provider and production execution always requires separate consumer authorization; package tests use synthetic boundaries only.

## Plan

Both case kinds produce `yylo_benchmark_experiment_plan.v2` and nested `yylo_benchmark_attempt_plan.v2` objects:

```bash
yylo-benchmark plan \
  --task benchmark/task.md \
  --models vendor-a/model-1,vendor-b/model-2 \
  --attempts 2 \
  --output task-plan.json

yylo-benchmark plan \
  --workflow .juno_task/workflows/evaluate.yaml \
  --models vendor-a/model-1,vendor-b/model-2 \
  --controlled-model-variable candidate_model \
  --var run_date=2026-08-31 \
  --output workflow-plan.json
```

Workflow YAML is hash-bound and passed unchanged to the configured Workflow Runner. String variables remain literal; object, array, boolean, numeric, and null variables are forwarded as canonical JSON so runner argv remains lossless and plan-bound. Benchmark does not parse command admission, reject ordinary `cwd`/environment/executable/managed-agent fields, or rewrite model arguments. With `--controlled-model-variable`, the report classifies the matrix as `model_only`; otherwise it is an `agent_system` comparison.

Planning is always zero-dispatch. `--dry-run` remains an explicit compatibility affirmation.

## Run and recover

```bash
yylo-benchmark run --plan workflow-plan.json --dry-run
yylo-benchmark run --plan workflow-plan.json
yylo-benchmark recover --plan workflow-plan.json
yylo-benchmark doctor --plan workflow-plan.json
yylo-benchmark report --plan workflow-plan.json
```

Every candidate receives a dedicated fresh repository plus private home, temp, cache, and config roots. Configured default workspace-root names are logical namespace inputs: candidate roots resolve to separate per-attempt OS-temporary locations, while the private registry resolves to a source-bound host state location outside the source repository. Candidate environments discard inherited values and PATH entries that disclose source, controller, registry, sibling-control, task, Git-routing, or credential handles. Default candidate subprocesses additionally run behind a selective filesystem sandbox that denies those protected roots (`sandbox-exec` on macOS or Bubblewrap on Linux); an unsupported or unprovisioned host fails closed before dispatch. The snapshot has a private `.git` database with no remotes, alternates, worktree links, future refs/objects, controller route, hidden graders, reference solutions, sibling paths, or registry path. Receipts distinguish that selective boundary from custom trusted-host workspaces and do not claim a container boundary.

Intent is durable before candidate or judge dispatch. After candidate execution and before terminal publication, Benchmark retains a deterministic post-execution manifest covering Git HEAD/tree/refs/index/status and every worktree file. Intentional edits, additions, staging, and commits are therefore accepted as the bound candidate result; later repository drift is rejected. Recovery reuses hash-verified terminals. Retained state is rejected unless its state, plan, attempt, initial workspace receipt, post-execution manifest, candidate harness/model, terminal, evidence, evaluator configuration, and evaluation IDs form one exact linkage. Reuse, recovery, doctor, report, and re-evaluation verify that complete chain. An attempt directory without terminal state is ambiguous and remains manual; it is not blindly dispatched again. Doctor and report fail closed unless every attempt in the immutable plan has the complete retained chain; zero or partial experiments are never reported as complete.

Candidate and evaluator subprocesses run in isolated POSIX process groups. A timeout records measured wall time only after bounded `TERM` grace, process-group `KILL`, direct-child close/reap, and confirmed process-group disappearance within an explicit cleanup bound, including when descendants ignore `SIGTERM`. Failure to confirm cleanup fails closed rather than publishing terminal timeout truth. Windows is rejected before dispatch because this package does not provide an equivalent job-object/tree-termination guarantee.

The YYLO Pi adapter retains identity and usage only from a schema-valid public envelope already captured on that invocation's stdout. On timeout, a captured numeric cost is `partial`, never final billing. Missing, truncated, or malformed envelopes leave identity and cost unknown; response text and shared Pi session directories are not telemetry sources. The current YYLO evidence pipe is terminal response text, not an incremental identity/usage feed, so most pre-envelope timeouts still have unknown usage. Intent hashes bind the cwd, invocation, and requested selector; terminal hashes bind retained observations. A valid receipt does not make a timed-out candidate successful or eligible for scoring judges.

## Re-evaluation

```bash
yylo-benchmark regrade --plan workflow-plan.json --profile checks-v2
yylo-benchmark rejudge --plan workflow-plan.json --profile judge-v2
```

Regrade and rejudge consume retained `AttemptEvidence`; they do not dispatch a candidate. The immutable plan binds the stable evaluator profile configuration; each repeated operation under that same profile ID derives and appends exactly the next generation, rejects same/non-monotonic replay, and aggregates deterministically with retained applicable records. Existing records are immutable, and historical required deterministic correctness/safety failures remain authoritative. A required deterministic correctness or safety failure cannot be overridden by judge prose.
Re-evaluation can only select profiles already bound in the original catalog.
If a repaired oracle or budget was not prebound, preserve the original plan and
results and record a separately bound evaluation-only protocol using retained
candidate evidence; do not call it a successful native regrade or rerun candidates
implicitly. Existing doctor/report failures stay visible until independently
verified with the selected implementation. Missing or malformed deterministic protocol fields, malformed judge output, timeout, privacy failure, missing identity/session, and evaluator-harness failure produce an invalid infrastructure evaluation with unknown quality.

## Evidence and reports

New durable objects use `yylo_version` and retain:

- requested, resolved, and observed candidate/evaluator identities;
- initial workspace receipt plus post-execution repository manifest hashes linked through terminal, evidence, and state;
- candidate truth separately from harness and evaluator validity;
- candidate and judge cost completeness separately;
- evaluator profile, prompt, rubric, output, generation, and provenance hashes;
- evidence/evaluation IDs behind every aggregate;
- valid resolved rate, invalidity, comparison classification, and generations;
- authoritative `runtime` evidence in milliseconds: per-attempt wall time with evidence ID/timestamps, per-evaluator measured time with evaluation ID/generation, and candidate/evaluator/combined aggregates.

Runtime remains separate from `candidate_cost` and `judge_cost`; no duration is inferred from token, billing, judge prose, or command-harness protocol claims. The launcher overwrites command-harness timing fields with its measured start, end, and elapsed wall time before evidence persistence.

The library exports a bounded hash-verifying projection for immutable v1 objects containing `juno_version`. It never rewrites historical bytes. Historical Daily Ops discrepancies are documented in [`docs/historical-daily-ops-evidence-inventory.md`](docs/historical-daily-ops-evidence-inventory.md) and are not v2 scoring oracles.

## Delegation

When compatible packages are installed independently, YYLO delegates argv, cwd, streams, signals, and exit status:

```bash
yy benchmark --help
yy benchmark plan --task benchmark/task.md --models vendor/model --output plan.json
```

The delegated and standalone commands use the same Benchmark executable and v2 contracts.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

Tests and packed acceptance use local deterministic harnesses. They do not make paid/live provider calls, mutate production, publish, install globally, push, or deploy.
