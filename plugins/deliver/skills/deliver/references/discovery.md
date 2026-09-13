# Discovery

Agree the problem, users, success measures and solution direction before writing a specification
or plan.

**Enter:** the user has a request and the project has neither `docs/spec.md` nor `docs/plan.md`.

**Leave:** the user and PM agree on the problem and direction, and any unknown that would block a
specification has an answer.

## Method

- Build on the user's existing brief. Ask only for decisions that change intent or scope.
- Ask one question at a time. When realistic alternatives exist, give two or three choices, their
  trade-offs and a recommendation.
- Cover users, value, must-haves, constraints and observable success.
- Record unresolved details as `[NEEDS CLARIFICATION: <question>]`; never guess.
- Use a bounded read-only explorer for a large existing codebase and a researcher for an external
  unknown. Bring back a short answer tied to source paths or citations.

## Output

Carry a short problem statement and the agreed direction into `docs/spec.md`. A `tiny` project may
carry them directly into `docs/plan.md` when the user agrees that a separate spec adds no value.
Discovery itself does not write implementation files or claim stories.

Continue with `specification.md`, or `planning.md` for the agreed `tiny` exception.
