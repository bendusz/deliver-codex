# Deliver for Codex: upstream functionality plan

Status: approved by Ben on 2026-09-09, following confirmation of the operating policy below.
User-confirmed operating policy: no sandbox by default; the PM may commit, create PRs and merge
code within the approved delivery scope, including the branch pushes needed for those PRs.

Target: Deliver 0.25.1 at upstream commit `3aa3f3a0a6baed15e9a8a99ef15405b79efd37aa`.
Current port: `628e7eb6909a3c3c27019b21c78ad3d77c402855`, package version 0.1.0.
Upstream is `../pm-skill`, read-only reference material throughout this work.

## Outcome and boundaries

Make this project support the current Deliver lifecycle in Codex: discover, specify, clarify,
plan, approve, optionally author contracts, analyze, decompose, claim, build, gate, review,
verify, integrate, retrospect and resume. A project should move between upstream Claude Deliver
and this port at a completed-story boundary without rewriting its requirements or keeping two
backlogs. Existing local Codex evidence protections must survive the change.

Use Managed delivery for implementation, with bounded builder tasks and independent review.
Require a distinct verifier for the final parity acceptance. The tasks below are planning units;
turn each into an executable task packet with exact paths and criteria before dispatch.

Parity means matching project artifacts, lifecycle outcomes and user operations. Codex uses
native agents and skill routes rather than Claude slash commands and wrapper agents. Once delivery
scope is approved, the PM has standing authority to create branches, commit scoped work, push story
branches, open/update PRs and merge verified code. It must not ask for permission again for each
routine Git or PR step. Plan approval still controls what is built; gates and independent review
control whether it is ready to merge. Installation, paid external-provider calls and deployment
remain outside this Git/PR authorization unless separately included in the user's request.

Execution is unsandboxed by default for the orchestrator and its launched workers. Sandboxing is
an explicit opt-in. Set launch/session defaults without rewriting global configuration; inherited
host restrictions still apply when this workflow cannot control them. Read-only reviewer roles,
bounded worker scope and evidence checks remain workflow rules, not claims of OS isolation.

Keep Node.js 22+, ESM, built-in modules only, no import-time side effects, the existing model
defaults and no silent fallback. Keep Claude optional. Poteto and the official SpecDD plugin
remain optional integrations; copying their separate distributions is outside this plan.
Distributed locking, automatic cross-machine adoption of live receipts and mid-story switching
between model hosts are not release requirements.

## Starting position

The current port has setup and launcher support, 13 native roles, Quick/Managed/Governed modes,
plan-content approval, scope checks, code-bound gates and receipts, persistent failure limits,
SpecDD checks, optional external Claude review and a 0.22.0 shared-state bridge.
At the assessment baseline, all 68 tests and packaging validation passed. Upstream's full
validation also passed. These checks establish deterministic behaviour, not live agent quality.

| Capability | Current coverage | Work required |
| --- | --- | --- |
| Execution and PM authority | Host-dependent launch permissions; separate Git authorization guidance | Unsandboxed defaults and autonomous scoped commits, PRs and verified merges |
| Planning and artifact generation | General instructions and task examples | Complete phase contracts, project templates and readiness rules |
| Shared project progress | 0.22.0 `pm/` files only | 0.25.1 approval marker, Execution blocks, Git-derived state and handoffs |
| Plan approval | Content-bound local runtime approval | Read upstream marker and digest, detect drift and avoid duplicate sign-off |
| Claim/build/fix/review/ship | Local execution receipts and old PM bridge | Durable story transitions, commit reconciliation and verified integration |
| Resume and doctor | Local status/check plus prose guidance | Shared inspector, project diagnostics, phase dispatch and explicit recovery |
| Legacy project migration | Not implemented | Reviewed conversion of upstream legacy layouts, retaining ownership and budgets |
| Analysis and checklists | General governed-analysis instructions | Artifact-specific checks, templates, stable findings and phase gates |
| Scale and checkpoints | Three execution modes | Upstream scale policies and story/sprint/autonomous checkpoints |
| Sprint retrospective | Missing | Cross-story review, missing-retro phase and durable records |
| Wiki and research | Roles and optional instructions | Wiki schema/templates, source-backed research reports and lifecycle handoffs |
| Parallel stories | Worktree guidance; local snapshot support | Project claims, readiness checks, interruption recovery and integration workflow |
| Review/advice operations | Generic review roles; optional Claude adapter | Explicit recent/worktree/branch/codebase scopes and bounded decision advice |
| Builder benchmarking | Evaluation proposal only | Isolated comparison workflow, result schema and deterministic scoring |
| Packaging and examples | First release packaging | New routes/assets, migration documentation and complete worked examples |

