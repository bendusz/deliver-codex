# Shipping a verified current story

Use this operation after the source runtime has adopted candidate C in `in-review`, collected
current gates, review and a verifier distinct from both builder and reviewer, then finished.
`finish` keeps the shared claim active. Only the integration sequence below records `merged`.

The PM has standing authority for the scoped Git commands in an approved delivery. Run them
without another user checkpoint. Builders and reviewers do not merge or create closure commits.
The local protocol never changes the finished source run or commits `.deliver` receipts.

Let `<pm>` be this skill's `scripts/pm.mjs`. Run the following from a clean checkout of the
approved integration branch. Preserve the `file`, `hash`, and stage `token` returned as JSON.
Every later mutation takes the latest returned hash through `--expected-record`.

```text
node <pm> integrate-prepare --run <source-run-file> [--verification-report]
git merge --no-ff --no-edit <record.source.candidate>
node <pm> integrate-adopt --integration <file> --expected-record <hash> --token <record.integration.token> --commit "$(git rev-parse HEAD)"

node <pm> integrate-gate --integration <file> --expected-record <hash> --name <each-declared-gate>
node <pm> integrate-review --integration <file> --expected-record <hash> --reviewer <id> --receipt <json>
node <pm> integrate-verify --integration <file> --expected-record <hash> --verifier <id> --results <json>
node <pm> integrate-finalize --integration <file> --expected-record <hash>
```

Inspect `record.integration.status` before running Git. `prepared` supplies the merge token and
expected tree. `failed` records the real I/C merge-tree attempt, Git version, exact arguments,
exit and bounded log hashes without inventing M; do not run the merge. That record is the input
to the separate source-correction operation.

The runtime always executes every declared gate again at actual integration M. A clean no-ff
composition with an identical bound C/M manifest may reuse C review and verification. Use the
integration review and verification commands when evidence needs refreshing. They bind only M
and do not call or rewrite the finished source run. A FAIL or unresolved block or major finding
stays in the integration record and needs the explicit source-correction workflow when it concerns
code. If committed C, its certified source snapshot and M differ only in bound implementation
inputs, both fresh M review and fresh distinct verification are mandatory. Plan, approval, story
contract or task-scope drift requires replanning. Missing or stale evidence is never treated as PASS.
Initialized submodules inside the bound scope must be checked out at M's recorded gitlink. Their
committed bytes, index flags and protected Git metadata are checked recursively before adoption
and every integration evidence step.

Finalization freezes a versioned identity over M and its tree, the bound snapshot and manifest,
the exact gate receipts and durable logs, effective review and verification, and the reporting
policy. A gate's stored environment hash records the environment that actually ran it; a later
terminal does not replace that provenance. Once any P, E or H preparation or commit exists,
gate, review and verification refreshes are refused. Repeating the identical finalization is a
read-only resume.

Records produced before the frozen identity existed are never upgraded during inspection. When
the CLI reports `LEGACY_FINALIZATION_RECONCILE_REQUIRED`, inspect the retained receipts and
artifact proof, then run the explicit hash-bound repair:

```text
node <pm> integrate-reconcile --integration <file> --expected-record <hash>
```

The repair succeeds only when retained receipts, logs and Git artifact proofs establish one exact
finalization. It archives the complete prior record. Missing, contradictory or multiple credible
finalizations leave the record unchanged and require manual evidence recovery.

Structured review receipts may include:

```json
{
  "status": "PASS",
  "findings": [],
  "panel": {
    "snapshot_hash": "<integration snapshot SHA-256>",
    "members": [
      {
        "lens": "code-integrity-reviewer",
        "reviewer": "<identity>",
        "verdict": "PASS",
        "snapshot_hash": "<same SHA-256>",
        "findings": []
      }
    ]
  }
}
```

The parser derives aggregate findings from member receipts and retains `CONCERNS` plus minor
findings. Large reports require the story's declared lenses and `code-integrity-reviewer`.
Regulated reports also require `security-auditor`.

Large and regulated projects require reporting commit P. Standard projects include P only when
`--verification-report` was selected during integration preparation. The choice stays fixed for
that integration. Tiny and small projects skip P.

```text
node <pm> report-prepare --integration <file> --expected-record <hash>
git add -- <each returned report path>
git commit -m "Verify <story-id> integration"
node <pm> report-adopt --integration <file> --expected-record <hash> --token <token> --commit "$(git rev-parse HEAD)"
```

P contains only `docs/verification/<story-id>.md` and
`docs/checklists/verification-<story-id>.md`. It identifies C, M, the bound manifest and immutable
receipt identities. It cannot name its own commit. The renderer keeps source and effective panel
findings, flattens multiline evidence and escapes Markdown control characters before producing
tables or checked evidence rows.

Next create story-only closure E, then handoff-only H:

```text
node <pm> close-prepare --integration <file> --expected-record <hash>
git add -- <returned story path>
git commit -m "Close <story-id>"
node <pm> close-adopt --integration <file> --expected-record <hash> --token <token> --commit "$(git rev-parse HEAD)"

node <pm> handoff-prepare --integration <file> --expected-record <hash> --next "<next action>"
git add -- <returned handoff path>
git commit -m "Handoff after <story-id>"
node <pm> handoff-adopt --integration <file> --expected-record <hash> --token <token> --commit "$(git rev-parse HEAD)"
```

E changes only the story's final Execution section to `merged`, preserves ownership and counters,
and records M. H writes `docs/handoff/<actor-id>.md` with `BASE_COMMIT: E`; its own commit is H.
H lists unresolved findings retained from source C and the effective integration review,
including minor concerns. A fresh M review cannot silently erase an unresolved source concern.
The upstream reader therefore treats the handoff as current when every commit after E changes
only that handoff file.

Each preparation persists exact parents, paths and bytes before a PM Git command. Repeating a
prepare after interruption completes only its recorded before or after images. Adoption accepts
one direct child with the exact prepared diff and retains its parent, tree, mode, blob and
before/after proof. Later stages revalidate the entire adopted M/P/E/H chain. Any third-state file,
extra path, changed branch, tree, manifest, log or record hash blocks without consuming the
preparation. Integration records live only at the canonical per-run path under
`.deliver/integrations`.
