# Specification

Capture what users need and why in `docs/spec.md`, separate from technical delivery design.

**Enter:** discovery has agreed the problem and direction, or an existing spec needs revision.

**Leave:** the spec contains stable identifiers and no blocking `[NEEDS CLARIFICATION]` marker.

## Write the spec

Create `docs/spec.md` from `assets/templates/spec.md.template`, or update the existing file in
place. Preserve user-provided material and every existing identifier. The spec owns product intent:
user stories, functional requirements, acceptance criteria, edge cases and success measures. Put
architecture, stack and task ordering in the plan.

Use these stable forms and never renumber them:

- `US-001` for narrative user needs.
- `FR-001` for testable functional requirements.
- `AC-001` for observable acceptance criteria. Prefer `WHEN ... THE SYSTEM SHALL ...` for behavior.
- `SM-001` for measurable outcomes; mark a non-buildable business measure as such.

Plans and stories trace to `FR-` and `AC-` identifiers. Existing explicit user constraints override
template defaults.

## Clarify unknowns

Mark an unknown inline as `[NEEDS CLARIFICATION: <question>]`. The `clarify` operation asks one
question at a time, up to five in one session by default. Give realistic options and a recommendation
when useful. After each answer, immediately update the authoritative spec section and Clarifications
log, then remove the matching marker. The user may ask for a different question style or limit.

Do not start planning while a blocking marker remains. A non-blocking unknown may become an explicit
assumption or risk only with the user's agreement.

## Output

Write `docs/spec.md`. Present its unresolved marker count and continue with `planning.md` only when
the exit rule holds.
