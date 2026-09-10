# Integration correction contract

Accepted architect decision, 2026-09-10. Creation belongs to T05C. T08 diagnoses and resumes it.

Keep the finished source run C immutable. When M needs fresh evidence only, record fresh M
gates, independent review and distinct verification against its exact manifest in the integration
record. Do not force a code edit or new source run just to refresh evidence. Actual source findings
use the correction path below. No new scope approval is needed while the approved contract holds.

`prepareIntegrationCorrection(sourceRun,{integrationRecord,expectedRecordHash})` accepts only a
current-bound finished ancestor whose story is still same-owner/in-review, an exact failed or
non-clean M record, current tracked approval/plan, unchanged story ID/acceptance/touches/spec list,
and no other active correction. Reject changed plan/story contract/scope and route to revoke/replan.
Reject caller-supplied free-form failure claims. Persist a token binding source run/C, integration
record/I/M/tree/manifest, inherited unresolved findings, actor/builder, exact original packet and
MAX fixes/retries across story, source run and every prior same-lineage correction run.

PM creates `pm/<story-id>-integration-fix-<generation>` branch/worktree at exact M.
`startIntegrationCorrection(token,{correctionRoot})` rechecks token/hash, common repository,
branch/tip=M, clean index/worktree, approval/contract/owner and absence of active same-story runs.
One recoverable whole-pair journal changes only Execution route/status/counters and creates the
active run. Set branch to correction branch, status building, rounds=maxFixes+1, retries=maxRetries;
preserve owner/builder/unknown fields. Fail before publication if fix limit 3 is spent.

The new binding carries `correction:{root_run_id,source_run_id,source_candidate,source_snapshot,
integration_record_hash,integration_commit,generation}`. Use the original unchanged packet and
capture baseline at M. This continues the held claim; normal claim/start rules remain strict.
Only this tokenized entry permits finished same-story ancestors. Reject active duplicates and
unrelated same-owner active work unless T12 later supplies a validated wave membership.

Preserve all original runs/receipts as immutable history. Every inherited unresolved M finding
must appear in the new review input and be resolved with evidence before PASS. T04 adoption
produces C2 on the correction branch. Gates/review/distinct verification are fully fresh at C2;
T05 performs a new integration attempt. Never relabel old PASS or reset attempt budgets.

Ownership: integration.mjs prepares tokens and validates integration records; current-pm.mjs
publishes the narrow recoverable Execution/binding pair and computes MAX counters; state.mjs
validates optional correction bindings; pm/runtime CLI wires correction-prepare/start. T08 only
observes pending tokens/journals/runs and identifies the correct explicit continuation.

Regressions cover evidence-only M refresh; token cannot invent a failure; branch/tip/race/dirty
checkout reject before mutation; finished ancestors allowed but active duplicates rejected;
MAX survives multiple generations; inherited FAIL cannot disappear; plan/contract/scope drift
requires replan. Genuine torn journals recover; illegal after-images and third-state conflicts
leave all files intact. No unbound Quick escape or baseline rewrite.
