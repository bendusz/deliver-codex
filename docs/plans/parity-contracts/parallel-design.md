# T12 read-only design

Prepared by native benchmark_builder; no source edits. T05/T08 interfaces must exist before
implementation. Integrate through the exported T05 source-worktree/separate-integration-checkout
helper, not a duplicated private/CLI-only implementation.

## Native operation phases

1. `prepareParallelWave(root,{stories:[{storyPath,branch?,worktreePath,semanticReview?}]})`
   reads 2-3 unique stories, repository identity, integration branch/full base/approval digest,
   owner/route/branch/worktree/touches/dependencies/contract/readiness/semantic receipt and before
   Execution identities. Output is a preparation identity and honest remote visibility.
2. `publishParallelClaims` recomputes every prerequisite under the PM lock before one recoverable
   all-story before/after publication. Strict optional wave metadata records ID/base/members
   per Execution, never an actor-wide active_story or a second project backlog.
3. PM commits every claimed story together. `verifyParallelPublication` proves one direct child
   of the prepared base, exact story-only diff, unchanged contracts and exact prepared Execution.
   No branch/worktree creation precedes this proof.
4. `createParallelWorktrees` prevalidates all distinct branch/path slots, then creates each at
   the same verified publication commit. Races/failures preserve partial work for explicit
   recovery; never force rollback or delete dirty worktrees.
5. `inspectParallelWave` is bounded, observational and noncreating. Derive per-member claim,
   worktree/branch/HEAD/dirty, actual run/evidence/counters and integration lineage from stories,
   Git and local execution records. Missing/ambiguous evidence remains explicit.
6. `prepareSerialIntegration` uses T05 against original source root/current integration checkout.
   Sibling integration must not change candidate intended blobs/contracts or overlapping scope;
   source/conflict changes require fresh evidence. Never rewrite sibling receipts.
7. Explicit cleanup only after proven merged lineage and clean worktree; no --force. Failed,
   dirty, blocked, unmerged, unreadable or ambiguous worktrees remain intact. Branch deletion
   is a separately explicit safe action.

Whole-wave prevalidation includes executable T08 analysis/semantic readiness; clean exact
integration branch/base; target-first T03 claim precedence; already-merged dependencies (no
within-wave dependency); pairwise prefix-aware nonoverlap and no crossed active ownership;
distinct valid exact-story branch names; no local/fetched-ref/worktree ambiguity; unique absent
worktree paths; explicit supported routes. Failure must precede story/ref/worktree mutation.

Refactor only the narrow existing pure claim-preparation/publisher needed in current-pm. Do not
export a generic arbitrary-file transaction as public authority. T12 packet owns current-pm;
add integration.mjs only if T05 fails to export the accepted integration helper.

CLI may use bounded regular JSON `parallel.mjs prepare|claim|worktrees|status|integrate-check|cleanup
--input file`, with JSON stdout, no stdin/FIFO, providers, network or implicit fetch. PM can fetch
under existing authorization and rerun preparation; observed tracking refs are not a freshness
or distributed-lock claim. Push without changing branch tracking config.

## Coordinator refinements

Same-owner parallel-binding allowance must validate actual whole-wave publication lineage, not
trust optional user-written wave membership alone. A .deliver wave preparation/publication
proof is allowed execution evidence/journal; project progress still comes from stories and Git.
Only truly never-claimed members receive zero initial counters; retain MAX credible historical
attempts. Safe unknown Execution preservation carries wave metadata through transitions/closure.

For an explicitly enabled upstream external-runner wave, document its different all-ref/worktree
fingerprint: create/preflight all worktrees and publish all building metadata before dispatch;
avoid ref/index/worktree-changing Git commands until all external builders return. Native
Deliver protects local checkout identity and shared configuration, not unrelated sibling refs.
