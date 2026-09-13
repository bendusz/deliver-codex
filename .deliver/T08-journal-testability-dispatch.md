# T08 journal representation and interruption tests

Coordinator choices before T08 baseline, within the approved operation-specific
current journal recovery work. Production remains unstarted.

Use `format: "current"`, `version: "current-pm-transaction-v2"`, and an
`operation` discriminator with exactly `init`, `approve`, `revoke`, or `claim`.
Retain the existing exact path/before/after write images. Other operation-specific
context must be derived from the live producer and checked against the approved
contract. Existing unversioned current journals are legacy and require unique legal
operation inference. Unknown explicit versions or operations refuse.

Tests should capture genuine producer journals rather than hand-invent the full
private shape. No new production interruption API is needed. The current publisher
atomically renames the journal before renaming any target, and removes the journal
after applying all targets. A test-local, exact-destination interception of
`fs.renameSync` can throw before the first target rename, retaining the real journal
and original target bytes. An exact-journal-path interception of `fs.unlinkSync`
can retain the real already-applied journal. Restore the filesystem function in
`finally`; never intercept unrelated files, run these patches concurrently, or leave
an altered builtin for another test. Recovery can then run in a fresh process.

These are deterministic filesystem failure boundaries, not production bypasses.
Assertions must cover all target bytes and unchanged contract/counters as well as
journal retention. Typed malformed cases start from captured genuine journals;
legacy cases remove only the new discriminator fields before testing inference.
The implementation may retain additional required operation context, and tests must
not presume that deleting such context is a valid legacy operation.