## Design decisions to implement

1. **Use upstream artifacts for shared progress.** `docs/approval.json`, `docs/stories/*.md`,
   `docs/handoff/<actor-id>.md`, the plan and Git history are authoritative. `.deliver/` keeps
   execution evidence, locks and recovery journals. New projects must not recreate `pm/`.
   Keep the old reader for explicit legacy detection/migration and preserve its pinned fixtures.

2. **Separate execution mode from project scale.** Keep standalone Quick behaviour. Add the
   upstream project policy with `tiny`, `small`, `standard`, `large` and `regulated`, defaulting
   to `standard` for new shared projects. Scale controls artifacts; execution mode controls
   orchestration. An imported project's recorded scale and approval remain authoritative.
   Shared-project delivery follows upstream's separate final verifier at every scale; standalone
   Quick/Managed may retain their existing combined review/acceptance dispatch. Document this
   explicitly rather than silently changing an existing project's workflow.

3. **One inspector, several consumers.** Put project inspection in an importable module inside
   the self-contained skill. The PM helper, resume, doctor and optional SessionStart hook consume
   the same result. Inspection is read-only and works without a model, installed hook or Git
   identity where identity is unnecessary. A missing identity blocks a claim, not discovery.

4. **Approval uses two hashes for different purposes.** Preserve upstream's Git blob digest in
   the shared marker; retain the runtime's existing snapshot/hash machinery internally. A valid
   existing sign-off can bind a local run without asking for the same approval again. Missing,
   invalid or changed approval cannot silently start an unbound Quick task in a shared project.
   Upstream sometimes fails open on a missing digest/plan. This port will report that state but
   require reconciliation before implementation, retaining its stronger existing approval gate.

5. **Split story requirements from execution bookkeeping.** Parse `pm-meta`, acceptance,
   dependencies, risk and contract references separately from the precisely delimited `pm-exec`
   block. Freeze the substantive story contract for the run. Allow only coordinator-owned,
   validated execution transitions. Do not exclude entire story files or `docs/` from scope
   checks. Changes to requirements, acceptance or scope invalidate the task binding.

6. **Make coordinator commits explicit evidence transitions.** Today own-checkout HEAD/index
   changes are protected, so copying upstream's commit-as-you-go instructions would break runs.
   Add a transition that proves the new commit contains the already-audited task changes and
   permitted execution metadata, preserves the cumulative scope baseline and records the new
   Git identity. Never permit a worker commit through a blanket HEAD/index exemption. Generate
   fresh gate/review receipts after a transition whenever their code identity changed.

7. **Use upstream Git conventions for the compatibility workflow.** Claims use story branches;
   integrated stories have merge evidence, a `merged` Execution block and the upstream merge-body
   fields. The PM executes the commit, branch push, PR and merge steps under standing delivery
   authorization without per-action confirmation. Workers remain scoped builders; the PM owns
   repository integration. `finish` still does not mean merged: the PM continues through the
   actual integration and completion checks. Repositories requiring squash/rebase policies must use an explicit
   documented alternative and cannot claim exact upstream Git-history compatibility by default.

8. **Default to unsandboxed execution and PM-owned delivery.** The launcher selects unsandboxed
   execution by default and provides an explicit sandbox opt-in. Native workers inherit the
   effective session policy. The PM may fetch and integrate upstream changes as needed for its
   approved delivery, preserving unrelated work and following repository branch protection.
   Do not add per-action approval prompts to ordinary authorized commits, PRs or merges.
   Keep no silent model fallback and no automatic Claude-hook installation. Scope checks remain
   audits and host-enforced restrictions cannot be overridden by a skill. Keep native worker roles and the
   tool-less external Claude review adapter. Never translate an explicit `expert-builder` route
   silently; require an explicit route change before native execution.

