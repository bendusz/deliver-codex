# Failed-integration correction acceptance

T05C is accepted at source commit `3513e0c2146abeb88230dbfacd2c4dc68937da32`. The exact reviewed snapshot is `6878683c7c9e3511d86a2d59507c28805816398b43ed8737740dea8a875ea0e3`.

The PM can prepare a correction from an actual failed integration result or a proved composition conflict, then start its bound correction run in the exact recorded checkout. The run retains the original task, approval, inherited findings and spent attempts. Recovery validates the recorded branch, recursive checkout state, story target, baseline and publication images before acting.

The fourth repair addresses completed publication with a surviving journal. Recovery now requires the retained starting identity, both publication hashes and both exact live after-images before deleting that journal. Missing or reverted files and mismatched hashes refuse unchanged. Interrupted publication keeps its existing recovery behavior. No new exact permission-mode requirement was introduced for run files.

Validation at the accepted snapshot:

- Full declared suite: 294/294 passed, zero failures, 518039.657375 ms, within the unchanged 600-second gate limit.
- Packaging validation: passed.
- New completed-publication regressions: 7/7 passed.
- Existing interrupted-publication recovery group: 7/7 passed.
- Independent whole-task review: PASS, all nine inherited findings retained verbatim and resolved, no new finding.
- Distinct verifier: PASS for all three original acceptance criteria.

The builder was `recover_t05c`, reviewer `recovery_contract`, and verifier `correction_verifier`. The runtime finished at revision 26 on run `d7c72357-2f28-4ac9-b364-09c3b1b0628a`. Four fixes, zero retries and zero corrections remain recorded. The fourth fix has explicit user approval; the original baseline and task were preserved. The unrecoverable predecessor remains historical evidence with its separate recovery provenance.

Exact source patch, test snapshots, approvals, gate logs and independent receipts are retained under `.deliver/checkpoints/T05C-fix4/`. Earlier failures remain in their original checkpoints and the run's evidence history. Tests used disposable repositories and did not call model services.

This accepts T05C only. Remote lifecycle wiring T05B and the remaining approved parity tasks, installed native trial and final whole-project review/verification are still pending. The earlier Claude Fable 5.1 high-effort review is interim; the freshly requested final release review has not yet run. PR #2 remains a draft until full release acceptance.
