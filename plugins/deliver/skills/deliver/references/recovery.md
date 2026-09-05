# Resume, handoff and doctor

Read runtime state first, then inspect repository status, branch/HEAD and the current task.
Only then read the current checkpoint and relevant contract or knowledge index pointers.
Do not pull/rebase as a side effect of resume. Inspect remote state with a fetch only when
network access and the user's workflow permit it; integration is a separate mutation.

Run `status` and `check` for the selected run. Never choose arbitrarily when several runs exist.
Confirm the worktree exists, the plan's approved contents have not changed, and persisted retry
counts remain in force. Reconcile live code with receipts. A completed agent thread is not
evidence that its work survived an interruption.

A handoff is a runtime checkpoint plus a short note containing the next action, unresolved
decision, evidence paths and blockers. Do not duplicate every state field in a second document.
Commit durable run state with the work only if repository policy allows it and the user has
authorized commits. Logs may stay local; missing load-bearing logs make verification UNKNOWN.

Doctor is read-only: inspect state schema/revision, pending locks, task paths, approval, code
identity, missing evidence, and role installation. Do not clear locks, migrate state, edit
configuration, or clean up worktrees automatically. An interrupted writer may leave a lock;
confirm its owner is gone before proposing recovery.

Correct-course records why the current plan or scope cannot work. A plan change invalidates
approval; show the new plan and obtain approval again. Do not expand touches in place while
keeping a previous PASS. Preserve abandoned work and old runs as history. A new scope needs a
new task baseline with the old changes explicitly reconciled.

`pm/` compatibility is covered in `compatibility.md`. Do not treat a legacy `signed_off: true`
as approval of a new or edited plan.
