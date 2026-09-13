# Deliver for Codex

Codex-first delivery skill and dependency-free Node runtime. The original Claude-hosted
Deliver at `../pm-skill` is reference material, not an edit target.

## Commands

- Test: `npm test`
- Validate packaging and instructions: `npm run validate`
- CLI: `node bin/deliver.mjs --help`
- Runtime: `node plugins/deliver/skills/deliver/scripts/deliver.mjs help`
- Shared project state: `node plugins/deliver/skills/deliver/scripts/pm.mjs help`

## Layout

- `plugins/deliver/skills/deliver/`: self-contained skill, references, runtime and assets.
- `plugins/deliver/skills/deliver/assets/codex-agents/`: native Codex role templates.
- `bin/`, `scripts/`: launcher, explicit project setup and repository validation.
- `tests/`: Node test runner; fixtures use disposable temporary repositories.

## Conventions

- Node.js 22+, ESM, built-in modules only. No install-time or import-time side effects.
- Main model `gpt-6-astra`, worker defaults `gpt-5.6-sol`; no silent model fallback.
- Preserve project and global configuration. Default execution to no sandbox; sandboxing is opt-in.
- For approved delivery, the PM may commit scoped work, push story branches, create/update PRs and
  merge verified code without repeated permission questions. Builders do not perform Git integration.
- Installation, paid external-provider calls and deployment require scope-specific authorization.
- State/evidence validation is deterministic. Model review receipts are attestations, not authentication.
- Keep the skill entry short; load only the reference for the requested operation.
- Runtime tests must not invoke real model services.
- `pm/` is the upstream-compatible source of project progress; `.deliver/` holds execution evidence.
- Do not modify pinned upstream test fixtures to make compatibility tests pass.
