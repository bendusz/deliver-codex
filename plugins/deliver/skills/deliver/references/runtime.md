# Runtime command contract

Run from the project root. Let `<runtime>` be the absolute path to this skill's
`scripts/deliver.mjs`. All output except help is JSON. A nonzero exit blocks the step.
Do not parse a success-looking fragment from a failed command.

## Initialize and start

```text
node <runtime> init --mode quick
node <runtime> init --mode managed --plan docs/plan.md
node <runtime> approve --run <run-id> --approver <actual-user-id>
node <runtime> start --run <run-id> --task .deliver/tasks/task.json --builder <agent-thread-id>
node <runtime> check --run <run-id>
```

Use the returned `run_id`. Quick does not require a plan or an approve operation.
Managed/Governed must use an actual approval received from the user, never an invented one.
Use `assets/task.example.json` for the task schema. Acceptance is an array of `{id,text}`;
commands maps gate names to exact command strings. An empty commands object explicitly records
that no automated gates are available, not that acceptance is waived.

Write packets, receipts and notes under `.deliver/` before recording them. Keep substantive
plans/contracts in their normal project locations. The runtime excludes its own `.deliver/`
storage from code snapshots. It detects edits to pre-existing dirty files as a conflict, even
inside touches, so explicitly reconcile existing work before starting an overlapping task.

## Gates and independent evidence

```text
node <runtime> gate --run <run-id> --name test --command "node --test tests/greet.test.mjs"
node <runtime> check --run <run-id>
node <runtime> review --run <run-id> --reviewer <reviewer-thread-id> --receipt .deliver/review.json --snapshot <reviewed-hash>
node <runtime> verify --run <run-id> --verifier <verifier-thread-id> --results .deliver/verification.json --snapshot <verified-hash>
node <runtime> finish --run <run-id>
```

Pass the exact snapshot hash provided to the reviewer/verifier, not a new hash obtained after
their work. The review receipt uses `assets/review.example.json`; verification uses
`assets/verification.example.json`. These examples show structure only. Never copy their PASS
or evidence text into a real result. Every acceptance ID needs actual evidence.

Gate commands execute through the platform shell, intentionally and only when explicitly
requested. Inspect commands before running them. They are not sandboxed by this helper. Logs
are local under `.deliver/logs/` and may contain sensitive application output; review before
sharing or committing them. `--env` names a JSON file of additional environment values; do not
commit that file if it contains secrets. Runtime records hashes, not environment values.

Gates run from the repository root and bind to code, command and an environment digest. Put a
necessary directory change inside the approved command. A gate that changes authoritative
files must be rerun against the resulting stable tree. External services, clocks and ignored
dependency contents cannot all be captured. If those change, rerun the relevant gate. Ignored
files under declared read/write paths are included in the code identity; other ignored build
outputs remain advisory. Declared read aliases include their resolved in-project contents;
aliases into runtime storage or outside the checkout are rejected. Write scopes cannot contain
symlink aliases. Initialized submodule contents are fingerprinted at their individual paths,
and their HEAD/index changes remain protected. None of this is an OS sandbox.

## State, limits and authorization

```text
node <runtime> status --run <run-id>
node <runtime> checkpoint --run <run-id> --label "Next: investigate failing AC-2"
node <runtime> correct-course --run <run-id> --kind retry --reason "Builder needs a clarified input"
node <runtime> correct-course --run <run-id> --kind fix --reason "Address the review's missing edge case"
node <runtime> correct-course --run <run-id> --kind plan --plan docs/plan.md --reason "Approved scope no longer fits"
```

Mutations support `--expected-revision` for optimistic concurrency. Per-run locks prevent
simultaneous state writes, not simultaneous code edits or distributed claims. Never delete a
live lock. Counter exhaustion requires escalation; a model switch does not reset counters.

One run owns one task. Preserve completed/abandoned runs and create a fresh run for the next task.
Do not restart a failed task under a new ID merely to reset its retry budget. Scope or contract
changes require explicit replanning and reconciliation before a new baseline.

Receipts and approval identities are workflow attestations, not cryptographic proof of who
acted. Filesystem permissions and host approvals remain the security boundary. Finish writes
completion state only; it does not stage, commit, merge, push or deploy.
