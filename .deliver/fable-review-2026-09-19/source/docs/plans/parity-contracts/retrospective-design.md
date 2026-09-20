# T10 coordinator preparation

Read-only design from the pinned upstream retrospective/reference/template. Implementation and
independent review remain pending T05/T08.

Use completed sprint evidence from the integration branch. The bounded review range is the
parent of the sprint's first real story merge through its last real story merge, using first-parent
history. Preserve exact resolved commits, story contracts/Execution, changed paths/diff and
review evidence in the preparation identity. Missing merge history or unverifiable range is
UNKNOWN, not a fabricated review or success. Tiny/small skip mandatory retro; standard+ picks
the oldest missing completed sprint before the next claim. Completion verification reports
and story-review receipts cannot be inferred merely from a merged status string.

Ask the actual upstream questions:
1. Which finding recurred or consumed a fix round because an unstated convention was missing?
2. Which story Context omitted something its builder had to discover?
3. Which gate, lens or verification step caught nothing and consumed time?

Each answer cites actual sprint evidence or states that evidence is unavailable. Only the user
decides whether a step is removed. Propose earned AGENTS.md additions as a diff, never apply them
as a retrospective side effect. Record only accepted additions as accepted; unapproved proposals
stay proposals. Open block/major cross-story findings must name explicit follow-up stories in
the next sprint, preserving carryover, not silently edit source or waive the findings.

Use integrity review for a bounded small diff; upstream threshold is about 1,500 changed lines.
For a larger sprint use architecture review with full changed-path manifest and an explicitly
narrowed structural diff, never silently truncate. If no meaningful structural selection fits
the bound, report the limitation/UNKNOWN. Native review adapters remain observational and cannot
claim gates they did not execute.

A preparation/record CLI split should keep inspection read-only and bind submitted review/answers
to current evidence before writing only docs/retros/sprint-N.md. Require completed sprint and
unchanged before images, regular files, no overwrite of conflicting records. Existing compatible
retro records are recognized by the shared inspector without pretending imported Markdown has
native receipt authentication. Keep the installed template close to upstream headings and path.
