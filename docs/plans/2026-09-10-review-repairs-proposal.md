Proposed repairs following the Claude Fable 5.1 review

Status: proposed for implementation. This document does not authorize another fix round or change the frozen task contracts. It supplements the approved parity plan and the assessment in `docs/reviews/2026-09-10-claude-fable-5-1.md`.

The review warrants three immediate repairs. Two defects can strand a valid delivery after an interruption or correction. The third can hide an unresolved finding in a review receipt. The architecture remains suitable: retain separate implementation, review, verification and integration evidence, and repair their lifecycle rules. No sandbox by default and standing PM authority for scoped commits, pushes, PRs and verified merges remain requirements.

| Priority | Confirmed defect | Proposed owner |
| --- | --- | --- |
| Blocking | Adopted integration artifacts depend on mutable evidence and the later process environment | T05L additional round |
| High | A correction can leave an unusable commit preparation with no cancellation path | T04 bounded follow-up |
| High | Panel parsing silently discards supplied aggregate findings | T05L additional round |

The panel issue was labelled minor in the original receipts. Its reproduced result, an unresolved top-level major disappearing from a PASS receipt, makes it an acceptance blocker. This assessment preserves the original review severity and receipts.

1. Make commit preparation explicitly cancellable.

Add a proposed `commit-cancel` operation to the runtime, taking the run, exact pending token, expected revision and a bounded reason. Cancellation only clears a preparation; it does not undo a Git commit, edit source, grant PASS evidence or dispatch a builder. Existing `commit-prepare` then computes a new preparation normally.

Before cancellation, require the active current-bound run, matching story owner/branch/contract, HEAD at the prepared parent, the original ref, a clean index and unchanged protected Git state. Perform the cumulative scope check with the existing narrow pending-adoption allowance. Append the complete cancelled preparation and reason to an audit history, then clear pending state under the run lock. Keep cancelled entries distinct from adopted-commit history so `assertFinalCandidate` cannot mistake a cancellation for a commit.

Reject a state-changing Execution transition or correction while a preparation is pending, before changing the story or spending an attempt. Return the precise cancellation command as the continuation. A true no-op resume may remain a no-op. The PM can cancel and continue under its existing authority without asking the user again. Actual fix/retry dispatch still consumes its normal counter.

For an already mismatched child commit, cancellation must refuse. Report the prepared parent and mismatched HEAD so the PM can reconcile Git separately within its existing scope. Do not reset or delete the commit automatically. Once HEAD is back at the exact parent and the index is clean, cancellation can proceed. Retain the original failure evidence.

Acceptance covers cancellation after source edits and after the previously legal correction, fresh-process continuation, transition refusal without counter mutation, stale token/revision refusal, moved HEAD/ref, staged index, protected metadata changes, preserved baseline/history/counters, and successful prepare/adopt/finish after reconciliation.

Expected production scope: `scripts/lib/transitions.mjs`, the runtime CLI, state validation only if the cancellation audit shape requires it, and the runtime/recovery reference. Add focused transition/adoption regressions. These paths are relative to `plugins/deliver/skills/deliver/`.

2. Freeze integration evidence before preparing dependent artifacts.

At finalization, store a versioned identity over the actual integration commit and tree, bound snapshot/manifest, declared gate receipt identities, effective review identity, effective verification identity, and reporting policy. Validate the actual referenced receipts and bounded log bytes. Keep each gate's recorded environment hash as execution provenance; validating a historical receipt must not compare it with the environment of a later reader. A newly executed gate still records its actual environment and produces new evidence. This change is local to integration evidence consumption, not a blanket weakening of runtime gate checks.

Verification-report, closure and handoff preparations and adopted proofs must bind that finalization identity. Validate their exact parents, paths, modes, blobs and before/after images against the frozen evidence. A new terminal session must not alter what an already adopted report proves.

Once any report, closure or handoff preparation or commit exists, refuse gate, review, verification and non-idempotent finalization changes before running a command or writing a log. An identical finalization may return its existing result without mutation. Before dependent preparation, evidence refresh remains allowed and archives the previous evidence. Include closure preparation in this guard when the project's scale skips a verification report.

