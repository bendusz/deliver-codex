# Accepted T09 API preparation

Prepared read-only by benchmark_builder, accepted by coordinator. Implementation remains pending T03-T05.

- `previewMigration(root,{mapping,limits})`: read-only, bounded inventory of integration/open-branch legacy blobs, exact before/after writes/removals/retains, source identities and mapping hash. Status READY/BLOCKED/DRIFT; preview_id binds root/HEAD/object-format/source digests/tracking/dirty state/mapping.
- `applyMigration(root,preview,{expectedPreviewId})`: only READY, all basis/before-images unchanged, journal exact operations without recomputing decisions. Return APPLIED/ALREADY_APPLIED/BLOCKED.
- `inspectMigrationJournal(root,id)` read-only; `recoverMigration(root,id,{action:'resume'|'rollback'})` only if each file equals before or after. Any third state blocks. Journals under `.deliver/migrations/`; retained source evidence under `docs/migration/legacy-evidence.json`.
- Normalize known `in review` alias. Preserve exact criteria. Latest credible evidence determines status/branch, but each counter is MAX of all credible observations. Counter discrepancies alone may retain MAX automatically with a finding; mappings cannot lower budgets. Ambiguous owner/route/status requires explicit mapping.
- Mapping binds preview basis and explicitly resolves actor aliases, missing story metadata/routes, unknown values and reviewed plan edit. No silent override of consistent evidence; record rationale and originals.
- Only a unique bare self actor alias automatically maps to canonical current identity. Preserve teammates and unresolved aliases.
- Merged requires actual reachable integration evidence. PASS alone cannot become merged.
- Preserve unknown bounded raw data with source pointers. Never remove modified/untracked legacy files. Remove only exact clean tracked legacy paths in the preview.
- Compute proposed plan Git blob digest in preview using repository object format; verify after write, then write approval. Preserve approval only with credible original approver/date and tracked regular plan; otherwise pending.
- Write journal before artifacts, then stories/evidence/plan, approval last, exact authorized removals, then applied marker. Fsync/atomic rename where useful; interrupted recovery compares before/after images.
- Current+legacy without migration provenance is DRIFT. Verified completed migration journals/records must recognize deliberately retained dirty/untracked legacy history for clean idempotent reruns.
- Existing `.deliver` receipts/runs remain historical. Explicit fresh binding/baseline required; old PASS cannot transfer.
- CLI preview prints only; explicit apply consumes regular bounded JSON; recover takes resume/rollback. No stdin/FIFO/provider calls or implicit changes.
