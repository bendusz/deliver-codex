# T05B implementation dispatch

Implementation choices within the approved task and frozen remote contracts. This note does not supersede requirements or change task scope, baseline, approval or counters. Architecture approved the dispatch in the native `recovery_contract` thread on 2026-09-13. Worktree: `/Users/ben/code/pm-skill-codex-worktrees/t05b-delivery`. Run: `4fcd23c4-4b06-4a55-89ae-f2686bb3516f`.

The builder owns the task's production, references, skill entry and operation-map paths. The test engineer owns only `tests/remote.test.mjs`, `tests/remote-lifecycle.test.mjs`, `tests/current-roundtrip.test.mjs` and `tests/operations.test.mjs`. No contracts, task packets, run state, baseline, configuration, dependencies or Git integration edits by either worker.

## Shared API shape

All integration exports are synchronous with `(recordArg, options, cwd = process.cwd())`. Every mutation requires `options.expectedRecordHash` and returns `{file,record,hash,result:{operation,state,...}}`. Readiness returns the same read wrapper without mutation. Provider and fetch injection are module API test seams only. CLI commands have no provider, fetch or executable-injection options.

`provider` defaults to the production GitHub adapter. `fetchRemote` defaults to the production Git fetcher and receives `{root,remote,branch,proofRef,expectedRemoteOid}`. Its result cannot substitute for checking the actual fetched ref and commit objects. A unique recorded proof ref and explicit Git argv are required; no tracking configuration writes.

Source publication initially defaults to `origin`. Once the exact remote and repository are bound, later operations retain that identity; an omitted remote uses the retained value and a conflicting explicit remote refuses before provider effects.

## Source publication and evidence

- `publishRemoteSource`: options `remote`, `title`, `body`, `createDraft=false`, `markReady=false`, `provider`.
- `inspectRemoteSourceReadiness`: options `provider`; read-only, including the record.
- `mergeRemoteSource`: options `prNumber`, explicit `method`, `subject`, `body`, `provider`.
- `reconcileRemoteSource`: options `prNumber`, `provider`, `fetchRemote`; external reads/fetch/proof only.
- `prepareRemoteIntegrationEvidence`: explicit `evidenceRoot`.
- `runRemoteIntegrationGate`: `name`.
- `recordRemoteIntegrationReview`: `reviewer`, `receipt`.
- `recordRemoteIntegrationVerification`: `verifier`, `results`.
- `finalizeRemoteIntegrationEvidence`: expected hash only.

Reconciliation retains `source_merge_commit` separately from fetched `verified_integration_commit` M and returns an allocated `evidence_branch: pm/<story>-remote-evidence-<token>`, proof ref and M. PM creates the worktree at that exact named branch/M. Evidence preparation validates the sole exact branch attachment, canonical clean root, ordinary index and protected anchor. Detached checkouts are not supported by this operation. Store its checkout and all receipts in `remote.integration_evidence`; canonical `record.destination.root` remains at the previous local integration HEAD for terminal fast-forward adoption. Do not overwrite local integration/evidence identities.

## Closure and handoff repair

- `prepareRemoteClosureCheckout`: expected hash only; persists and returns token, `pm/<story>-closure-<token>`, and M start commit.
- `adoptRemoteClosureCheckout`: `token`, explicit `closureRoot`; validates the PM-created sole exact clean checkout and captures its anchor.
- `prepareRemoteVerificationReport` / `adoptRemoteVerificationReport`.
- `prepareRemoteStoryClosure` / `adoptRemoteStoryClosure`.
- `prepareRemoteHandoff` / `adoptRemoteHandoff`.
- `publishRemoteClosure`: `remote`, `title`, `body`, `provider`; retains distinct ordinary PR-publish and normal-merge subattempts.
- `reconcileRemoteClosure`: `prNumber`, `provider`, `fetchRemote`; external reads/fetch/proof only.
- `prepareHandoffRepair`: explicit `integrationRoot`, the separate canonical clean repair checkout at latest proved N on a caller-created unique fresh branch; capture its precommit anchor and prepare exact H2.
- `adoptHandoffRepair`: `token`, `commit`; proves H2 before publication.
- `publishRemoteHandoffRepair`: `remote`, `title`, `body`, `provider`.
- `reconcileRemoteHandoffRepair`: `prNumber`, `provider`, `fetchRemote`.
- `prepareRemoteCompletion`: expected hash only; binds previous canonical integration HEAD and proved R/S, returns immutable token and exact fast-forward target.
- `adoptRemoteCompletion`: `token`; verifies actual clean canonical fast-forward and terminal bytes before releasing the native hold.

Artifact prepare options otherwise mirror local operations; artifact adopt options are `token` and `commit`. Keep local behavior intact. Remote contexts require separately validated roots and slots. Do not repurpose the P/E/H closure checkout for H2 preparation. Closure and repair publication may advance their ordinary publish/merge substeps only from explicit proven states; unresolved results remain pending or unknown.

## Durable provider attempts and replay

The optional `record.remote` envelope has `version:'remote-publication-v1'` and separate `source`, `integration_evidence`, `closure`, `handoff_repair` and `completion` fields. Source has publication and merge attempts plus proof. Closure has checkout, artifacts, publication attempts and proof. Preserve the exact source/local integration record meanings.

