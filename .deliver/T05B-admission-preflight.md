# Remote adoption admission seam

Read-only implementation mapping by `/root/remote_wiring_map` on 2026-09-13.
This is advisory implementation evidence for the approved T05B contract, not acceptance or a new contract.

Place native pending-remote admission in `current-pm.mjs:claimCurrentPm` before its
existing-Execution resume return and active-story loop, and repeat inside its transaction.
Check `prepareCurrentBinding` too, closing direct runtime start from another checkout.
Key the hold to the common repository and approved integration branch, not the current actor.

Do not put the hold in `assertCurrentPmReady`, `requireExecutable`, or `assertCurrentBinding`.
Remote reconciliation calls `assertRecordSource -> assertSourceRun -> assertCurrentBinding ->
requireExecutable`; a general hold there would prevent completion itself.

Canonical records are checkout-local under
`<record.destination.root>/.deliver/integrations/<record.source.run_id>.json`.
Discover the authoritative integration checkout through the common Git directory and attached
worktree inventory. Bound regular UUID-file reads; reject symlinks/noncanonical paths and
validate destination root/common repository/branch/source identity. Deduplicate canonical paths.
`readIntegrationRecord` validates records without source binding. Discovery must remain read-only
and avoid `withRecord`, provider calls, or adoption. A function-only integration/current-PM import
cycle must have no module-initialization calls or recursive binding validation.

After local fast-forward but before `adoptRemoteCompletion`, merged story bytes do not release
the native hold. The retained completion token remains pending. Only validated adoption releases
it; subsequent legitimate HEAD advances must not reactivate an already completed token.

Wrap current-format status in `pm.mjs` with a native projection from `current-pm.mjs` for remote
proof, local adoption status, retained claim and admission. Preserve `project-state.mjs` upstream
inspection and imported-upstream precedence. Only validated native remote-publication records
create the hold; malformed relevant native evidence yields UNKNOWN, never completion.

Tests should cover different actors, separate source/closure/integration checkouts, direct start,
crashes before/after fast-forward, copied/symlinked/malformed evidence, failed adoption, successful
adoption followed by later commits, and imported merged stories without native remote records.
