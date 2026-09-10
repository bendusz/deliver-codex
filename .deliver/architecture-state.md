# Independent architecture guidance for T02-T05

Source: native state_architecture agent, approved plan review. This is design evidence, not a
code review PASS for future implementation.

- Dependency direction: state -> basic persistence/hash; story -> state; project-state -> story/state;
  pm -> project-state/story/state; scope must not create a cycle through pm. Runtime composes them.
- Story acceptance has ordered text, checked flag and line, not invented stable IDs. Runtime packets
  retain their independent acceptance IDs and compare ordered text exactly.
- Hash the full story contract with only the precisely delimited final Execution section removed.
  Reject duplicate/ambiguous sections and invalid metadata; never exclude an entire story or docs tree.
- Inspector reads current marker, plan policy, stories/Execution, Git claims, worktrees, handoff,
  missing retrospectives and unreadable stories. Missing identity does not block discovery/status.
- Current format remains detectable if marker is malformed/nonregular, deleted but tracked in Git,
  or recognizable root story metadata remains. An arbitrary plan alone is not shared provenance.
- Bind current execution to tracked regular marker and plan with matching approved Git blob digest,
  owner, branch, resolved builder, story contract/execution hashes, and bounded packet scope.
- Preserve legacy bindings as a tagged union until explicit migration. New projects use current format.
- Check binding on check/gate/review/verify/finish. Search existing runs to prevent budget reset.
- Transition statuses claimed -> building -> built -> in-review; fix returns to building; blocked
  is explicit; only verified integration can mark merged. Persist retry/fix increments before dispatch.
- Recover torn story/run publication with before-image checks, unchanged contract/ownership and the
  maximum spent counters. Never decrement a spent budget.
- Commit adoption is two-phase: prepare audited source/Execution entries and protected Git metadata,
  then PM stages exact paths and commits. Adoption accepts only the specified current HEAD that is
  one direct child of the prepared HEAD, same branch, clean index/tree outside runtime evidence,
  identical intended entries and unchanged Git config/hooks/excludes.
- Keep original content baseline and dirty-file protections immutable. Add a mutable git_anchor for
  accepted coordinator HEAD/index transitions; cumulative scope stays measured from task start.
- An adopted HEAD changes snapshot identity. Clear and rerun gates/review/verification; never relabel
  old PASS evidence. Worker commits continue to fail the normal audit.
- Complete only after actual local/remote merge on the integration branch with contents matching
  verified code. Changed integration contents require fresh evidence. Write merged status and merge
  SHA note, then commit close metadata; BASE_COMMIT handoff points at the actual resulting commit.
- Remote PR merge must check current branch/check/head/merge SHA, use normal branch protection and
  exact-head matching, and never infer success from exit code alone.
- Future PM pushes should avoid writing branch tracking config while workers have active baselines.
  This run observed and recovered that issue by restoring only coordinator-created tracking settings.

Key regressions: malformed/FIFO state never done; revoked/deleted approval blocks shared Quick;
foreign/duplicate claims cannot reset retries; exact audited commit adoption keeps cumulative scope
and expires old receipts; altered integrated contents cannot be marked merged from old verification.

## T04/T05 final closure lineage, independently clarified

1. Candidate C contains audited source and final pre-integration Execution `in-review`. Normal
   T04 direct-child/exact-content commit adoption advances git_anchor, retains original scope,
   clears old evidence. Run fresh gates/review/verifier at C. `.deliver` evidence may remain
   uncommitted. Finish certifies source evidence at C, not merged project progress.
2. Integrate C to actual M. Validate actual task/source entries and story contract against C;
   record integration-verification lineage C/evidence snapshot -> M. Conflict resolution or
   source/contract delta needs fresh gates/review/verification. Squash/rebase requires explicit
   reconciliation; no-ff history is default.
3. Deterministic closure commit E changes ONLY this story's final Execution from in-review to
   merged, updated timestamp, and actual M merge-SHA note. Preserve owner/builder/branch/counters,
   unknown safe metadata and contractHash. Validate exact before image and path/content delta.
   E is a closure record, not a relabeled code-evidence snapshot. It does not use normal adoption
   to clear the already retained evidence; it has its own validated lineage.
4. Separate handoff-only commit H writes current actor handoff with BASE_COMMIT E. A commit
   cannot contain its own SHA. Upstream treats H current because everything after E changes only
   that actor handoff. Do not combine Execution closure and handoff with BASE_COMMIT M.
5. Journal C/M/E/H for recovery and recheck ancestry/trees/exact diffs. Any extra path, changed
   story contract or source during E/H leaves the metadata exception and needs fresh evidence.
   Protected remotes may need closure PRs but retain E then handoff-only H semantics and checks.

Integration must support a finished source run in its story worktree and a separate integration
checkout in the same Git repository. Preserve source run.project_root and baseline identity;
validate common-repository identity and explicitly record destination checkout/commit in the
integration lineage. Do not rewrite a run's project_root or pretend its original evidence was
captured in the integration checkout. This is required before T12 parallel worktrees.

T08 native routing: project-state.next_reference deliberately retains upstream 0.25.1 names for
compatibility (planning-and-signoff, implementation-loop, migrations, documentation). Doctor/resume
and hook must map those phases to actual installed native references (planning, workflow/runtime,
migration, shipping/recovery), or expose a separate native_reference. Do not send users to missing
upstream-only paths or alter the compatibility next_reference field merely to route native code.

## T03/T12 current claim precedence

- Public sequential claim publishes from a clean integration checkout at the inspected plan
  integration tip, ignoring only framework execution evidence. Target story is authoritative
  first: unreadable blocks, merged is terminal, any other Execution status holds the claim.
  Same owner resumes its existing run/counters; foreign ownership blocks.