Attempts have `version:'remote-provider-attempt-v1'`, token, operation, ordinal, exact input and input identity, predecessor record hash, retry, optional supersedes link, and append-only hashed transitions. Transitions are prepared, executing and observed, bind their predecessor and retain exact result identities. Persist executing before calling the provider; reject concurrent execution. Do not place provider effects inside a callback whose record writes occur only after it returns.

Executing records the invocation token, PID, process instance, operation and input identity. PID absence alone never authorizes replay. A lost-process attempt remains `PROVIDER_UNKNOWN` unless read-only reconciliation proves the exact effect, which may then be adopted. `PROVIDER_REPLAYABLE` requires that the same process observed the synchronous call return or throw, its invocation token is inactive and present in a private ended set, and exact provider absence is proved. Persist that evidence before returning the same attempt token to prepared. No caller boolean or process manager is introduced. Pending polls do not spend retries.

Before successful merge proof, proven head/base change may supersede an unmerged attempt with a linked new token. It does not increment publication retry. Only a proved `HANDOFF_BASE_RACE` permits repair-local replacement retries 1 or 2 after initial attempt 0. Preserve every predecessor and all source counters. Ambiguity, a failed poll, or an ordinary failure does not qualify for supersession.

## Adapter and status vocabulary

`createGitHubRemoteAdapter().reconcileMerged(target,{prNumber})` is externally read-only and works after deletion of the remote source branch. It returns `MERGED`, `MERGED_BASE_ADVANCED`, `MERGE_PENDING` for open/queued, or `UNKNOWN` for missing/malformed merge proof. Existing distinct preflight/auth/lookup failures remain distinct and cannot mean absence. Add the new states to the closed adapter vocabulary.

Native domain states include `PUBLISHED`, `READY`, `PENDING`, `FAILED`, `UNKNOWN`, `PROVIDER_UNKNOWN`, `PROVIDER_REPLAYABLE`, `SOURCE_MERGED`, `SOURCE_BASE_ADVANCED`, `LINEAGE_PROVEN`, `LINEAGE_UNPROVEN`, `REMOTE_EVIDENCE_PREPARED`, `REMOTE_EVIDENCE_FINALIZED`, `CLOSURE_CHECKOUT_PREPARED`, `CLOSURE_CHECKOUT_READY`, `REMOTE_CLOSURE_PROVEN`, `HANDOFF_STALE`, `HANDOFF_BASE_RACE`, `HANDOFF_REPAIRED`, `LOCAL_ADOPTION_PENDING` and `COMPLETE`. Retain the exact adapter `provider_state` separately. Artifact states and operation labels are explicit and must match the tested implementation; no unknown state is treated as ready.

`current-pm.mjs` exports read-only `remoteAdmissionStatus(root)` with `version:'remote-admission-status-v1'`, state, blocking, common_repository, integration_branch, story, source_run_id, integration_record, record_hash, remote_terminal_commit, local_head, continuation and diagnostics. Optional identities are null; diagnostics are `{code,message,path?}` entries. States: CLEAR, REMOTE_PENDING, REMOTE_CLOSURE_PROVEN, LOCAL_ADOPTION_PENDING, COMPLETE, UNKNOWN. Only CLEAR and COMPLETE are nonblocking. Discover canonical records across attached worktrees by common repository and approved integration branch. Malformed/ambiguous relevant evidence is UNKNOWN. Proven completion stays COMPLETE after later legitimate commits. `pm status` exposes `remote`; claim and direct-start admission consume the same projection at the preflight seams specified in the existing admission note. Preserve imported-upstream precedence and avoid recursive binding validation.

## CLI dispatch

All commands are in `pm.mjs`, use `--integration FILE --expected-record HASH`, and preserve existing option validation. User operation remains `complete` in the installed operation map.

- `remote-source-publish`: `--remote`, `--title`, `--body-file`, optional `--draft`, `--mark-ready`.
- `remote-source-readiness`.
- `remote-source-merge`: `--pr`, `--method merge|squash|rebase`, `--subject`, `--body-file`.
- `remote-source-reconcile`: `--pr`.
- `remote-evidence-prepare`: `--evidence-root`; gate/review/verify/finalize use local-equivalent `--name`, `--reviewer --receipt`, `--verifier --results` as appropriate.
- `remote-closure-checkout-prepare`; `remote-closure-checkout-adopt --token`, with cwd as the explicit closure root.
- `remote-report-prepare|adopt`, `remote-close-prepare|adopt`, `remote-handoff-prepare|adopt`, with local-equivalent token/commit/next options.
- `remote-closure-publish|reconcile`.
- `remote-handoff-repair-prepare`, with cwd as the explicit repair integrationRoot; `remote-handoff-repair-adopt --token --commit`; `remote-handoff-repair-publish|reconcile`.
- `remote-completion-prepare`; `remote-completion-adopt --token`.

Closure/repair publish commands take remote/title/body-file; reconcile takes PR number. Body-file reads are bounded regular-file reads. No default sandbox, global configuration, dependency, provider installation or paid-call changes are part of T05B.