## Ordered implementation tasks

Paths below are relative to this repository. `skill/` abbreviates
`plugins/deliver/skills/deliver/`. New filenames are proposed, not an existing CLI promise.
The runtime's existing `scripts/pm.mjs` should remain the entry point for project operations.

### Milestone 1: current upstream state and sequential delivery

**T00. Set execution defaults and record PM delivery authority.** Dependencies: none.
Own `bin/deliver.mjs`, launcher tests, applicable project/skill instructions and permission-policy
documentation. Default launched execution to no OS sandbox, with explicit opt-in sandboxing.
Carry the effective policy into worker dispatch and report host-imposed restrictions accurately.
Replace blanket bans on PM commits/pushes with the approved-scope authority stated above; preserve
worker ownership boundaries and independent review. Keep global settings and unrelated config intact.
Acceptance: fake-launcher tests show unsandboxed defaults and a working explicit sandbox override;
no provider is called. The documented PM workflow commits, pushes story branches, opens PRs and
merges after required checks without repeated permission questions. Read-only operations remain
read-only by contract. Update contradictory instructions before dispatching implementation tasks.

**T01. Pin the compatibility contract and fixtures.** Dependencies: none.
Own `tests/fixtures/upstream-v0.25.1/`, a parity test manifest and provenance notices.
Copy the unchanged upstream readers and required templates with their dependencies and source
commit recorded. Define expected supported fields, states, identities and deliberate differences.
Acceptance: upstream fixtures execute unchanged in disposable repositories; the old 0.22.0
fixtures remain byte-for-byte intact; every capability in this plan maps to a task and check.

**T02. Implement project readers and the shared inspector.** Depends on T01.
Own new `skill/scripts/lib/project-state.mjs`, `skill/scripts/lib/story.mjs`, the read-only PM
status route and focused project-state tests. Parse approval, plan policy, story contracts and
Execution blocks; inspect claims, branches, integration history, worktrees and handoff freshness.
Derive phase, current sprint, unreadable stories, missing retrospectives and next reference.
Acceptance: match upstream 0.25.1 for valid fixtures, including approval precedence, tiny projects,
missing older-sprint retrospectives and handoff-only commits. Malformed JSON, directories/FIFOs,
missing Git objects and unsafe paths produce bounded diagnostics, never a false completed state.

**T03. Bind approval and story claims to runtime evidence.** Depends on T02.
Own approval/claim operations in `skill/scripts/lib/pm.mjs`, binding changes in `deliver.mjs`
and `lib/state.mjs`, and focused lifecycle tests. Support pending/approved/revoked markers,
Git plan digests, tracked-file checks, actor identity and the current story branch. Detect both
legacy and current projects before runtime start. Preserve exact criterion text and scope.
Acceptance: current upstream approval is reused; plan edits, lost ownership, route changes,
foreign branch claims and duplicate runs block work. A shared project cannot bypass its approval
through standalone Quick. Claim/resume never resets counters or overwrites another actor's work.

**T04. Add execution transitions and commit reconciliation.** Depends on T00 and T03.
Own coordinator transition helpers, runtime/scope integration and transition regression tests.
Support `claimed`, `building`, `built`, `in-review`, `blocked` and terminal `merged`; record retry
and fix counters before dispatch. Add the authorized commit transition described above. Use
recoverable, path-bounded writes with before-image conflict checks for story/runtime updates.
Acceptance: sequential build/commit/gate/review/fix/resume works in real temporary Git repos;
unauthorized HEAD/index changes still fail; a bookkeeping update cannot conceal a changed
criterion, source file or receipt. Kill/restart cases retain spent attempts and cumulative scope.

