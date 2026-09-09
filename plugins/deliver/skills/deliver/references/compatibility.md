# Hosts and existing Deliver projects

## Codex

The project setup command installs this self-contained skill and native TOML roles without
editing `.codex/config.toml` or global settings. Plugin installation distributes the skill;
it does not by itself install TOML role definitions. Use setup for roles, or dispatch native
agents with the matching role instructions. The launcher selects the main model; ordinary
`codex` sessions retain their existing model configuration. The launcher defaults its session
to `danger-full-access` with approval set to `never`. Passing `--sandbox read-only` or
`--sandbox workspace-write` opts into a sandbox and uses `on-request` approval. Native workers
inherit the effective session policy. Inherited host restrictions still apply.

Codex project AGENTS.md discovery follows the directory chain to the session's working
directory. Do not assume nested `pm/AGENTS.md` automatically applies to a root-launched worker.
Include applicable directory constraints explicitly in its task packet.

## Claude and ChatGPT

The phase and artifact conventions are host-neutral. Claude review is optional and uses a
separate adapter; this package is not a replacement Claude-hosted plugin. Existing Claude
Deliver continues to work separately. No Claude CLI or credentials are needed for native delivery.

ChatGPT can use the planning and review instructions with provided artifacts. Full local
execution requires repository filesystem access, Node/Git and appropriate tool permissions.
Do not claim local gates, native role configuration or lifecycle hooks ran in a chat without
those capabilities. Ask for missing evidence or offer an explicitly reduced workflow.

## Shared project state

Use the original Deliver 0.22.0 layout for project progress:

- `pm/pm-state.json`: project phase, sign-off, sprint and assignments.
- `pm/actors/<actor-id>.json`: story position, route, counters and next action.
- `pm/actors/<actor-id>.HANDOFF.md`: current host-neutral handoff.
- `pm/log.md`: append-only, actor-prefixed history.

The original `docs/` plans, stories, acceptance criteria and SpecDD contracts stay authoritative.
Do not duplicate them into a Codex backlog. `.deliver/runs/` holds execution attempts and evidence.
It does not own project progress. The low-level runtime still supports standalone Quick tasks
without `pm/`, but those are not a shared project or an automatic cross-host handoff.

Read `pm/pm-state.json`, your actor state, a current handoff, then the selected story and wiki index.
Inspect actual Git state. In an approved delivery, the PM may commit scoped work, push story
branches, create or update pull requests, and merge verified code without repeated confirmation.
Follow repository policy and preserve unknown state fields. Use the original Git-derived actor ID, including its historical
`:pm-skill` salt; never create host-specific human identities to evade an existing claim.

## Start or continue in Codex

Let `<pm>` be this skill's `scripts/pm.mjs` and `<runtime>` its `scripts/deliver.mjs`.

```text
node <pm> status
node <pm> init --name "Project name"
node <pm> approve --approver <actual-user-id>
node <pm> claim --story docs/stories/S1-1-example.md --branch pm/S1-1-example
```

`init` is idempotent and creates only missing project/own-actor records. It does not set sign-off.
Skip `approve` when current shared sign-off already exists. Never manufacture approval, and still
bind the execution runtime to an explicitly approved current plan. Keep the project's scale and
phase conventions; do not force a sprint framework onto a bounded Quick request.

Inspect and reconcile the working tree before claiming. Claim only a ready, unclaimed story at
a host boundary. The helper refuses active/parallel actor
work and explicit `expert-builder` stories until their routing is deliberately reconciled.
Its shared route is `codex-builder`; native Sol/Luna execution remains controlled by Codex roles.
Confirm `.gitattributes` contains `pm/log.md merge=union` and that PM files are not ignored. Add the
merge attribute only within scope. The PM commits the claim under the project's policy and checks
out the recorded story branch before the task baseline. Helpers do not perform Git mutations.

Build the task packet from the story's ID, exact checkbox criterion text in order, and bounded
`pm-meta.touches`. Preserve existing acceptance IDs when present. Include the complete Specs chain
and the plan's actual gates. Then initialize/approve the runtime and start:

```text
node <runtime> start --run <run-id> --task .deliver/tasks/story.json --builder <thread-id> --story docs/stories/S1-1-example.md
```

An existing `pm/` project cannot silently start an unbound task. Story changes, lost claims,
revoked sign-off and Git identity changes block execution. Existing run counters survive resume;
do not create another run for the same claimed story. While active, the execution receipt owns
the current attempt's detailed retry counts. They are copied to the shared actor on completion.
Use Codex's runtime status during that interval, not a stale actor counter. No mid-story host takeover
or live concurrent editing of PM coordination records is supported by this bridge.

## Verified is not merged

Runtime `finish` records reviewed and verified code only. It does not release the shared claim,
mark the actor merged, or perform Git integration. Under the approved delivery authority, the PM
commits the scoped result, pushes its story branch, creates or updates its pull request, and merges
only after required checks pass. After verifying the real integration result, check out the clean
integration branch and run:

```text
node <pm> complete --run <run-id> --commit <full-integration-HEAD-sha> --next "Continue with the next ready story"
```

The integrated file contents must match the retained verified snapshot. Different integration
content needs fresh verification; never relabel an old PASS. The helper then records `merged` and
`PASS`, exports counters, clears `resolved_builder`, releases only this story's claim, appends the
log and writes a current handoff. Story documents and other actors stay unchanged. Commit these
PM records under the approved delivery authority so they travel with a clone. Do not advance the sprint
without checking all its stories. The original framework reads the resulting files directly.

## Recovery and limits

Writes use a local lock, before-image checks and `.deliver/pm-transaction.json` for interrupted
multi-file publication. `node <pm> recover` completes only matching before/after images; conflicts
need reconciliation. A crashed process can also leave `.deliver/pm.lock`. Verify its owner is gone
before explicitly removing that one lock. Never switch hosts while publication is incomplete.
The unchanged original does not honor this lock, so it is not a distributed scheduling guarantee.

This bridge targets upstream 0.22.0 records. Older flat/legacy actor layouts require upstream
migration first. Task-boundary PM handoffs are portable; live Codex receipts remain checkout-bound.
No automatic migration of existing standalone `.deliver` runs, mid-story conversion, sprint
planning engine or automatic integration re-verification is claimed.
