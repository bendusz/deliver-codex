# Correction recovery follow-up

T05C is not accepted. The third repair candidate passes all 287 declared tests and packaging validation, but independent review and a separate verifier identified a completed-publication recovery defect. Four additional real-Git regression cases reproduce it. PR #2 remains a draft and has not been merged.

The candidate snapshot is `b8c66ec574464337ae65d7b4e810d742a34b381e758f4b21f9e53964ac481d97`. Its original run is `d7c72357-2f28-4ac9-b364-09c3b1b0628a`, with three fixes, zero retries and zero corrections. Its baseline and task remain unchanged. Full suite duration was 513994.161041 ms, within the existing 600-second gate limit.

## Confirmed defect

The approved correction interface permits recovery of a `started` envelope with a surviving journal only when both published after-images match. Current recovery instead invokes the generic journal application routine, which also accepts missing or before-image files. It does not compare the retained started run/story hashes with their descriptor after-images.

A genuine interrupted `started` publication therefore accepts all four invalid states:

- The published run has been deleted. Recovery recreates it and deletes the journal.
- The story has been restored to its exact pre-publication bytes. Recovery republishes it and deletes the journal.
- The retained run hash has been replaced with a different valid-format hash. Recovery succeeds and deletes the journal.
- The retained story hash has been replaced with a different valid-format hash. Recovery succeeds and deletes the journal.

The valid control, with both exact after-images present, passes. The focused diagnostic reports four failing leaf cases and two failing parent groups. These are additional probes outside the frozen declared test files, so their failure does not contradict the 287-test suite result.

A separate concern about `core.worktree` normalization did not reproduce. The corrected real-Git probe passes its legitimate shared-worktree control and rejects both fresh-clone and shared-config retargeting without mutation, four reported tests passing. Two earlier diagnostic versions failed during fixture setup and are retained as superseded diagnostic evidence, not production failures. No configuration change is included in this repair proposal.

## Proposed bounded repair

Authorize one additional T05C fix round on the same run, task and baseline. Preserve every prior finding and counter; do not create a replacement run or reuse old acceptance.

In `integration.mjs`, make recovery of a `started` envelope a validation-and-cleanup operation. Require the retained starting-record hash and descriptor identity, require both retained publication hashes to match the exact descriptor after-images, and require both live files to equal those after-images before deleting the journal. Keep the existing type, mode, checkout, source, ownership and budget checks. A missing file, before-image, mismatched hash or third state must refuse without changing any file or record. Do not call the routine that publishes missing after-images in this branch.

Keep interrupted `starting` publication recoverable through its existing exact before/after protocol. If a shared read-only journal helper is needed, place it in the already authorized `current-pm.mjs` scope. No contract, schema, dependency, default sandbox or Git-authority change is needed.

Promote the four diagnostic cases and their valid control into the existing authorized test files. Retain all prior assertions and the two-file execution arrangement. Run focused recovery checks, the full declared test and validation gates, whole-task independent review and distinct verification against one frozen candidate. Resolve all retained findings explicitly.

## Remaining delivery

After T05C acceptance, complete remote lifecycle wiring T05B, diagnostics and resume T08, migration T09, retrospectives T10, knowledge and review operations T11, completion reporting T11P, parallel delivery T12, benchmark workflow T13B and release validation T14. The installed native trial and final whole-project acceptance remain pending.

The earlier Claude Fable 5.1 high-effort review was interim. The freshly requested final review must assess the completed release candidate before PR #2 is made ready and merged. The current candidate does not qualify for that final release review.

## Evidence

The exact candidate patch, file hashes, full gate records/logs and focused probes are retained under `.deliver/checkpoints/T05C-fix3/`. The started-state probe source hash is `fae33daa9a81cd86de3a63f88741d48f91c1d713a22bf69402b8032a7fbb5104`; its failing output hash is `4c036764d92f01d1a28faa18e476c7c5e1781a3d59ef0f145e5d79ca53b760a4`.

The Deliver skill at `/Users/ben/.agents/skills/deliver/SKILL.md` states: "Stop after two builder retries or three fix rounds and report what needs a decision." This successor has now spent all three fix rounds. The requested decision is one extra round for the defect described above, followed by the same acceptance gates. No fourth round has started.
