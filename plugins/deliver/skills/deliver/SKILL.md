---
name: deliver
description: Plan, implement, review and resume software delivery using bounded tasks and repository evidence. Use for a requested delivery workflow or continuing a Deliver project, not unrelated questions or code inspection alone.
---

# Deliver

Deliver the user's requested change. Select Quick for a bounded fix, Managed for multi-step
delivery, and Governed when explicit traceability or independent verification is required.
Explain the choice briefly. Do not turn a review or discovery request into implementation.

The launcher selects `gpt-6-astra` for the main session. If this skill was invoked inside an
existing chat, keep that chat's model; a skill cannot change it. Native worker roles use GPT-5.6.
Do not silently substitute models or require Claude.

## Working contract

- Shared progress lives in `docs/approval.json`, `docs/stories/` Execution blocks and Git history.
  `.deliver/` holds Codex execution evidence, not another backlog. Read `references/compatibility.md`
  before starting or switching hosts, and switch at completed story boundaries.
- Quick may implement directly. Managed and Governed delegate bounded implementation to
  `deliver-builder`. Never edit a scope while another worker owns it.
- Use native subagents when delegating. Start with a fresh, minimal task packet when the host
  supports it. If named roles are unavailable, use their matching instructions from
  `assets/codex-agents/` with native agents. If delegation is unavailable, disclose that and
  agree a single-agent alternative; do not claim independent review.
- The builder never reviews its own work. One independent reviewer may also verify acceptance
  in Quick and Managed. Governed uses a separate verifier. Missing evidence is UNKNOWN, not PASS.
- Approval covers the requested scope only. Managed and Governed record explicit plan approval
  before implementation. A clear implementation request can authorize Quick work directly.
- Preserve unrelated work. Approved delivery gives the PM standing authority to commit scoped
  work, push story branches, create or update pull requests, and merge verified code under the
  repository's policy. Do not ask again for each of those steps. Builders and reviewers never
  perform Git integration. Never expand scope, loosen a contract, install dependencies, send
  code to another provider, deploy, or spend money without specific authorization.
- Record bounded retry/fix counts and continuation points on disk. Read actual state after
  interruption rather than relying on the transcript. Stop after two builder retries or three
  fix rounds and report what needs a decision.

## Choose one reference

| Request or phase | Read |
|---|---|
| Operation names, arguments, output or authority | `references/operations.md` |
| Discover or start a new project | `references/discovery.md` |
| Specify or clarify product intent | `references/specification.md` |
| Constitution, plan or approval | `references/planning.md` |
| Project scale or checkpoint policy | `references/scale-profiles.md` |
| Decompose an approved plan or check story readiness | `references/decomposition.md` |
| Build, gate, review or verify | `references/workflow.md` |
| Integrate, produce verification reports, close stories or write final handoffs | `references/shipping.md` |
| Execute state, scope, gate or receipt commands | `references/runtime.md` |
| Resume, handoff, doctor or correct-course | `references/recovery.md` |
| SpecDD skeleton, contracts or contract-aware change | `references/specdd.md` |
| Research, wiki query, ingest or lint | `references/knowledge.md` |
| Parallel story implementation | `references/parallel.md` |
| Independent Claude review explicitly requested/enabled | `references/claude-review.md` |
| Analyze artifacts or govern a high-assurance delivery | `references/governance.md` |
| Shared project state, host switching or an existing `pm/` project | `references/compatibility.md` |

Resolve resource paths relative to this skill directory, never a cache path remembered from
another session. Invoke `node <skill-directory>/scripts/deliver.mjs help` for the runtime's
current command contract. The skill and runtime work without lifecycle hooks.
