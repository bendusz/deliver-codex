# T05L dependency reconciliation

Status: accepted coordinator sequencing for the user-approved T04F and T05L repair rounds.

## Decision

Do not import the repaired T04 source into the active T05L worktree. The two repairs are implementation-independent:

- T04F adds commit-preparation cancellation and prevents Execution or correct-course mutation while a preparation is pending. Its primary owners are transitions.mjs, the runtime route, cancellation state validation, runtime guidance and transition tests.
- T05L fix 5 freezes integration evidence for P/E/H and validates panel aggregates. Its primary owners are integration.mjs, review.mjs, their focused tests, and only the L-specific wiring or guidance required by those interfaces.

T05L does not consume the new cancellation API. Importing T04F would add transition/runtime changes to an active task that does not own them and would make the old baseline appear to authorize a dependency delta it never contained. Any overlap in state.mjs or deliver.mjs is a later composition concern, not a reason to rewrite the L baseline.

The active L run therefore retains:

- run df1605ed-56c6-4ee7-8368-01ede0f3c9c4;
- Git base a18e851375c37ac4c99e62a55fe0e9ff1f1e937d;
- original baseline snapshot 557ab5fbd1cc95784b2eca820cd8cea8fae5fe4c7096a24de8eef6685a9b8fc4;
- original task packet, cumulative scope, evidence history and all archived findings;
- revision 30 and spent counters fixes=5, retries=1, corrections=0.

The dependency source delta inside the active L worktree is exactly empty. No baseline entry, dirty-path list, task touch, contract hash, Git anchor or prior receipt may be recaptured or relabelled.

## Independent repair sequence

1. Finish T04F in its separate worktree and run. Bind its exact parent, source snapshot, task, user authorization, gates, independent review, verification and final commit. Preserve the original completed T04 evidence as history; T04F is an additional reviewed correction.
2. Build T05L fix 5 only from the existing L worktree and run. The coordinator already recorded the user's extra-round authorization at expected revision 29, advanced the run to revision 30 and spent fix 5 while retaining the baseline hash above.
3. Limit the L correction to the confirmed finalization/proof lifecycle and panel aggregate defects. A builder must not copy T04F files, alter the baseline or packet, or claim that L gates exercised T04F.
4. After the L source freezes, run its declared gates and independent review against the new exact L snapshot. Retain the Claude-triggered FAIL and every earlier review as historical evidence. Verification must recheck T05L-AC2, AC3 and AC5 plus regressions for the previously resolved findings.
5. Commit or preserve each accepted repair as its own immutable candidate. Record exact commit or patch hashes and per-path modes/blob identities. Neither candidate's receipt is evidence for the other candidate or for their combination.

## Combined integration proof

Only after both candidates independently pass, compose them in a clean coordinator-owned integration worktree based on the actual current root tip. Apply the accepted T04F candidate and the accepted T05L candidate without rebasing either source run or modifying their receipts.

Before gates, write a composition manifest in execution evidence containing:

- actual integration parent and resulting candidate commit/tree;
- T04F and T05L commit or patch hashes and their accepted snapshot/receipt hashes;
- every changed path and its source candidate;
- the exact set of overlapping paths;
- for non-overlapping paths, proof that the integrated mode/blob equals its accepted candidate;
- for overlapping paths, the final mode/blob and a diff against both accepted candidates.

Resolve overlap by preserving both accepted interfaces. Cancellation state and validation from T04F must coexist with T05L panel/finalization state. Any hand resolution is new combined code and requires review; it cannot inherit either source PASS automatically.

On the exact combined tree:

1. Prove a clean index/worktree and unchanged protected Git metadata.
2. Run the full declared npm test and npm run validate gates.
3. Run focused cross-regressions for commit cancellation, pending-transition refusal, fresh-process P/E/H continuation, post-artifact evidence-mutation refusal and panel aggregate mismatch.
4. Perform a fresh independent review of the complete composition and every prior unresolved T04F/T05L finding.
5. Obtain distinct acceptance verification for both repair contracts.

Use the coordinator's T04F-T05L-COMBINED task packet for this combined evidence. Keep it separate from the original runs. If composition changes after any gate or review, rerun the affected evidence at the new tree. A failure opens a bounded integration correction with the combined manifest as input; it does not reset either baseline, counter or history.

No new baseline-reconciliation runtime or scope exception is needed. The only authorized dependency change is the later, explicit, hash-bound composition of the two independently accepted candidates.

