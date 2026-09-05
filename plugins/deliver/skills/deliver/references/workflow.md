# Delivery workflow

## Mode and authorization

Quick uses a compact task packet and direct implementation. It still needs scope checks,
project gates, and independent review, but not a product spec, sprint, wiki, or a claim commit.
For a truly trivial non-code edit, use the host's ordinary editing workflow instead of
forcing Deliver onto the task.

Managed keeps an approved plan, bounded tasks, delegated builds and durable state.
Governed adds requirement traceability, explicit review lenses and a distinct verifier.
Ask for approval of material decisions, not routine steps within an already authorized task.
Do not reinterpret plan approval as permission to publish, install, deploy, or spend money.

## Discover and plan

Inspect repository status, applicable AGENTS.md instructions and real commands. Preserve existing
work and conventions. Delegate a bounded read-only map to `deliver-explorer` when exploration
would otherwise crowd the main context. Research current APIs through available documentation
tools; give the researcher a question and output limit.

Clarify only missing decisions that change scope, acceptance or architecture. In Managed and
Governed, write a concise plan with objective, non-goals, task ordering, risks and executable
verification commands. The product spec, if needed, owns intent; the plan owns delivery. Existing
user documents take precedence over creating another copy. Show the plan and wait for explicit
approval. Record it with the runtime only after the user actually approves.

Use the task template in `assets/task.example.json` as a shape, not as project content. Each task
has an outcome, acceptance IDs, bounded write paths, relevant read paths and gate commands.
Do not make a builder repeat repo-wide discovery. If paths cannot be bounded, resolve the missing
design or delegate a read-only investigation first. Model choice is not part of the task schema.

## Build and check

Read `runtime.md`. Start a run and task before writes so a before-state exists. In Quick the
main thread is the builder. In Managed/Governed dispatch `deliver-builder` with the task packet,
absolute root, relevant instructions, contract paths and any unresolved evidence. Request a
short summary, changed paths, targeted checks and blockers. Do not pass an entire transcript.

After every writer, run the scope check. Unexpected paths stop the workflow with work preserved.
Builders run targeted self-checks. The coordinator runs the declared final gates against the
resulting code. Never use a builder's summary as gate evidence. Gate commands can mutate files
or external systems, so inspect and authorize them before execution. A failed gate enters a
bounded fix round; a blocked builder enters a bounded retry. Persist both through the runtime.

## Review, acceptance and finish

Dispatch `deliver-reviewer` with the task, baseline revision/diff, exact current code identity,
gate evidence and referenced contracts. It inspects code independently and returns the review
receipt plus evidence for acceptance criteria. Add `deliver-security` or
`deliver-architecture` only for relevant risk, and retain unresolved findings in the aggregate.
Never label a tool-less external review as having run tests.

For Governed, `deliver-verifier` independently checks every criterion and previous major finding.
For Quick/Managed, the independent reviewer may perform this job in the same dispatch. Record
review and verification receipts only for the exact code state inspected. A later mutation
requires renewed relevant gates and review. UNKNOWN blocks completion until evidence is obtained
or the user changes the requirement through correct-course.

Finish records completion, it does not commit or merge. Summarize changes, commands, acceptance
evidence and remaining risks. Commit or publish only within the user's separate authorization.
Do not force branches or no-ff merges onto a repository's existing delivery policy.