- Only for an unclaimed target, inspect target-scoped local and fetched remote story refs plus
  attached worktrees. Use an exact `<story-id>-` boundary; S1-1 never matches S1-10. Hidden or
  ambiguous claim signals block; no automatic deletion/adoption of refs/worktrees.
- Proven integration/closure outranks retained old source-ref copies still marked in-review.
  Accept native C/M/E lineage or equivalent legitimate upstream Git merge/closure evidence;
  imported upstream completion must not require a Codex .deliver journal. Manual merged text
  alone cannot suppress contradictory active evidence. Retained proven-old worktrees are
  cleanup advisories, not global blockers for the next story.
- Key runs/claims/counters by repository + story/owner/branch, not actor globally. Foreign claims
  on independent other stories do not block globally. Public sequential same-actor concurrent
  work may return PARALLEL_BATCH_REQUIRED. T12 later prevalidates an independent wave against
  one integration tip and publishes its Execution claims before worktree dispatch.
- Keep pure claim conflict preparation separate from publication; no new actor.active_story or
  batch backlog file. Remote visibility is local plus fetched tracking refs, never distributed
  atomic locking or claimed current remote freshness without evidence.

## Accepted T04 CLI preparation

- `pm transition --run RUN --to building|built|in-review|blocked [--attempt fix|retry] [--reason TEXT]`.
  Legal forward path claimed->building->built->in-review, explicit blocked, and bounded fix/retry
  return to building. Same-state resume is a no-op. Current-bound correct-course fix/retry must
  route through the same atomic story/run counter transition; standalone/legacy keep their
  existing behavior. T05 alone records merged.
- `deliver commit-prepare --run RUN` records audited parent/branch/paths, exact expected tree via
  a temporary index, protected metadata and nonce. No live .deliver receipt is staged.
- `deliver commit-adopt --run RUN --token TOKEN --commit FULL_SHA` accepts only the exact single
  direct-child commit and matching tree/index/worktree/protected metadata. Advances git_anchor,
  preserves original baseline/dirty paths, records adoption, clears all earlier evidence.
- Support necessary intermediate PM commits in claimed/building/built/in-review states. Only
  the final candidate C must be in-review. Requiring in-review for every intermediate commit
  would break the approved commit-as-you-go workflow.
- Story/run before/after journals preserve contract, owner, route, branch, safe unknown fields
  and MAX credible spent counters across torn publication. Metadata normalization applies only
  to the bound, audited Execution entry, never whole stories or arbitrary docs paths.

## T05 shared verification separation

The approved plan requires a separate final verifier at every current shared-project scale.
T03 preserved existing mode-based receipt handling; T05 must enforce the current binding rule
at verify, finish, state validation and integration reconciliation. Current shared Managed/Quick
cannot use the same reviewer/verifier. Standalone Quick/Managed behavior remains unchanged.
This is a release acceptance requirement, not a new user approval checkpoint.

## T13B coordinator preparation (pending architecture review)

Upstream comparison permits at most one clarification retry, independent of normal delivery
retry/fix budgets. Both candidates use the same approved tracked story and fixed clean base,
identical deterministic gates and risk-selected independent review, with no persisted route
change, merge, push or automatic route selection. Prevalidate two distinct effective available
native configurations before any worktree mutation. Each worktree and result remains isolated;
never expose one candidate result to the other builder. Preserve dirty or failed worktrees.
Native host dispatch must be an explicit callable adapter or prepare/dispatch/record protocol,
not a claim that a dependency-free Node process can call the host's collaboration tools itself.
The CLI must support the real documented native flow; fake-adapter test support alone is not
a completed user operation. Availability/model/role must be positively reported, no guessed
substitution. Snapshot-bound gates and independent review are measured evidence; tokens/cost
are null unless exposed. Restart must retain first response, spent retry and incomplete dispatch
without double-dispatching or replacing failed evidence. T13A scorer remains deterministic.

## T08 coordinator preparation (pending architecture review)

Use the T07 analyzer on the live artifacts for every first claim. A caller-supplied analysis
JSON cannot replace deterministic recomputation. Standard/large/regulated semantic review
attestation must bind the recomputed pre-claim story scope, content and analysis identities,
identify its reviewer, cover every required semantic item and retain located findings. Missing,
stale, incomplete, UNKNOWN or unresolved blocking review cannot authorize claim. Tiny/small
skip mandatory semantic review but still enforce factual readiness, valid approval and claims.
Same-owner legitimate resume retains its claim/run/counters and must not be made impossible by
an analyzer rule that expects an unclaimed story. Existing lifecycle fixtures must provide real
required project artifacts or choose an explicitly valid tiny/small policy; never add a hidden
test bypass. Large/regulated checklists remain required evidence, not automatic checkbox PASS.

Keep doctor, resume inspection and hook observational. Hook stdin is byte-bounded before JSON
parse; nonregular files, symlink escapes and malformed state are bounded diagnostics. No gate
execution, model calls, config edits, fetch, migration, lock deletion or report writes during
inspection. CLI may explicitly emit an environment report, separated from the read-only module.
Environment probes report available executables and declared requirements, not unsupported
claims that an entire arbitrary shell command will succeed. Never print config/secret values;
check required names only. Hook resolves the same packaged inspector/diagnostics, with stable
native_reference mapping while upstream next_reference remains unchanged.

Material correct-course must revoke shared approval with recoverable before-image publication
and retain all spent retries/fixes and historical evidence. A new baseline requires explicit
reconciliation; it cannot reset an active story budget or resurrect an old PASS.
