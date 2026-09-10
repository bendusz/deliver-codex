# Analysis and governed delivery

Analyze is read-only. Inspect the relevant spec, plan, stories, approval, contracts, receipts and
knowledge artifacts. Report severity, an exact evidence location and a proposed remediation. Never
edit, scaffold, check off or fix an artifact during analysis, including when input is malformed.

Run deterministic analysis after the plan and again after decomposition. Use pre-claim analysis for
the selected story when the scale requires it. The post-plan stage does not require story files and a
pending approval marker is expected there. Post-decomposition and pre-claim analysis require an
approved, tracked marker whose digest matches the plan. `tiny` and `small` do not acquire a new
analysis gate; after valid deterministic inputs their semantic review status is `NOT_REQUIRED`.
`standard`, `large` and `regulated` require semantic review after the deterministic scan.

The importable analyzer returns factual findings separately from semantic review prompts and binds
them to a digest of every inspected file, directory listing and missing artifact. `UNKNOWN` input is
never a pass. A clean regex scan means only that its factual checks found no defect. It cannot declare
acceptance criteria testable, confirm command `N/A` choices, interpret constitution rules or establish
that risk lenses fit the actual change. Keyword and path matches are candidates for semantic review,
not proof that a lens is required. First-claim enforcement consumes the readiness result and the required
semantic-review evidence; the analyzer does not mutate claim state itself.

Run the bounded CLI as `node <skill-directory>/scripts/analyze.mjs --root <project> --stage
<post-plan|post-decomposition|pre-claim>`. Add `--story <S<n>-<n>>` for one pre-claim target and
`--format json` for machine-readable output. The CLI reads regular local artifacts only and writes
the report to standard output. It has no report-output or repair option.

Use the packaged checklist that matches the artifact:

- `assets/templates/checklist-spec-quality.md.template`
- `assets/templates/checklist-plan-quality.md.template`
- `assets/templates/checklist-story-readiness.md.template`
- `assets/templates/checklist-verification-quality.md.template`

Quality checklists are required project artifacts for `large` and `regulated` scales and optional
at lower scales. Their checkboxes never replace deterministic gates, independent review or verification.
At preimplementation stages, deterministic analysis inventories the exact phase-appropriate
spec, plan and story checklist paths. It also inventories every exact bounded `.sdd` path declared
by a parsed story. Missing, unreadable or nonregular required inputs block or make readiness unknown,
and their current bytes form part of the analysis content identity. Analysis never discovers
contracts by wildcard and never installs or scaffolds SpecDD.

Copy a checklist only in an authorized checklist operation. Check a box only after recording concrete
evidence. Leave missing or uncertain evidence unchecked and name the remediation. The analyze operation
prints its report and does not create a checklist or source report automatically. Checklist file or
checkbox presence establishes no semantic PASS; an applicable reviewer must judge the cited evidence.

Governed delivery requires explicit approved intent, requirement-to-task-to-evidence links,
an independent builder/reviewer/verifier separation and a durable acceptance report. A project
constitution is useful when actual organizational constraints need recording; do not create
one merely to fill a template. Include security review for auth, secrets, hostile input or
privileged integrations, and architecture review for public contract or structural changes.

Aggregate findings without voting them away. An unresolved block or major issue stops the task.
A reviewer may retract a finding with evidence; record that resolution. A failed test is not
made acceptable by a reviewer saying the code looks correct.

Completion reports link each requirement to the relevant code and evidence, name waived or
unavailable checks, and retain UNKNOWN outcomes as blockers. This workflow supports an audit
trail; it is not certification of regulatory compliance.
