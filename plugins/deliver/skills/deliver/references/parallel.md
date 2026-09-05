# Parallel work

Use parallel native agents for bounded independent research and review first. For parallel
writes, use a separate branch and worktree per task and a separate Deliver run per worktree.
Never let two workers edit the same checkout, even under the same human identity.

Check dependencies and normalized write scopes before dispatch. Distinct paths do not prove
semantic independence: shared interfaces, generated outputs, test databases and ports can
still collide. Default to at most three workers and serialize uncertain tasks.

The coordinator owns worktree creation and integration only when authorized. Pass every worker
its absolute worktree root. Each task gets its own before-state and final evidence. Preserve
dirty worktrees on failure or interruption and report them in the checkpoint.

Integrate serially under the repository's policy. Evidence from a pre-integration tree cannot
approve a different merged tree. Run gates and review changes introduced by integration before
declaring completion. Remove only clean, merged worktrees with `git worktree remove`, never
force removal or recursive deletion.

Local run locks protect one state record, not distributed team claims. This release does not
provide cross-clone atomic scheduling. Coordinate ownership explicitly; Git visibility is not a lock.
Sibling branch commits and worktree creation do not invalidate a task's code identity. Its own
HEAD/index and shared repository configuration/hooks remain protected. The runtime cannot attribute
a shared configuration change to a particular worker, so coordinate those changes before task start.
