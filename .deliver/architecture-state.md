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
