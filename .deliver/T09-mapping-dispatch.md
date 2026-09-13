# T09 implementation dispatch supplement

Coordinator adopts the routine schema and ordering choices in the retained independent
`.deliver/T09-mapping-dispatch-proposal-native.json` and
`.deliver/T09-branch-selection-proposal-native.json`. Read both exact proposals together with
the unchanged T09 task, migration-design.md and migration-findings.md before implementation.
This resolves the input-schema gap reported in T09-readiness-native.json. It is preparation,
not T09 implementation or acceptance, and creates no new migration authority.

The versioned mapping binds the inventory and exact observed ambiguities, requires a bounded
rationale, forbids overrides of consistent evidence and cannot select counters or merged
status. Limits are caller-reducible production maxima. Typed before/after journals retain
exact bytes and modes; only incomplete publication can resume or roll back.

Integration-branch selection precedes a dependent plan-edit proposal. Preserve a unique
credible existing declared branch. Missing, conflicting or invalid declarations require an
explicit observed eligible local branch choice. Never guess HEAD, main or a remote default.
If no eligible branch exists, report BLOCKED. A selection-only mapped preview remains
read-only and unapplyable until the exact generated plan edit is also accepted against the
same unchanged inventory. No arbitrary plan replacement or branch creation is authorized.

Builder and independent test author must use these same representations. Preserve the
original task's acceptance criteria, historical evidence and MAX spent counters. Test every
refusal without real provider calls and keep migration separate from the active T05B run.
