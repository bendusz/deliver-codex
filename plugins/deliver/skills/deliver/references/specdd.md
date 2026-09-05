# Optional SpecDD

Use contracts when module boundaries or repeated handoffs need them. Do not enable SpecDD
merely because a project is large. Existing typed interfaces, API descriptions and ADRs remain
authoritative where they already express the contract well.

## Contract phase

After plan approval and before starting a code task, ask `deliver-spec-architect` to author only
the explicitly authorized root and affected module contracts. Read the active upstream
`.specdd/bootstrap.md` chain first. Never overwrite an installed bootstrap with our sample.
`assets/specdd/` provides illustrative current-dialect templates, not an upstream installer.
No network, `npx`, or automatic SpecDD installation is required.

Use `Spec: name`, inline `Platform: stack`, explicit paths and meaningful local invariants.
`./` and `../` are relative to the spec directory; `/` is relative to the selected content root,
not the operating system root. Unprefixed filenames are prose and grant no path authority.
Owns is exclusive ownership; Can modify adds non-owning write permission. Link FR/AC IDs
instead of copying the product specification into every contract.

## Inspect and freeze

```text
node <skill-directory>/scripts/specdd.mjs inspect --root <project-root> --spec project.sdd --spec src/parser/parser.sdd
```

Supply the governing root, directory and local specs explicitly, including owner contracts for
Can modify paths. A directory write scope must include existing contracts within that directory,
including nested contracts. Leaf specs inherit Must/Must not from their governing directory chain,
not from sibling leaf specs. The checker does not discover the whole repository. It checks a conservative
literal-path subset, ownership collisions and supported structural rules. It is not the official
full SpecDD validator and does not prove semantic Must/Done when statements.

Globs are not supported as executable authority by this release. Express the needed write
scope with bounded literal files/directories. Missing files may be intended new artifacts;
missing contracts or ambiguous authority are blockers. A path escaping the project, including
through a symlink, cannot grant authority.

Before implementation, include the exact governing spec paths in the task's `specs`. Keep task
touches within the normalized Owns/Can modify union. Freeze the contracts and allowed scope at
task start; changing a spec cannot authorize its own implementation. A necessary contract change
goes through a separate approved contract phase and a reconciled new code-task baseline.
Directory write permission does not permit creating or editing `.sdd` files or `.specdd/`
instructions during a contract-aware code task, including ignored files.

Builders read the contract chain. Reviewers check invariants/interfaces and inspect contract
changes. Verifiers check covered Done when statements against actual code and evidence.

The official SpecDD Codex plugin can supply richer authoring/resolution skills when installed.
It is optional and not automatically installed or imported. Compatibility is based on the
[language reference](https://specdd.ai/language-reference/) reviewed on 2026-09-05.
