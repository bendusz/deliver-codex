Proposed T05L legacy reconciliation correction

Status: proposed, not authorized or dispatched. The fifth fix is spent. Preserve run `df1605ed-56c6-4ee7-8368-01ede0f3c9c4`, revision 34, five fixes, one retry and the original baseline. T04F is independently accepted and integrated; T05L remains unmerged.

The fifth repair passed all 158 candidate tests and packaging validation. Independent review accepted the panel repair and changed-environment continuation, but rejected legacy reconciliation. `legacyFinalizationCandidates` validates retained finalization descriptors without independently rejecting contradictory current active receipts. An older artifact-compatible PASS can therefore conceal a current FAIL.

The reviewer demonstrated this in a disposable copy of the legacy regression by replacing its current gate with a synthetic valid-identity FAIL receipt, exit code 1 and a later finish time. Reconciliation and closure preparation still succeeded. This was a receipt-validation probe, not an executed failing gate command. The exact patch, output, raw FAIL review/verification, candidate source and run are preserved in `.deliver/checkpoints/T05L-fix5-native-review/`. Acceptance criteria AC1, AC3 and AC4 fail; AC2 and AC5 pass.

Recommended change

Validate active evidence before choosing any retained finalization. Resolve the current gate slots and effective current review/verification using their explicit identities and existing source-fallback rules. Validate their integrity, actual integration commit, snapshot, declared commands, logs, reviewer independence and complete acceptance results. A current failed gate, failed review, unresolved blocking finding, or failed/incomplete/UNKNOWN verification must refuse reconciliation before a durable write. Missing or inconsistent active provenance must also refuse with a specific diagnostic.

Use active pointers and retained receipt relationships to distinguish current evidence from resolved history. Do not infer precedence solely from timestamps and do not veto an otherwise valid current PASS merely because an earlier failure remains archived. After the active evidence passes, keep the existing unique historical candidate selection and exact artifact proof checks. A successful same-commit PASS replacement must still allow the already-proved historical artifact finalization to be recovered.

Production scope stays within `plugins/deliver/skills/deliver/scripts/lib/integration.mjs`; add meaningful regressions in `tests/integration.test.mjs`. Update the shipping reference only if the diagnostic or documented recovery contract needs clarification. Preserve all existing task acceptance, proof checks, reporting policy and before-image/size limits.

Required evidence

- Reproduce the ignored current FAIL gate, then prove refusal leaves record, logs, artifact state and Git refs unchanged.
- Cover a current failed review and an unresolved blocking finding, plus failed, UNKNOWN and incomplete verification.
- Cover stale or inconsistent active identities and bindings.
- Prove an earlier archived failure followed by valid current PASS does not prevent repair.
- Retain successful same-commit post-report PASS replacement, changed-environment recovery, missing/ambiguous evidence refusal and panel regressions.
- Run the declared full test and packaging gates on the frozen candidate, followed by independent review and criterion-by-criterion verification. Passing tests alone cannot override FAIL receipts.

Requested budget is exactly one further T05L correction round, increasing fixes from five to six while retaining the one retry and original lineage. No replacement run, reset, default-limit change or additional paid provider call is proposed. If accepted, integrate only after fresh independent PASS, then run the already-prepared combined T04F/T05L acceptance with a distinct verifier. The broader parity plan and installed trial remain pending.