**T05. Integrate verified stories and produce compatible handoffs.** Depends on T04.
Own completion/handoff helpers, `references/compatibility.md`, shipping instructions and
0.25.1 round-trip tests. Prepare merge metadata from actual evidence; record merged state only
after checking the real integration result. Write `BASE_COMMIT` handoffs using the current actor.
Implement the PM-owned remote PR path when an authenticated remote integration is available:
push the story branch, create/update the PR, inspect required checks, merge when they pass and
verify the actual remote merge result before recording completion. Use standing delivery
authorization rather than asking again at each step. Keep local integration available for projects
without a remote. Report missing authentication or branch-protection blockers without bypassing them.
Acceptance: upstream -> Codex -> upstream and Codex -> upstream -> Codex story-boundary tests
retain identity, criteria, ownership history and counters. Altered integration contents require
fresh checks. `finish` alone cannot release a claim or mark merged. Fake remote-provider tests
exercise PR creation/update, pending/failed checks, merge and post-merge reconciliation without
real network writes. No test invokes a real model.

Milestone exit: complete one current-format shared story, interrupt/resume locally, and hand its
project state back to the unchanged upstream reader. Keep this focused on sequential delivery.

### Milestone 2: planning through recovery

**T06. Complete planning artifacts and operation routes.** Depends on T01 and T02 contracts.
Own new phase references and project templates under `skill/assets/`, routing in `SKILL.md`,
and related packaging validation. Cover discovery, specify, clarify, constitution, plan/sign-off,
decomposition, story readiness, verification and completion reports. Add scale/checkpoint policy
and Enter/Leave rules to phase references. Keep native invocation through `$deliver <operation>`
or an ordinary request; do not promise Claude slash-command registration in Codex.
Keep stable `US-`, `FR-`, `AC-` and `SM-` identifiers and observable acceptance criteria. Resolve
blocking `[NEEDS CLARIFICATION]` markers before planning; preserve existing IDs on revision.
Default clarification to one question at a time, at most five per session, recording each answer
in the authoritative artifact immediately. Existing user preferences can change that interaction.
Acceptance: tiny and standard examples produce the right artifacts; large/regulated policy adds
the required constitution, SpecDD, traceability, reports and security review. Story criteria have
one authoritative home; decomposition does not claim stories. Every operation loads only its
relevant references, and existing explicit user constraints override template defaults.
Validate an installed operation map with each operation's arguments, output and read/write
behaviour. Distinguish skill operations from low-level runtime commands and from free-form
launcher prompts; no operation is advertised as registered `/deliver:*` syntax in Codex.

**T07. Implement artifact analysis and quality checklists.** Depends on T06.
Own `references/governance.md`, checklist assets, analysis helpers where deterministic checks
are useful, and malformed-artifact fixtures. Cover requirement/story/verification coverage,
dependency cycles, unknown references, conflicting paths, unresolved clarification, missing
gates and risk/reviewer mismatch. Run analysis after planning and again after decomposition.
Acceptance: seeded omissions and contradictions produce located findings without edits;
blocking findings prevent first claim under applicable scales. Model judgement remains labelled
as judgement; regex checks cannot claim semantic correctness or invent a PASS.

**T08. Deliver phase-aware resume, doctor and hook output.** Depends on T02-T05 and T06.
Own `references/recovery.md`, PM diagnostic routes, `plugins/deliver/hooks/context.mjs` and
diagnostic tests. Use the inspector everywhere. Report approval drift, ambiguous runs, stale
claims, missing evidence/worktrees, overlapping ownership and migration needs. Correct-course
revokes material approval and preserves exhausted budgets. Keep the hook bounded and read-only.
Add environment readiness checks for installed runtimes, dependencies, actual gate availability,
required configuration names, native role installation/model settings and project instructions.
Include CI/container configuration and documented bootstrap requirements when present.
Use bounded probes without model inference or setup changes. Return located `OK`, `MISSING`,
`DRIFT` or `UNKNOWN` results; support upstream's `tmp/environment-check.md` readiness report
when that output is requested, while the read-only inspector itself never writes reports.
Acceptance: fresh-process resume selects the correct phase/story or reports the ambiguity;
an older missing retrospective is selected before a newer completed sprint. Doctor never clears
locks, steals claims, migrates, fetches, edits configuration or removes worktrees as a side effect.
The workflow works when hooks are absent, disabled or receive malformed input.

