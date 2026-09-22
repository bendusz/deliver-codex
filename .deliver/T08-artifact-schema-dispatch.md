# T08 artifact receipt version

Coordinator choice before the T08 baseline: use integer `schema_version: 1` for
the dedicated pre-claim artifact review schema already specified in
`docs/plans/parity-contracts/architecture-state.md`. Reject missing or other
versions. This pins the unspecified representation and adds no new policy.

Retain the exact fields, unique semantic item coverage, live analysis and content
identity binding, canonical normalization, finding rules and persisted provenance
from the existing design. This receipt is an attestation, not authentication.
No implementation or T08 start is recorded by this dispatch note.