Handle existing candidate-format records deliberately. A bounded, record-hash-checked upgrade may reconstruct a frozen identity only from retained receipts, history, logs and artifact proofs that uniquely establish the same finalization. Archive the before-image. Missing, contradictory or ambiguous evidence must produce a specific recovery diagnostic; it cannot become inferred PASS. Reading a record alone must not rewrite it. This compatibility path must cover the two reproduced stranded records where the required historical evidence is retained.

Acceptance covers a new process with changed `TERM_SESSION_ID`, continuation from report through closure and handoff, refusal of every evidence mutation after pending or adopted artifacts with unchanged record/logs, unchanged idempotent finalize, fresh evidence before artifact preparation, tiny/small closure without a report, both reproduced legacy-record repairs, and refusal of tampered or missing evidence. Preserve the existing exact-commit, submodule, distinct-verifier and durable-log checks.

Expected production scope: `scripts/lib/integration.mjs`, `scripts/lib/reporting.mjs` only where rendering consumes the frozen identity, PM CLI wiring for explicit compatibility repair, and the shipping reference. Add focused integration/roundtrip regressions.

3. Validate panel aggregates without losing findings.

Keep the existing compatible panel input form, `findings: []`, meaning derive the aggregate from panel members. If callers supply a nonempty aggregate, require it to match the complete normalized member-derived findings. Compare as a deterministic multiset so order changes are harmless and duplicate multiplicity is preserved. Include severity, message, path and resolved status; any supplied lens/reviewer attribution must agree with the corresponding member. Reject extra, missing, altered or conflicting findings.

Continue deriving the status from member verdicts and unresolved findings. Return all findings with member attribution. Keep the existing no-panel receipt format. Do not silently union contradictory input, discard an aggregate, or change a verdict to make malformed input pass.

Acceptance covers the reproduced hidden-major case, extra/missing findings, duplicate findings from different members, reordered equivalent aggregates, mismatched resolution/severity/attribution, retained minor concerns, normalized-output roundtrips and unchanged legacy receipts. Expected scope is `scripts/lib/review.mjs`, panel tests and the receipt-format reference.

The remaining observations should retain their own disposition:

| Work | Disposition |
| --- | --- |
| Preparation made stale by an advanced integration tip | Required T05B functionality; retain previous preparation during explicit supersession |
| Genuine failed merge probe and source correction | Required T05C lineage and correction workflow |
| Approval, readiness and interrupted-state diagnostics | Include confirmed cases in T08 acceptance |
| Remote fetch/push identity and reporting-flag diagnostics | Include in T05B before remote lifecycle acceptance |
| Zero-duration benchmark scoring | Correct in the remaining T13 work before claiming a valid comparison |
| SpecDD examples, contradictory guidance and role-validator whitespace | Include in T14 packaging/documentation acceptance |
| Story without a final newline and omitted analysis headline | Small follow-up repairs, retaining their existing task lineage |
| Whole-tree Git subprocess cost | Measure on a representative repository before choosing an optimization or assigning release severity |

Keep the approved blocked-builder attempt accounting, unreadable-ownership refusal and claim checkout rules. The path-traversal allegation was disproved after inspecting the omitted parser dependency. These findings do not justify relaxing those contracts.

Implementation order: repair the independent T04 lifecycle, then refresh and repair T05L with explicit evidence of any dependency change. Keep the T05L run and cumulative review lineage; if integrating the T04 repair changes its protected inputs, require audited reconciliation and fresh gates rather than silently rebasing its baseline. Preserve completed T04 as immutable history and bind its follow-up to the original scope, reviews and spent counters. Proposed additional budgets are one T04 follow-up round, carrying three prior fixes, and one T05L round, carrying four prior fixes and one retry.

Each repair needs an independent review after its targeted regressions and declared `npm test` and `npm run validate` gates pass. Then validate the combined accepted remote adapter, repaired T04 and repaired T05L tree. The broader installed native trial and final release verification remain required by the original plan. A further paid Claude call is not necessary to execute these regression tests and is outside this proposal.