**T09. Add explicit legacy migration and existing-run reconciliation.** Depends on T03-T05.
Own migration helpers/reference and migration tests. Produce a read-only migration preview with
exact proposed writes/removals before applying it within authorization. Cover upstream legacy
`tmp/`, flat PM and actor layouts, including old identities and pre-`pm-meta` stories. Read open
story branches as well as integration state; preserve the newest credible counters and flag
conflicts. Convert approved plans only after approved migration edits and then compute the digest.
Acceptance: fixtures retain original criteria, teammates, terminal stories and spent budgets;
conflicting evidence requires reconciliation; unknown data is retained in a reviewed migration
record or left untouched. Clean reruns are idempotent and interrupted writes recover safely.
Do not remove untracked/uncommitted legacy history. A conversion of an active `.deliver` run
retains old evidence as history and requires an explicit new binding/baseline, never old PASS reuse.

Milestone exit: a new project can be planned and decomposed, and an old project can be migrated
and resumed without duplicated state or unacknowledged data loss.

### Milestone 3: sprint and supporting operations

**T10. Add sprint retrospectives and checkpoint enforcement.** Depends on T05-T08.
Own `references/retrospective.md`, retro assets and sprint tests. Review the sprint's actual
integration range, narrowing structural diffs for a large sprint. Answer the upstream three
questions from evidence, propose AGENTS.md changes as a diff and record carried-over work.
Acceptance: unfinished sprints cannot run retro; missing records block the next claim for the
applicable scales; tiny/small skip it. A directory/FIFO is not a record. Open major findings
become explicit follow-up stories; learned instructions are not silently applied or waived.

**T11. Complete knowledge, research, scoped review and decision advice.** Depends on T06-T08.
Own knowledge/research/review/advice references, wiki/report templates and bounded role changes.
Add the upstream wiki schema and ingest/query/lint handoffs for project scales that require it.
Expose review scopes `recent`, `worktree`, `branch` with an explicit integration base, and
`codebase`; provide a bounded read-only second opinion for decisions through native agents.
Define risk-to-panel selection from the story and actual diff: integrity always, architecture
for structural/interface changes, and security for relevant trust boundaries or regulated scale.
Record extra required lenses discovered in the diff. Preserve upstream `CONCERNS` as minor
findings when adapting it to the runtime's PASS/FAIL receipt format; never discard the findings.
Acceptance: scoped packets contain the actual intended diff; research cites primary sources;
wiki pages cite authoritative artifacts and supersede stale decisions. Read-only operations do
not change project state. External Claude review remains explicit and never claims to run gates.

**T12. Complete parallel shared-story delivery and recovery.** Depends on T05, T07 and T08.
Own `references/parallel.md`, readiness/claim integration and parallel lifecycle tests.
Use isolated worktrees for independent ready stories, check dependencies and overlapping scopes,
and integrate serially. Reconcile per-story Execution state against worktrees after interruption.
Keep the existing benefit that unrelated sibling commits do not invalidate native local receipts.
For waves containing upstream's external runner, observe its stricter shared-ref timing rules.
Acceptance: two independent stories finish without crossed ownership/evidence; overlap and
dependency cases are blocked; failed/dirty worktrees survive; integration changes are checked
again. Explain local versus remote claim visibility and never claim distributed atomic locking.

**T13. Implement measured builder comparisons.** Depends on T05 and T11; T12 supplies worktrees.
Own a benchmark reference, result schema, deterministic scorer and fake-provider tests.
Run two explicitly selected available builders against the same approved story/base in isolated
worktrees. Record first-pass gates, review findings, retry counts, elapsed time and exposed token
usage; unavailable measurements are null. Keep the benchmark retry rule separate from delivery.
Require two explicit available builder configurations, using compatible native role definitions
or explicitly configured generic dispatch. Reject an unavailable configuration before work;
never mutate the story's persisted route or silently substitute a model. CI exercises both sides
through fake adapters, not duplicate unlabelled runs of the single default builder role.
Acceptance: neither result is merged or auto-selected as the new route; dirty worktrees are
preserved; tests use fake providers. Native comparisons cover the comparison workflow only. The exact
upstream Opus-versus-Codex pairing remains optional and unavailable until an explicitly enabled
external builder integration exists; the existing Claude review adapter is not such a builder.

Milestone exit: sprint completion, research/knowledge support, independent reviews, parallel
delivery and comparisons are available through documented native operations.

### Milestone 4: release and prove the workflow

