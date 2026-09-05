# Hosts and existing Deliver projects

## Codex

The project setup command installs this self-contained skill and native TOML roles without
editing `.codex/config.toml` or global settings. Plugin installation distributes the skill;
it does not by itself install TOML role definitions. Use setup for roles, or dispatch native
agents with the matching role instructions. The launcher selects the main model; ordinary
`codex` sessions retain their existing model configuration.

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

## Legacy `pm/` projects

Treat old `pm/pm-state.json`, actor state, handoff, plans and stories as read-only input until
the user authorizes a migration. The original project remains the source of truth. Preserve
actor IDs and counters; do not rename or delete its state.

To adopt: inspect the current story and actual diff, resolve conflicting actors/claims, create
a new task packet with existing acceptance IDs and bounded touches, and show the mapping.
Create new `.deliver/` state only after agreement. Approval binds to the selected current plan,
not a copied legacy boolean. Keep old and new coordination separate; never run both workflows
on the same active story. Automated migration is not provided in this release.
