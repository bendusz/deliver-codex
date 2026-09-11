# T05C correction interface

This note pins interfaces already required by the approved parity plan and integration-correction design. It adds no caller-selected basis, scope or budget override. Preserve the original finished source, existing approval, exact original task and all spent attempts.

## Entry points

- `pm.mjs correction-prepare --run <source-run> --integration <record> --expected-record <hash>` calls `prepareIntegrationCorrection(runArg, { integrationRecord, expectedRecordHash }, cwd)`.
- From the PM-created correction worktree, `deliver.mjs correction-start --integration <absolute-record> --expected-record <current-hash> --token <uuid> --builder <id>` calls `startIntegrationCorrection(recordArg, { expectedRecordHash, token, builder, correctionRoot }, cwd)`.
- `recoverIntegrationCorrectionStart(root)` coordinates recovery from `pm.mjs recover`. Integration owns orchestration; current-pm owns pure correction-journal construction, validation and application. Do not introduce a current-pm-to-integration import cycle.

The preparation result keeps the existing integration wrapper `{ file, record, hash, result }`. Its public `result` includes `token` as the UUID, `run_id`, `branch`, `start_commit` and `basis` as the discriminant string. The record's `correction` envelope uses `status` for prepared/starting/started and `token` for the immutable descriptor, whose `id` and `identity` identify it. Additional provenance remains in that descriptor/envelope. Correction-start returns a runtime summary with top-level `run_id`, `revision` and `phase`; its run uses the already-prepared ID.

Preparation infers the failure basis, fixed run ID, generation, unique correction branch and start commit/tree from validated evidence. The immutable token body and its identity live in the canonical integration record's mutable `correction` envelope. The envelope changes from `prepared` to `starting` to `started`; the token descriptor does not change. Correction presence also blocks conflicting integration evidence/artifact mutations.

An actual-M basis requires current, exact M-bound failure evidence with valid receipt identities, declarations, snapshot, commands, logs and criterion shape. Apply actor/separation checks to a qualifying review or verification receipt; a gate-only failure does not require inventing absent review actors. Missing evidence, UNKNOWN alone and superseded history cannot authorize correction. A no-M basis requires an actual I/C composition conflict, not a generic Git error. Re-probe the exact I/C command and validate the recorded Git version and stable conflict result. Retain original receipt/log identities; fresh probe timestamps are fresh provenance, not a demand to reproduce the old invocation identity.

## Publication and recovery

Validate all token, record, source, plan, approval, contract, route, ownership, checkout and attempt conditions before publication. The correction root must be the sole attached worktree for the unique recorded branch at the exact I/M start commit. Reject dirty/staged/untracked state, index flags, submodule/protected-metadata drift and unrelated same-story or same-owner work before writing.

The `starting` envelope binds one correction root, builder, fixed run ID, stable journal-descriptor identity and prepared predecessor hash. Avoid a circular hash:

- Descriptor `D` uses fields `kind: integration-correction-start-v1`, `token_id`, `token_identity`, `integration_record`, `prepared_record_hash`, `correction_root`, `run_id`, `branch`, `builder` and `writes`. Record/root paths are canonical and absolute. Writes contain the exact bounded run/story before/after bytes in run-then-story order. `DID` is the hash of canonical `D`.
- Generated run/story after-images bind only the immutable token, basis and root lineage. They do not contain DID, a starting-record hash, wrapper hash or future started-record hash.
- Persist `starting` with DID and complete deterministic reconstruction data. Keep the exact descriptor or enough original bytes and captured baseline/timestamps to rebuild it; hashes alone cannot reconstruct missing bytes. Compute `S` as the resulting integration-record hash.
- The local journal wrapper is `{ descriptor: D, descriptor_identity: DID, expected_starting_record_hash: S }`. S is excluded from D and DID. No wrapper hash is stored in the starting record.
- Recovery recomputes DID, requires the actual starting-record hash to equal S and validates all starting fields against D before regenerating/validating the legal pair.
- The later `started` envelope retains S, DID, immutable token identity and exact run/story hashes. A surviving journal can be deleted only when those bindings and both after-images match. Nothing earlier hashes this future started envelope.

For a crash before the journal exists, rebuild the identical descriptor from the retained data and still-exact before state, require the same DID, then write the wrapper. Do not generate fresh timestamps, allocate a new run or recapture a baseline. Publish through `.deliver/integration-correction-transaction.json` with type `integration-correction-start-v1`:

1. Persist the exact `starting` envelope under the integration-record lock.
2. Write the typed journal and prevalidate both before/after images.
3. Write the previously absent fixed run first, then the story Execution.
4. Persist `started` with the resulting run/story hashes.
5. Delete the journal last.

`pm recover` checks correction recovery before ordinary transition/current-PM recovery. More than one journal type present is an unchanged refusal. Recover only `starting` with its exact journal, or `started` with both after-images. A crash after `starting` but before journal creation resumes the same hash-bound correction-start command; it does not allocate a second root, run or branch. Third-state files, changed token/record binding and illegal after-images refuse unchanged.

Capture the clean operational baseline/anchor/contracts at I or M before changing Execution. Retain a separate immutable root-review lineage rather than substituting the original root baseline. An unclaimed I permits a null actual before-image; an older I must retain compatible same-owner/builder nonmerged state and matching unknown fields. Seed only parser-safe unknown fields from finished C where required, then apply the exact permitted correction fields.

## Attempts and evidence

Retain an explicit sorted list of counter sources and identities from original/root/source and every correction-ancestor run, linked integration records and allowed I/M/C story states. Re-enumerate at start. MAX wins across all credible same-lineage sources; fixes/rounds become MAX+1, retries/corrections retain MAX, generation becomes prior-generation MAX+1. Refuse fixes MAX >= 3 before any token mutation. Allow only exact named finished ancestors and retained C refs; unrelated active work remains a duplicate refusal.

The immutable token and root-review lineage retain `required_resolutions` as an origin-identified ordered multiset of inherited open review findings. Each entry preserves its receipt identity and ordinal plus normalized severity, message and path. The approved design requires every inherited finding, including an open minor, to remain in review input and be resolved with evidence. Fresh correction review and finish must require the corresponding resolved entries with exact multiplicity. Resolved historical findings remain history and need not be repeated. A failed gate requires fresh declared PASS gates; failed verification requires fresh complete PASS verification. No old C/M PASS is reused as correction acceptance.

The full original task, inherited findings and correction delta receive fresh gates, independent review and a verifier distinct from the builder and reviewers before C2 integration. Tests cover omission, duplicate multiplicity and wrong-path resolution; both basis variants; exact nullable start states; all MAX sources; missing/ambiguous ownership; raised counters; and every torn publication boundary. Receipt validation is deterministic attestation validation, not authentication.