**T14. Package, document and evaluate parity.** Depends on T01-T13.
Own README, evaluation documentation, project AGENTS.md conventions, release metadata/notices,
packaging validation and worked examples. Replace the active 0.22.0 progress guidance across the
skill and hook. Keep legacy references only where labelled migration/compatibility material.
Document setup conflicts and an explicit upgrade path that preserves customized skill/role files.
Do not make setup overwrite differing installed files as an incidental part of this release.
Acceptance: all tests and packaging validation pass; an installed copy contains every referenced
asset/module; a worked standard project demonstrates planning through handoff and retrospective.
Record which acceptance is deterministic, independently reviewed or actually exercised by models.

Run a native end-to-end trial when authorized for implementation: plan approval, build, real gate,
independent review, distinct verification, interruption/resume, integration and next-story handoff.
Before claiming workflow efficiency, run the matched plain-Codex/Deliver/Deliver+SpecDD comparison
in `docs/evaluation.md`. Paid external-provider and additional-platform trials are separately
reported; missing trials cannot be represented by fixture success.

Milestone exit: publish a capability/evidence matrix with all deliberate differences and any
remaining optional-provider/platform limitations. A version number alone does not establish parity.

## Dependencies and work allocation

The critical path is T01 -> T02 -> T03 -> T04 -> T05 -> T08 -> T10 -> T14.
T00 can run alongside the initial read-only compatibility work and must pass before T04.
T06 can proceed once T01/T02 contracts are stable; T07 follows it. T09, T11 and T12 can run
alongside each other once their dependencies pass. T13 follows the review and worktree contracts.
Do not parallelize edits to `lib/pm.mjs`, `lib/state.mjs`, `lib/scope.mjs`, `deliver.mjs` or the
skill entry. Assign each implementation packet one owner, exact write paths and relevant reads.

The highest-uncertainty tasks are T04 and T09 because they change evidence identity and reconcile
historical state. Complete and independently review T04 before expanding the workflow. Do not
estimate a completion percentage or calendar date from task count; refine estimates after T05.

## Verification and release criteria

Run focused Node tests for each changed runtime contract, then the repository gates once the
milestone is integrated:

```sh
npm test
npm run validate
```

Use real temporary Git repositories and fake model providers in automated tests. Add regression
coverage for changed behaviour rather than tests that merely repeat the implementation. Template
and instruction edits need route/reference validation and artifact inspection, not artificial
unit tests of prose. Independent review checks the resulting workflow contracts.

Release requires:

- Every capability row has implemented behaviour, acceptance evidence or a clearly named
  deliberate host/provider difference. No vague "parity complete" claim over unsupported paths.
- Both current upstream story-boundary directions pass against unchanged pinned readers.
- Approval drift, claim loss, unexpected writes, receipt staleness and exhausted budgets fail
  safely across restart, authorized commits, migration and integration.
- Existing standalone Quick and scope/SpecDD/external-review regression tests remain green.
- No production code or instructions treat the retired `pm/` files as the new project default.
- Unsandboxed execution is the default; sandboxing requires an explicit selection. Tests verify
  launcher behaviour without modifying the user's global settings or making real provider calls.
- The PM can commit, push scoped branches, create/update PRs and merge verified work under
  standing delivery authorization, without repeated confirmation. Failed checks block merging.
- No tests invoke paid services or mutate real remotes, and no helper installs software as a
  side effect of a Git/PR operation.
- The final independent reviewer and verifier assess the actual release diff and evidence.

## Repository evidence used

- Current `README.md`, `docs/evaluation.md`, skill entry, workflow/runtime/recovery/compatibility,
  governance/knowledge/parallel references and native role definitions.
- Current `scripts/lib/pm.mjs`, `scripts/lib/state.mjs`, `scripts/lib/scope.mjs`, runtime entry
  and optional context hook under the packaged skill/plugin.
- Upstream `CHANGELOG.md`, command definitions, project-manager references, approval/story/plan/
  handoff templates, hooks and the completed 0.25/0.25.1 implementation plans.
- Existing 0.22.0 compatibility fixtures and successful local test/validation results.

This plan targets the pinned local release. Reassess any newer upstream changes before widening
scope; do not silently turn implementation into an open-ended upstream chase.
