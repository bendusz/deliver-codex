# Fable 5.1 review, 19 September 2026

Both requested `claude-fable-5-1` reviews completed with high effort and returned **FAIL**. The calls completed in about four minutes, with no retry or model fallback.

The review covered the frozen code from before Astra's repair. It used two bounded packets for provider/source merging and artifacts/handoff recovery. It is not a final release review or a review of the entire parity project. Fable had no tools and did not run tests.

## Results against the repaired candidate

Astra's repaired candidate `232f5d3e1c04cf155b6b0c96f85f988dec93c9588f6a2a70a2b9d7ef165a88d2` passed all 349 tests in 486.4 seconds and packaging validation. The tested files remain unchanged.

Two Fable findings were then reproduced on that candidate in a disposable Git repository:

- Attempting a merge while checks are pending leaves the durable attempt in `executing`. Once checks pass, another call remains pending without issuing the merge.
- A merge initially observed as queued has no retained effect. When the provider later completes it, reconciliation refuses the source proof.

Independent source review also identified two remaining recovery failures: resetting evidence after preparing the closure checkout can create an artifact that cannot be adopted or recovered, and an integration-base race before the H2 merge is rejected before recording the bounded repair retry. The independent review returned FAIL. The distinct verifier returned PASS for the provider-adapter criterion and FAIL for the two complete-lifecycle criteria. All 25 previous review findings are resolved; four new blockers and one minor summary-validation omission remain.

Several old-code findings overlap repairs already made by Astra, including replacement H2's base, executable modes, existing-report protection and receipt actor/criterion validation. The old Fable FAIL must not be relabelled as a review of the changed code. Some external findings also require qualification against explicit project contracts, including the intentionally conservative rule for a lost provider invocation in a new process.

## Evidence

- [Review input, hashes, invocation times and scope](../../.deliver/fable-review-2026-09-19/manifest.json)
- [Provider/source findings](../../.deliver/fable-review-2026-09-19/provider-source.receipt.json)
- [Artifact/repair findings](../../.deliver/fable-review-2026-09-19/artifact-repair.receipt.json)
- [349-test gate](../../.deliver/checkpoints/T05B-fix3-candidate/test.json)
- [Packaging gate](../../.deliver/checkpoints/T05B-fix3-candidate/validate.json)
- [Current-code defect reproduction](../../.deliver/checkpoints/T05B-fix3-candidate/fable-current-repro.log)

- [Independent current-code review](../../.deliver/review-T05B-fix3.json)
- [Distinct acceptance verification](../../.deliver/verification-T05B-fix3.json)

No release merge is justified by these results. This is the third repair on the original run; no fourth round has been dispatched.

## Recommended next change

Keep the existing task and run, and authorize one bounded additional repair only if continuing:

1. Preserve pending-check observations as valid non-effect states and permit readiness to recover without issuing duplicate merge writes.
2. Reconcile an observed queued merge onto its original attempt when the provider proves completion. Pending remains insufficient proof for replay.
3. Keep closure checkout and P/E/H preparation bound to finalized evidence, refusing invalidation or artifact mutation that would make recovery impossible.
4. Prove an advanced H2 merge base, retain the race and permit the bounded replacement instead of leaving the adopted attempt stuck.
5. Enforce the existing string and 8000-character bound on retained review summaries.

Use the existing implementation scope, targeted independent regressions, the unchanged full gates and independent acceptance. Preserve the remaining raw Fable findings for assessment; the four confirmed blockers are not a claim that every other external finding has been exhaustively adjudicated. Do not reset the baseline or retry counters.
