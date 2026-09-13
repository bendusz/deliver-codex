# Planning and approval

Turn agreed intent into a technical delivery plan and bind explicit human approval to its contents.

**Enter:** `docs/spec.md` is ready, or a `tiny` project has agreed inline intent.

**Leave:** `docs/plan.md` and `docs/approval.json` are tracked, the approval status is `approved`,
and its plan digest matches the current plan.

## Plan

Choose a project scale and checkpoint policy from `scale-profiles.md`. These do not select the
Quick, Managed or Governed execution mode. Create `docs/plan.md` from
`assets/templates/plan.md.template`, or revise it in place. A plan must contain:

- explicit in-scope and out-of-scope work;
- a story table that maps each story to stable `FR-` and `AC-` identifiers;
- architecture and material decisions;
- real test, lint, build and run commands, with `N/A` where none exists;
- dependencies, risks and mitigations;
- requirement-to-story traceability when a spec exists.

Use `docs/constitution.md` from `assets/templates/constitution.md.template` only when the scale
requires it or the project has its own checkable rules. It cannot weaken the delivery contract.
Large and regulated projects require it.

Initialize `docs/approval.json` from `assets/templates/approval.json.template` with `pending` status.
Do not manufacture approval. Planning may revise the plan and marker; it writes no implementation
and does not decompose stories.

## Approval

Before asking for sign-off, resolve every blocking clarification and every applicable blocking
analysis finding. Present the current plan. Only an unambiguous human approval authorizes sign-off.
Then:

1. Record the approver and date in the plan.
2. Compute the Git blob digest with `git hash-object docs/plan.md` after that edit.
3. Set `status`, `approver`, `approved_date`, `plan_digest` and `updated` in
   `docs/approval.json`.
4. Commit the plan and marker together under the PM's standing approved-delivery authority.

A changed plan invalidates the digest and needs reconciliation before implementation. Never start
decomposition or code work against pending, revoked or drifted approval.

## Scaffold and next phase

After approval, create a missing root `AGENTS.md` from `assets/templates/AGENTS.md.template` and add
only scale-required artifacts. Do not overwrite existing project instructions or configuration. The PM may create scoped commits, push story branches, create or
update pull requests, and merge verified work without asking again for each step. Builders and
reviewers do not perform Git integration.

Continue with `decomposition.md` after any required SpecDD contracts exist.
