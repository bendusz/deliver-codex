Proposed T05L receipt-identity correction

Status: proposed, not authorized or dispatched. Fix6 is spent on run `df1605ed-56c6-4ee7-8368-01ede0f3c9c4`; preserve six fixes, one retry, the original baseline and all prior evidence. The candidate is not integrated.

The sixth repair adds the active-evidence veto and passes 158/158 full tests plus packaging validation at snapshot `d9f901fa13b3900566fb62663ac9a4874b41a0fdbb21e0d0737d530a63cebca4`. Independent review reproduced a remaining violation of the approved reviewer-independence requirement. A disposable regression supplied an identity-valid current PASS receipt whose reviewer equals the source builder. Reconciliation succeeded and changed the record. The candidate tests did not cover that identity relationship.

The probe patch also contains an empty-verifier test, but execution stopped at the first failing self-review assertion. Empty/malformed actor and panel-member variants are code-inspection concerns until separately executed; they are not additional demonstrated probe outcomes. Receipts remain workflow attestations. This correction validates their declared identities and relationships; it does not authenticate who performed the review.

Recommended change

Apply the existing identity and separation rules used by `recordIntegrationReview` and `recordIntegrationVerification` when consuming current evidence during reconciliation:

- Require an explicit valid top-level reviewer identity and reject the source builder as reviewer.
- Validate panel member identities through the existing receipt parser and reject any panel member matching the builder.
- Require an explicit valid verifier identity and reject equality with the builder, top-level reviewer or any panel member.
- Apply the same checks after effective source fallback is resolved. Preserve the rule that existing active evidence is authoritative and cannot be replaced by source fallback when invalid.

Use one small internal identity/separation helper from both `assertEvidenceReady` and `validateFinalizationReceipts`, covering active evidence, source fallback and the selected historical receipts. Keep its predicates consistent with the existing recording entry points. Retain all snapshot, receipt-hash, current-slot, gate-log, criteria-completeness, artifact-proof and unique historical-finalization checks. Preserve valid historical provenance and later PASS recovery. Do not widen accepted identity syntax or default permissions.

Production scope stays in `plugins/deliver/skills/deliver/scripts/lib/integration.mjs`; regression scope stays in `tests/integration.test.mjs`. This finishes a missing part of the already-approved requirement.

Acceptance approach

Have an independent test engineer first turn the reproduced self-review case into an acceptance regression and add missing/empty/malformed top-level reviewer/verifier, builder-as-panel-member and verifier collision cases. Establish the expected current failure before the builder changes production code. Cover both explicit active receipts and legitimate source fallback; preserve the positive distinct-identity case and resolved-history recovery. Each refusal must preserve record/log/artifact/ref state. Then the builder implements the bounded correction. The final reviewer must differ from the test author and production builder.

Run focused regressions and the declared full npm test and npm run validate gates at one frozen snapshot. Obtain fresh independent review and complete task verification; preserve every previous FAIL and spent attempt. Integrate only after PASS, then perform the prepared combined T04F/T05L acceptance with a distinct verifier. Combined acceptance and the broader parity project remain pending.

Requested budget is exactly one additional T05L correction round, increasing fixes from six to seven while retaining one retry. No replacement run, baseline reset, default-limit change or paid external call is proposed.
