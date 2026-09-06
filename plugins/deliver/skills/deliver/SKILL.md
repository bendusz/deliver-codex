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

- Project progress lives in the original `pm/pm-state.json`, actor files and log. Read
  `references/compatibility.md` before starting or resuming a project. `.deliver/` holds
  Codex execution evidence, not a second project backlog. Switch hosts at completed story boundaries.
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
- Preserve unrelated work. Never expand scope, loosen a contract, install dependencies, send
  code to another provider, or commit/push merely because a workflow step mentions it.
- Record bounded retry/fix counts and continuation points on disk. Read actual state after
  interruption rather than relying on the transcript. Stop after two builder retries or three
  fix rounds and report what needs a decision.

## Choose one reference

| Request or phase | Read |
|---|---|
| Start, discover, specify, clarify, plan or build | `references/workflow.md` |
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
