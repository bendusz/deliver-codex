# T09 source findings

Independent state_architecture map, from upstream migration reference and historical templates.

- pre-0.8 v0.7: tmp/pm-state.json, tmp/log.md, optional tmp/HANDOFF.md. Flat fields:
  project,spec,constitution,scale,phase,signed_off,approver,approved_date,integration_branch,
  current_sprint,total_sprints,current_story,current_story_status,current_story_verification_status,
  last_analysis_status,branch,parallel_batch,next,updated. Counters may be absent. Example uses
  legacy status `in review`, normalize only this known alias to `in-review`.
- 0.8: same flat state under pm/; adds current_story_rounds/current_story_retries/handoff_written.
  Parallel entries may only contain story,branch,worktree,commit,status with no builder/counters.
- 0.9-0.10.0: shared core assignments; per-actor current_story/status/verification/counters/branch/
  parallel_batch/next/handoff/updated. IDs are email-local-part slugs, no resolved_builder yet.
- 0.10.1+: full-email/name slug plus checksum salt :pm-skill. Resolved builder appears later.
  Contrary to current migration prose, the 0.20->0.21 rename preserved this algorithm and IDs.
  Only bare old self IDs need unambiguous reconciliation; never rewrite all pre-0.21 IDs.
- Preview only when no current marker exists and legacy state is readable; mixed formats are drift.
  Read integration plus known local/remote open story branch copies. Group evidence by owner/story.
- Newest credible timestamp selects status/branch, but counters use maximum credible observed value.
  Missing counters mean zero only when no source records any; conflicts and decreases are reported.
- Unknown/multiple owners, ambiguous aliases, unknown status, assignment disagreement or unknown
  builder require explicit mapping/route choices. Preserve teammates and explicit expert/codex route.
- Shared approval requires credible original approver/date plus tracked regular plan. Make declared
  migration plan edits first then compute digest. Missing evidence becomes pending, never invented.
- PASS alone cannot mark an unmentioned story merged. Require actual merged branch/commit or PASS
  plus matching merge history/log evidence. Handoffs/log are advisory, unknown data retained.
- Preview exact writes/removals; apply uses before-images/journal; commit migration once and carry
  into open story branches under existing authority. Preserve untracked/modified legacy history.
- Active .deliver runs and receipts remain historical; new binding requires reconciled baseline.
  Include fixtures for old tmp/flat/per-actor formats, aliases/conflicts, branch counter decreases,
  missing routes, interrupted apply, and PASS-only versus real merge evidence.
