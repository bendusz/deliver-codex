# SpecDD bootstrap

`.sdd` files are source-adjacent contracts. A spec beside a source file with the same basename
describes that file. A directory spec is `<directory>/<directory>.sdd` or a parent-held
`<directory>.sdd`. Parent context is read before local context, and both apply.

Before changing code, resolve the supplied spec chain and read it. Stay inside explicit `Owns` paths
and the editable union of `Owns` and `Can modify`. Keep every `Must`, `Must not`, and `Exposes`
statement true. A missing spec is not permission.

Current SpecDD path rules matter here:

- `./` and `../` resolve from the directory containing the current `.sdd` file.
- `/` resolves from the selected content root.
- Unprefixed names and prose are text, not paths.
- `Platform` is inline-only, for example `Platform: Node.js 22`.

Deliver checks literal explicit paths. It reports globs for review and does not use them to enlarge an
edit scope. Globs in `Owns` or `Can modify` block enforcement; globs used only for context are
warnings. `.sdd` files cannot become owned or editable paths. Inspection reads a snapshot and never
edits `.sdd` files or initializes a project.
