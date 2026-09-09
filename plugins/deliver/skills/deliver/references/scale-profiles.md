# Project scale and checkpoints

Project scale controls durable artifacts. Execution mode controls orchestration: Quick, Managed or
Governed. Select each independently and record both decisions. New shared projects default to
`standard`; an imported project's recorded scale remains authoritative.

| Scale | Required artifacts and checks |
| --- | --- |
| `tiny` | Minimal plan, one ready story, real gates, independent review and verification. No separate spec, analysis report, wiki, durable verification report or retrospective. |
| `small` | Light spec, plan and ready stories. Real gates, independent review and verification remain required. Analysis, wiki and retrospective are optional. |
| `standard` | Spec, plan, post-plan and post-decomposition analysis, ready stories, risk-selected review, verification, wiki and sprint retrospective. SpecDD and durable verification reports are optional. |
| `large` | Everything in `standard`, plus a constitution, quality checklists, SpecDD contracts, durable verification reports and full requirement-to-story traceability. |
| `regulated` | Everything in `large`, plus mandatory security review, requirement-to-story-to-verification traceability, retained reports and a clean wiki lint before completion. |

Scaling down removes listed artifacts only. It never removes explicit approval, scope controls, real
project gates, independent review, acceptance verification or repository safety. Shared-project
delivery uses a distinct verifier at every scale. Standalone Quick or Managed work may combine
review and acceptance in one independent dispatch under the existing execution contract.

## Checkpoint policy

Checkpoint policies set a review cadence. They do not create extra permission requirements for
work already covered by the user's approval. Apply a pause only when the user explicitly selected
that checkpoint policy. If the user did not choose a policy, record `sprint-level` as the planning
default, report progress at sprint boundaries and continue through the approved scope.

| Policy | PM behavior when explicitly selected |
| --- | --- |
| `story-level` | Pause for user review before each merge. |
| `sprint-level` | Complete the authorized stories, run the sprint review and retrospective, then pause before the next sprint. This is the default. |
| `autonomous` | Continue through the approved scope and required checks without routine pauses. |

The user's latest explicit preference or authorization overrides a default checkpoint. Plan approval
gives the PM standing authority for scoped commits, branch pushes, pull request creation or updates, and verified merges.
High-risk or cross-component work still receives the required gates, review and verification, but it
does not add a user permission step while it remains inside that approval. Pause for direction when the
user selected a pausing checkpoint or when requirements or scope would materially change beyond what
they approved. Installation, paid provider calls and deployment still need their own authorization.

Record `Scale`, `Checkpoint policy`, `Integration branch`, `Skeleton` and `Execution mode` in the
plan. Raising scale adds missing artifacts. Lowering scale requires the user's agreement.
