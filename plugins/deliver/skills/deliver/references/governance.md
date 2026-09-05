# Analysis and governed delivery

Analyze is read-only. Inspect only relevant spec, plan, task, contract, receipt and knowledge
artifacts. Check unresolved decisions, untestable acceptance criteria, missing commands,
orphan scope, requirement coverage, dependency cycles, inconsistent approval, overlapping
write scopes, missing evidence and contradictions between actual risk and selected reviewers.
Report severity, evidence location and proposed next action. Do not update state or fix artifacts.

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
