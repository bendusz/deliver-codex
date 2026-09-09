# Decomposition

Turn an approved plan into self-contained, build-ready story files.

**Enter:** the plan approval is current and any required SpecDD contracts exist.

**Leave:** each planned story has a ready file, dependencies are valid, write scopes do not conflict,
and applicable blocking analysis findings are resolved.

## Write stories

Create `docs/stories/S<sprint>-<n>-<slug>.md` from
`assets/templates/story.md.template`. Preserve the plan's story IDs and its `FR-` and `AC-`
coverage. Each story must give a cold builder:

- one clear goal and explicit out-of-scope work;
- the exact source paths, symbols and conventions it needs;
- observable acceptance checkboxes, with their text authoritative in this story;
- a real verification command;
- dependency, risk, review-lens and SpecDD declarations;
- a first-12-lines `pm-meta` JSON comment with exactly `builder` and `touches`.

`touches` contains unique, bounded, repository-relative file or directory roots. It contains no
globs, traversal, placeholders or whole-repository grant. Include implementation and test paths.
Choose `codex-builder`, `expert-builder` or `auto` deliberately. `code-integrity-reviewer` is always
required; add architecture or security review when the declared risk needs it.

Do not add an `## Execution` section or `pm-exec` block during decomposition. Claiming the story
adds both later. Decomposition does not claim, dispatch or implement a story.

## Ordering and readiness

Dependencies must exist and point forward from foundations to dependent work. Mark a story parallel
safe only when its dependencies and `touches` permit isolated work. If scope is not yet bounded, the
story is not ready.

Show the sprint-to-story map. At scales that require analysis, check coverage, dependency cycles,
scope overlap and review-lens fit after story creation. Story readiness is a prerequisite to claim,
not a second plan sign-off.
