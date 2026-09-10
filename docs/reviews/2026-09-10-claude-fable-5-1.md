Claude Fable 5.1 completed the requested code and project-design review at high effort. The overall review is FAIL. Local integration remains unaccepted while the findings are resolved; the full upstream parity project is still in development.

The review used the actual `claude-fable-5-1` CLI through the bundled adapter, with `CLAUDE_CODE_EFFORT_LEVEL=high`. Four distinct packets were reviewed once each. There were no provider retries or model substitutions. The adapter received selected source and specifications with tools disabled. It did not run tests. Token usage and cost were not retained by the adapter and remain unknown.

| Review packet | Claude result | Raw findings |
| --- | --- | --- |
| Runtime state and transitions | FAIL | 3 major, 8 minor |
| Integration and evidence | FAIL | 1 blocking, 2 major, 5 minor |
| Public behavior and remote operations | PASS | 9 minor |
| Planning and support | PASS | 8 minor |

These 36 observations are not 36 confirmed defects. Independent native triage checked the full dependencies and approved contracts. Original provider receipts remain unchanged.

The accepted source is based on `e6d9c44`, with the frozen T05L candidate supplied as an overlay at snapshot `10c782b2bc1cd025b41eefbaf7b3ade860ebb1dcf2af74e17226d89425bb7de9`. That candidate passed 153 tests, packaging validation and native review/verification before this broader review. The combined accepted remote adapter plus local-integration overlay has not yet been integrated and tested as one tree. Passing the earlier gates does not resolve the new review findings.

Confirmed recovery defect: a legal correction can retain a stale commit preparation. A disposable repository reproduced successful preparation and correct-course followed by rejected re-preparation, rejected commit adoption and rejected finish. The missing operation must preserve the old preparation in history and allow bounded reconciliation only against the same run, binding, parent and protected Git state. Transitions must refuse or explicitly reconcile preparations they invalidate. This belongs to the implemented T04 lifecycle and cannot be dismissed as future diagnostics work.

Confirmed integration blocker: after verification-report adoption, changing only TERM_SESSION_ID makes closure and even gate refresh fail. In another disposable repository, returning to the recorded merge commit and rerunning a gate succeeded but invalidated finalization; returning to the adopted report then left both closure and gate refresh blocked. The bounded reproduction passed its failure assertions. Adopted report/closure/handoff proofs must validate their frozen identities independently of current process environment. Evidence mutations must be refused once dependent artifacts are adopted unless an explicit audited supersession path exists. Fresh evidence requirements before adoption must remain enforced. This fails T05L acceptance criteria AC2 and AC3.

Confirmed review-receipt defect: panel parsing accepts a top-level unresolved major finding alongside PASS members, then silently returns an empty finding list. Native verification marks T05L-AC5 FAIL. Require an exact normalized aggregate or a clearly specified empty aggregate shape, and test extra, missing and mismatched findings.

Other confirmed smaller issues include first claim of a story without a trailing newline, missing headline analysis status in Markdown, zero-duration benchmark scoring, nonresolving paths in the packaged SpecDD example, a role-validator whitespace gap, and inconsistent fetch/push remote identity in the final merge proof. The individual triage files separate source inspection from executed reproductions and map each issue to its implementation scope.

A stale integration preparation after the integration tip advances is a real unfinished capability assigned to T05B; failed probes feed T05C. The initial native receipt included this as a T05L major. Scope reconciliation retains the finding under its planned owners without changing the original receipt. Whole-tree proof cost is a credible but unmeasured scaling risk.

Several proposals were rejected as defects. Bounded blocked-builder redispatch, refusal of unreadable ownership state, and integration-checkout validation during claim follow the approved contracts. Story path traversal is already rejected by a dependency omitted from one packet. The latest user instructions retain `pm/` as the upstream-compatible progress authority; Claude's suggestions do not authorize replacing that policy.

The review supports the project's no-sandbox default and standing PM authority for scoped commits, pushes, PRs and verified merges. Documentation must consistently describe that policy. Remote lifecycle wiring, correction runs, resume/doctor, migration, retrospectives, knowledge workflows, parallel delivery, live benchmarking and the installed native trial remain unfinished work, not review-verified functionality.

All shipped production files and assets were supplied across the four packets as complete files or complete added-file diffs, excluding legal texts. Each call saw only its own packet. Selected tests, pinned fixtures, future detailed design documents and execution histories were omitted. One test file contains synthetic credential-shaped fixtures rejected by the unchanged adapter scanner and was omitted in full. The packet manifest records exact coverage and hashes.

Evidence is in [the review manifest](../../.deliver/claude-fable-5-1-review/manifest.json), with the four raw receipts, invocation sidecars, source packets and native triage. [The frozen candidate checkpoint](../../.deliver/checkpoints/T05L-fix4-claude-review/manifest.json) preserves the source patch, original run, approval, native PASS receipts and gate logs. Its patch was checked against the original base using a disposable Git index.

The proposed next repair is one additional bounded round for each affected task: T04 commit-preparation reconciliation and T05L adopted-proof/finalization recovery and panel aggregate consistency. Keep T05L on its original active run and baseline. Preserve completed T04 as immutable history; any follow-up must bind its original review lineage, cumulative scope and spent counters while inspecting the current accepted tree. Preserve all failed evidence. Add targeted regressions for interruption, changed process environment, stale preparation, refused mutation after adoption and preserved history, plus panel aggregate mismatches, then run the declared gates and independent review/verification again. Do not spend a new round or start a replacement run to avoid the limit.

T04 has spent its three fix rounds. T05L has spent the fourth round explicitly approved in this conversation. The installed Deliver skill requires stopping at the fix limit, so these two additional rounds need a scoped user decision. The draft PR remains unmerged.
