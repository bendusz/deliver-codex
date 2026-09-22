# Deliver for Codex

Codex-first software delivery, adapted from Deliver 0.22.0. The main session uses
**GPT-6-Astra**. Native specialist agents use GPT-5.6-Sol and GPT-5.6-Luna.
Claude is an optional external reviewer, never a required intermediary.

## Use it in Codex CLI

Requires Node.js 22+, Git, and an authenticated Codex CLI with native agents.
CLI setup was checked against Codex 0.153.4 on macOS. No npm dependencies are required.

Clone the repository, then install the short `deliver` command if desired:

```sh
git clone https://github.com/bendusz/deliver-codex.git
cd deliver-codex
npm link
deliver setup --project /absolute/path/to/your/repo
deliver --project /absolute/path/to/your/repo "Implement the approved change"
```

Without a global npm link:

```sh
node bin/deliver.mjs setup --project /absolute/path/to/your/repo
node bin/deliver.mjs --project /absolute/path/to/your/repo "Plan this feature"
```

Setup copies the self-contained skill to `.agents/skills/deliver` and the native role definitions
to `.codex/agents/`. It does not change your global settings, project `config.toml`, AGENTS.md,
Git history or installed plugins. Matching files are left alone; differing files cause a
preflight conflict. An I/O failure can leave newly created partial files; setup reports that
and a rerun can complete them without overwriting existing content. There is no destructive updater.

After setup, `$deliver` also works in an ordinary Codex session. That invocation retains the
session's selected model. The `deliver` launcher selects GPT-6-Astra and GPT-5.6 worker defaults
for that invocation only. It launches with `--sandbox danger-full-access` and
`--ask-for-approval never` by default. Pass `--sandbox read-only` or
`--sandbox workspace-write` to opt into a sandbox; those modes use `on-request` approval.
Native workers inherit the effective session policy. Models never silently fall back. Use
`--model` and `--effort` for an explicit main-session override. The launcher passes per-session
flags and does not edit global or project configuration. Inherited host restrictions still apply.

Use `setup --dry-run` to inspect installation paths, and `--dry-run` on the launcher to inspect
the actual argument list without calling a model. This repository has not installed itself
globally or changed any of your existing projects.

## Workflow

| Mode | Operating model |
|---|---|
| Quick | Main agent builds a bounded change; an independent reviewer also checks acceptance |
| Managed | Approved plan, bounded tasks, native builders, independent review and durable checkpoints |
| Governed | Managed delivery plus traceability, risk-specific review and a distinct verifier |

SpecDD, wiki/librarian and parallel worktrees are separate choices, not automatic consequences
of project size. Review-only and discovery-only requests remain read-only. For an approved
delivery, the PM may commit scoped work, push story branches, create or update pull requests,
and merge verified code without asking again for each step. Builders and reviewers do not
perform Git integration. `finish` records a verified task; the PM still checks the repository's
policy and actual integration result before recording a merge. Installation, paid provider
calls and deployment need their own authorization.

The 13 native role templates include builder, explorer, reviewer, verifier, security,
architecture, researcher, debugger, test engineer, technical writer, spec architect, librarian,
and the optional Claude review adapter. They are loaded per dispatch, not all into the main prompt.
The role files pin model/effort; changing a worker model requires changing its role or explicitly
using an unpinned generic native agent. A skill cannot override host permission policy.

## Executable controls

The skill drives the workflow. A dependency-free Node runtime handles the error-prone bookkeeping:

- Unique run IDs, atomic revisioned state and exclusive per-run locks.
- Approval bound to the current plan's contents in Managed/Governed.
- Task-before-write baselines, cumulative path checks and pre-existing dirty-file protection.
- Code-bound gate evidence, exact command matching and environment digests.
- Snapshot-bound independent review and acceptance receipts.
- Persistent retry/fix limits and explicit checkpoints.
- Frozen SpecDD authority from literal Owns/Can modify paths when contracts are selected.

See [the runtime command guide](plugins/deliver/skills/deliver/references/runtime.md) and
[the task example](plugins/deliver/skills/deliver/assets/task.example.json).
Do not copy example PASS receipts into real work. The coordinator must obtain actual review
and evidence. Reviewer identities are attestations, not authentication.

Shared project progress lives in the original `pm/pm-state.json`, `pm/actors/` and `pm/log.md`.
Codex execution receipts live under `.deliver/runs/`; local gate logs live under `.deliver/logs/`.
Keep durable checkpoints with work under your repository's policy. Review logs for sensitive output before
sharing. State currently binds to its checkout's absolute path. Moving or cloning a checkout
requires deliberate adoption/reconciliation; it is not automatic cross-machine resume.

## SpecDD and Claude

[SpecDD support](plugins/deliver/skills/deliver/references/specdd.md) includes authoring templates,
a conservative structural/literal-path checker, exclusive ownership checks and frozen task
authority. It is not a complete upstream language validator. Contract changes happen in a
separate approved phase before code-task baselines. The optional official SpecDD plugin can
provide richer workflows; it is not installed or bundled here.

[Claude review](plugins/deliver/skills/deliver/references/claude-review.md) sends only an explicitly
prepared packet after `--allow-external`. The adapter disables tools/MCP/customizations, uses a
temporary working directory, validates output and never retries or falls back silently. Existing
Claude authentication is used. No Claude executable or credential is needed for native delivery.
The adapter was tested with a fake provider, not a paid live request.

## Packaging and limits

`plugins/deliver/.codex-plugin/plugin.json` packages the skill for Codex. Native TOML roles still
need project setup or explicit role-instruction dispatch. An optional SessionStart hook emits
bounded pointers to existing run IDs when installed as a plugin and trusted by Codex. It never
enforces approval or restarts work. Project skill setup does not install that optional hook.
No marketplace or global plugin configuration is modified by this build.

The original Claude-hosted Deliver remains unchanged. The shared-state adapter supports its
0.22.0 project/actor formats and completed-story handoffs in both directions. It preserves IDs,
unknown fields, acceptance text and ownership; runtime finish alone never claims a merge.
Use [the shared-state command guide](plugins/deliver/skills/deliver/references/compatibility.md).
Mid-story takeover, older-schema migration and simultaneous PM writers across hosts are not supported.
ChatGPT can use the planning/artifact instructions,
but local execution requires repository tools and does not work merely by attaching this README.

Scope checks are post-run audits, not an OS sandbox. Gate commands run under the host's current
permissions. Symlink write aliases are rejected. Relevant ignored task inputs are fingerprinted;
other ignored caches are advisory. External services and dependency environments can change
without a code change, so rerun checks when their assumptions change. Per-run locks are not
cross-clone claims or a multi-user scheduler. Windows native CLI/shim behavior and Linux have
not been live-validated in this build.

The review fixes changed snapshot calculation for read aliases, Git metadata and submodules.
If upgrading an active run from the initial implementation, preserve its state and explicitly
reconcile a new baseline. Do not reuse its old gate or review receipts.

## Verification

```sh
npm test
npm run validate
```

Run these development commands from a source checkout. Tests use temporary repositories,
real Git/Node checks, and fake model executables. They cover
setup and launcher behavior, resume, stale evidence, governance, failure rounds, contract scope,
symlinks, shared PM round trips against unchanged original readers, optional hooks and external-review
failure handling. They do not establish model
quality or token savings. See [the evaluation plan](docs/evaluation.md) before changing routing defaults.

Licensed GPL-3.0-or-later. See [NOTICE.md](NOTICE.md) for provenance.
