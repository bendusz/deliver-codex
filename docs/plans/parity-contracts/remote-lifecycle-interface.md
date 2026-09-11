# T05B remote lifecycle interface

This preflight clarifies the already-approved T05B and remote-design.md requirements. It preserves the standalone provider adapter, local integration behavior, original task/approval and all source attempts. No provider call is authorized by this document alone. The existing approved delivery scope supplies PM Git authority.

## Record and operation ownership

`integration.mjs` owns an optional validated `remote-publication-v1` envelope on the existing canonical integration record. All mutations use the existing expected-record-hash lock. `remote.mjs` stays stateless. `current-pm.mjs` validates terminal project state and claim visibility.

Retain immutable source-publication, closure-publication and handoff-repair attempts, their exact inputs, result identities and predecessor hashes. Each provider write has states prepared, executing and observed. Persist prepared before the call, enter executing under the record lock and reject concurrent execution. Retain the exact result in observed. After interruption, executing permits only read-only reconciliation. Adopt a proven exact effect; replay only after proving absence and that the prior invocation has ended, first returning the same token to prepared. Ambiguous lookup remains unresolved. A poll, a resumed operation or a later queue completion does not spend a publication retry. Only replacement after a proven `HANDOFF_BASE_RACE` spends a retry; allow two retries after the initial attempt. Publication counters never mutate source run counters. Supersession is allowed only before merge proof, after a proven base or head change, and names the exact predecessor hash. It cannot discard successful merge proof. Poll pending/queued results read-only; reconcile exact effects on the same attempt; replay the same token only after proven absence and ended invocation; supersede only the qualified unmerged attempt; terminal or ambiguous states permit no provider write.

Expose actual PM operations for source publish/readiness/merge/reconcile, closure prepare/publish/reconcile, handoff-repair prepare/publish/reconcile and completion prepare/adopt. CLI wrappers call the corresponding integration functions and return explicit pending/failure/proven states. Unknown provider states never authorize a later mutation.

## Source merge and current integration result

Keep `source_merge_commit` separate from `verified_integration_commit` M. The former is the actual provider result. The latter is the actual fetched integration tip that receives fresh integration evidence and becomes the closure base. Fetch into a unique recorded proof ref without changing shared tracking configuration.

For a normal merge, prove the base and source parents, source C ancestry and recomputed merge tree. For squash, prove a direct child of the uniquely established merge base with the expected tree and bounded source delta. For rebase, prove the bounded first-parent range from the established base, exact final tree and bounded source delta. An unrecoverable or ambiguous base/composition returns `LINEAGE_UNPROVEN`. No commit label substitutes for Git proof.

If the remote tip advanced after the source merge, prove source_merge_commit ancestry, bind manifests to that actual tip and obtain fresh gates, independent review and distinct verification there. Changed task bytes receive actual review. Preserve the original finished source and previous evidence. Closure E names freshly verified M. Store the remote result in a separate remote.integration_evidence slot with explicit prepare, gate, review, verify and finalize operations. Bind every receipt to the fetched M and its manifest; closure preparation names that finalization identity. Do not overwrite immutable local integration.commit or its original receipts. An interrupted remote evidence phase resumes against its own retained identities.

## Closure checkout and publication

`prepareRemoteClosureCheckout` binds a canonical clean checkout, common repository, unique recorded branch, exact M base and Git anchor. The artifact engine accepts only this validated context for remote closure. Existing local T05L operations retain their destination behavior.

P/E/H retain their existing allowlists and exact ancestry. P is required or omitted according to the approved reporting policy. E changes only merged Execution and names M. H changes only the actor handoff with BASE_COMMIT E. These local artifacts are provisional until remote closure and terminal adoption are proven.

Publish one ordinary non-draft closure PR and merge with the normal merge-commit method and exact head check. Unsupported merge policy remains explicit. For normal R require ordered parents [M,H], tree(R)=tree(H) and intact P/E/H ancestry.

If the base raced, `closure_published/handoff_stale` requires ordered parents [advanced-base,H], advanced-base descent from M, exact H blobs on every closure path, unchanged M preimages for those paths in advanced-base, and exact advanced-base entries everywhere else. Concurrent story, report or handoff changes cannot be overwritten by selecting H during merge. Extra paths, conflict rewrites and ambiguous lineage refuse completion.

At handoff-repair preparation, N is the current fetched tip containing the proven closure R. H2 must directly descend N, change only the actor handoff and use BASE_COMMIT N. Publish and merge normally. S must have ordered parents [N,H2] and tree(S)=tree(H2). Another race returns `HANDOFF_BASE_RACE` and retains the attempt before any bounded replacement. Source gates are not relabelled for a handoff-only repair.

## Read-only provider reconciliation

Add `reconcileMerged(target, { prNumber })` to the standalone adapter. Validate exact repository, owner, PR number, expected head OID and base. Require MERGED with a full merge commit and read the remote base. This operation performs no push or merge command and must work when the remote head branch was deleted after merge.

Return `MERGED` when the remote base equals the merge commit; return `MERGED_BASE_ADVANCED` with both OIDs when it differs, pending actual fetched ancestry proof in integration.mjs. Missing/malformed proof is UNKNOWN. Open/queued remains pending. Never treat an initial PR_MERGED label alone as completion.

## Terminal local adoption

`prepareRemoteCompletion` binds the fetched proven R or repaired S, previous local integration HEAD, exact wrapper proof, merged story bytes and fresh handoff. It returns an immutable completion token and exact fast-forward target. PM performs the fast-forward under existing authorization. `adoptRemoteCompletion` verifies the actual HEAD, tree, branch, clean index/worktree and protected metadata against that token before recording completion.

Record remote_closure_proven once R or S is proven, then local_adoption_pending until the integration checkout fast-forwards and completion adoption succeeds. Inspectors may report remote proof while local adoption is pending. The authoritative local integration checkout must expose the proven terminal story and handoff before native claim release or the next story can be claimed. Until completion adoption, retain the native in-review claim. Existing imported-upstream completion precedence remains unchanged. Refuse non-fast-forward movement, changed terminal bytes or dirty/protected-state drift. An interrupted adoption resumes against its original token and actual before/after state; it does not allocate a replacement approval or reset counters.

## Acceptance probes

Use the fake provider and real temporary Git history. Cover source merge/squash/rebase proofs, unrelated advanced tips and altered task bytes; normal and raced closure with wrong parents/extra paths/conflict rewrites; H2/S repair and exhausted publication retries; crash after push, PR creation, queue acceptance and server merge; already-merged recovery with deleted source branch; missing/malformed provider data; normal R and repaired S completion, dirty/non-fast-forward refusal and fresh-process next-story readiness. Also cover remote-M evidence interruption without changing original local receipts; concurrent provider invocations, exact absence versus ambiguous lookup and stale predecessor hashes; concurrent closure-path changes resolved to H; and crashes before/after local fast-forward with fresh next-story claim attempts. Assert no real network/model calls, force/admin/auto/delete-branch options, shared config mutation or source counter reset.
