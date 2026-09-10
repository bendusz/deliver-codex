# Integration correction contract

Accepted independent architecture refinement, 2026-09-10. Creation belongs to T05C; T08 diagnoses
and resumes it. This replaces the earlier assumption that every failed attempt already has M.

Keep finished source C immutable. Evidence-only M drift uses fresh M gates, independent review
and distinct verification at its actual manifest, without forcing a source edit. Actual source
findings or an actual composition conflict use the token-bound correction operation below.
No new permission checkpoint is introduced while the approved task contract remains unchanged.

## Discriminated correction basis

`prepareIntegrationCorrection(sourceRun,{integrationRecord,expectedRecordHash})` accepts one of:

- `basis.kind: failed-integration`: bind actual M/tree/manifest/evidence/finding identities;
  `basis.start_commit=M`.
- `basis.kind: composition-conflict-no-m`: bind the canonical L record path/hash/id, common
  repository, exact current integration ref/branch I/tree, finished source run/path C/tree/
  snapshot/manifest, and the bounded failed `git merge-tree --write-tree I C` probe identity
  (argv, tool version, exit, output/log hashes and observed time). `basis.start_commit=I`.
  No integration_commit field exists in this variant. A conflict probe is not an actual M.

Both bind current tracked approval/plan digest/integration branch, exact original packet/hash,
story contract/specs, actor/builder/source branch and in-review Execution hash, immutable root
run/baseline/adoption/review lineage, generation/unique correction branch, inherited findings,
and MAX counter-source identities. Reject free-form caller failures or substitute state bytes.

The real-M basis requires a current failing gate, a FAIL verification criterion, or an integration
review with FAIL or an unresolved block/major finding. Missing evidence, UNKNOWN alone, pending
workflow and superseded failures do not authorize a source correction. Preserve those states
as incomplete evidence until the applicable operation provides a current result.

Prepare requires canonical current approval, unchanged contract/scope/route, immutable finished C
still at its recorded source ref/worktree, the L record's actual failure, same common repository,
and no pending/started correction. For no-M, I must still be the clean checked-out integration tip,
not already containing C or completed closure; rerun the bounded probe and require the same
conflict classification. A moved integration ref requires a new preparation from the actual tip,
retaining the previous attempt as history. Plan/contract/scope drift requires revoke/replan.

## Exact claim and start state

PM creates `pm/<story-id>-integration-fix-<generation>` at basis.start_commit.
`startIntegrationCorrection(token,{correctionRoot})` requires the sole attached worktree for that
exact unique ref at I or M, clean index/worktree including flags and initialized submodules,
unchanged protected metadata, and current token/record/probe/approval/plan/C/contract identities.
Reject branch/ref races and collisions. Recompute the known lineage and MAX counters at start.

For no-M, I's story must have the same contract as C. It may be unclaimed or have an older
same-owner/same-builder non-merged Execution. Present owner/builder and safe unknown fields must
agree with C; foreign/merged or conflicting unknown metadata blocks. C's in-review Execution is
the authoritative latest claim lineage. Preserve C's safe unknown fields and change only the
correction branch, status building, timestamp and cumulative counters. The typed correction-start
audit records I's actual before-image/status, including from:null for unclaimed I; never pretend
I was in-review or relax the ordinary transition table.

Allow only the exact finished root/source/prior correction runs and retained old C ref named by
the token. Reject every active same-story run/correction, contradictory claim, unrelated duplicate
worktree/run and same-owner other-story work with PARALLEL_BATCH_REQUIRED unless T12 later proves
valid wave membership. There is no general exception for a matching story-ref prefix.

Counters use MAX across I/C Execution, root/source runs, L record, all prior same-lineage
correction runs and story state. Reject before mutation at fixes>=3. New rounds/fixes=max+1;
retries and corrections retain maxima; generation=max prior generation+1. No new ID hides a
later attempt, and no finished history or spent budget is reset.

## Durable publication and evidence

Capture the clean operational baseline/snapshot/Git anchor/contracts at I or M before writing
the new story Execution. Use the exact original packet. The optional correction binding names
the discriminated basis and original source/root identities; no-M must not reuse real-M fields
with nulls. Preserve a separate immutable root_review_lineage covering the original baseline,
all C candidates/evidence, inherited findings and the failed probe. The operational safety
baseline remains I or M; it must never be replaced by the original root baseline.

Consume in durable phases: prepared -> starting with a fixed run_id/branch; publish the exact
story/run pair through a typed recovery journal; then mark started. Recovery accepts only the
recorded legal before/after images. A starting/started token cannot allocate another run. Only
this token entry permits finished same-story ancestors; normal claim/start and Quick remain strict.

The correction builder reapplies/resolves the complete original task at I for the no-M case,
using retained C as reference, or fixes the actual integrated result at M. Every inherited finding
stays in review input and must be resolved with evidence. T04 adoption produces fresh C2, followed
by fresh gates, independent review and a distinct verifier. The review covers the complete task
from root_review_lineage plus the correction delta, never just the final patch. T05 then makes
a new integration attempt. No prior PASS is relabelled or reused as C2 acceptance.

Ownership: integration.mjs prepares/consumes tokens and validates L records; current-pm.mjs owns
the narrow recoverable Execution/run publication and MAX computation; state.mjs validates optional
bindings; pm/runtime CLI exposes correction-prepare/start. T08 only observes and routes pending
tokens/journals/runs. Frozen original runs, baselines, receipts and failed attempts remain intact.

Regressions: both basis variants; no invented failure; no-M unclaimed/older same-owner I including
counters and unknown fields; foreign/merged/conflicting I; stale I/plan/probe; exhausted/newly raised
MAX; exact old C ref permitted but unrelated active work rejected; dirty/flagged/submodule state;
torn token and story/run publication recovery; illegal after-images/third states unchanged; typed
audit reflects the actual start state; operational baseline at I/M and full root review lineage.
