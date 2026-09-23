# Release evidence validator

Preparation only, following SECURITY_STAGE3.md and SECURITY_STAGE4.md. This
validates supplied evidence, not production readiness or the truth of reports.
It never deploys, invokes Git, contacts Auth or a network, loads environment
files, executes reports, opens backup artifacts, or writes files.

**Current release remains blocked:** the owner recovery email/configuration and
real production database-plus-Storage backup/restore evidence are still missing.
Passing synthetic validator tests does not resolve those blockers.

## Use

Run from the repository root with Node.js 22 or newer. No dependencies required.

```sh
node --test tools/release/readiness.test.js

node tools/release/readiness.js \
  --evidence /private/path/release-evidence.json \
  --source-revision "$SOURCE_REVISION" \
  --source-sha256 "$SOURCE_SHA256" \
  --build-sha256 "$BUILD_SHA256" \
  --production-environment "$PRODUCTION_ENVIRONMENT" \
  --test-environment "$TEST_ENVIRONMENT" \
  --deployment-project "$DEPLOYMENT_PROJECT"
```

The shell variables above stand for independently established expected values,
not credentials. The CLI does not discover them. Use `--evidence -` for stdin.
Input is read-only JSON, limited to 1 MiB. All flags are required exactly once;
unknown flags, overrides and clock overrides are rejected. JSON output contains
only `evidenceValid` and `blockers`; errors do not echo inputs or private paths.
Exit 0 means the supplied evidence is structurally complete and consistent.
Exit 1 means blocked, including malformed/unreadable input. Nothing is executed
after validation, and exit 0 must not be wired directly to production deployment.

For deterministic in-process use, import `evaluateReadiness(evidence, expected)`.
`expected` has all six release fields below plus an explicit `now` timestamp.
The function performs no I/O, reads no clock, and does not mutate its inputs.
Supply plain JSON data. The CLI obtains `now` from the actual system clock.

## Version 1 envelope

Exactly three top-level fields are accepted: `schemaVersion: 1`, `release`,
and `checks`. Unknown fields at any defined record level are rejected. An
intentionally incomplete, credential-free example that always blocks is:

```json
{"schemaVersion": 1, "release": {}, "checks": {}}
```

`release` must exactly match the independently supplied expectations:

| Field | Requirement |
| --- | --- |
| `sourceRevision` | Full 40- or 64-character lowercase hexadecimal revision; not all zero |
| `sourceSha256` | 64-character lowercase SHA-256; not all zero |
| `buildSha256` | 64-character lowercase SHA-256; not all zero |
| `productionEnvironment` | Stable production project/environment identifier |
| `testEnvironment` | Stable isolated test environment identifier, different from production |
| `deploymentProject` | Exact deployment project identifier |

Identifiers use `[a-z0-9][a-z0-9_-]{0,99}`; they are not URLs or connection strings.
Use the same canonical identifiers throughout every report and the release.
`sourceSha256` identifies the complete immutable source artifact including dirty
changes, lockfiles, server code and candidate SQL. A commit alone is insufficient
in this dirty worktree. `buildSha256` identifies the exact tested build artifact.
Keep a deterministic packaging definition with the reports; exclude secrets.
The validator checks supplied hash syntax and equality, not artifact bytes.

## Common evidence fields

`checks` contains exactly these eight gates: `fullTests`, `businessAuthStorage`,
`workflows`, `backup`, `restore`, `ownerRecovery`, `identityMapping`,
`deploymentAccess`. Missing gates block; `true` or a manual approval flag cannot
substitute for a record. Each record requires these common fields plus its
gate-specific fields below:

- `sourceRevision`, `sourceSha256`, `buildSha256`: exact expected values.
- `environment`: test environment for fullTests/businessAuthStorage/workflows/
  restore; production environment for backup/ownerRecovery/identityMapping/
  deploymentAccess. The latter are evidence about production, not permission to
  touch it. Restore separately identifies its production source.
- `completedAt`: canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, valid calendar date,
  no later than evaluation time and at most 24 hours old (inclusive).
- `reportSha256`: SHA-256 of the retained report, same format as buildSha256.
- `result`: exactly `"passed"`, supported by the report, never a boolean.

All evidence has the same fixed 24-hour freshness policy. Approval and recovery
verification timestamps must also be fresh and no later than their record's
completion. Do not relabel old results with new timestamps or build hashes.

Where `cases` is required, it is an array of exactly shaped records:
`{"name":"unit","passed":12,"failed":0,"skipped":0}`. Every required name must
appear once, with a positive safe-integer executed-pass count and zero failures
and skips. Additional named cases are permitted but must also pass; duplicate
names, omitted required cases and unexecuted suites block. Count individual
checks/observations for workflow or access reports, not only unit tests. Include
all executed cases, including failures; do not cherry-pick passing results.

## Gate-specific fields

| Gate | Additional fields and required case names |
| --- | --- |
| `fullTests` | `cases`: unit, sql, real-local-auth |
| `businessAuthStorage` | `cases`: full-schema, anon-denial, unmapped-denial, inactive-denial, reset-denial, role-forgery, cross-staff, cross-book, credential-isolation, owner-only-config, rpc, triggers, storage |
| `workflows` | `cases`: login, staff-switch, session-cleanup, custom-order, dp, settlement, cancellation, invoice, owner-accounting, admin-accounting, storage, desktop, mobile |
| `backup` | Snapshot fields below and `provenance: "production-snapshot"` |
| `restore` | Snapshot fields, `sourceEnvironment`, `target`, and `cases`: empty-target, database, storage, checksums, row-counts, object-counts, application-readback |
| `ownerRecovery` | `ownerAuthUserId`, `email`, `verifiedAt`, and `cases`: email-delivery, recovery-completed, owner-login |
| `identityMapping` | `mappingSha256`, `approvedBy`, `approvedAt`, `mappings` |
| `deploymentAccess` | `mode: "read-only"`, `project`, and `cases`: repository-read, repository-push, deployment-read, deployment-create, environment-read |

Full-schema reports must cover the actual catalog, grants, policies, RPCs and
triggers, not just the stage-3 minimal schema. Real-local-auth must use real
Auth/REST rather than simulated JWT identity. Workflow/Storage reports must
exercise the exact candidate build in the isolated environment. Case labels
alone do not establish that these tests actually happened.

### Backup and restore

Both records require `manifestSha256`, `databaseSha256`,
`storageInventorySha256`, `databaseBytes`, `storageObjects`, `storageBytes`,
and `buckets`. Database bytes must be a positive safe integer; Storage counters
must be nonnegative safe integers. `buckets` must contain exactly products,
logos and invoices, with no duplicates. Empty Storage is allowed only with an
explicit inventory digest, all buckets and zero object/byte counts. Inventory
reports must enumerate every object, or explicitly establish empty buckets.

Restore must match all backup digests and counters, finish no earlier than the
backup, and use `sourceEnvironment` equal to the expected production environment.
`target` is exactly `{"host":"127.0.0.1","database":"skupy_restore_12345678"}`
in a synthetic example; the database suffix must be 8-32 lowercase hex digits.
The empty-target case must establish an empty lab before restoration. This
validator does not contact that target or perform a restore.

The existing backup bundle tool labels its scope
`supplied-database-and-storage-artifacts`. That manifest and its checksum alone
cannot satisfy this gate. Separate evidence must establish the real production
snapshot's origin and complete inventory, verified bundle bytes, and successful
database AND Storage restoration. A synthetic round trip, database-only backup,
or hand-changing the provenance label is not production evidence.

### Owner, mappings and deployment access

`mappings` is a nonempty array of exactly `{authUserId, adminId, role}` records.
IDs must be canonical lowercase UUIDs (versions 1-8, RFC variant); both columns
must be unique. Roles are owner/admin/staff. `approvedBy` must be the Auth UUID
of a mapped owner; `approvedAt` is a fresh timestamp. `mappingSha256` identifies
the retained approved mapping artifact. The supplier must include every intended
account; the validator cannot discover omitted staff from the live directory.

`ownerRecovery.ownerAuthUserId` must match that approving mapped owner. `email`
must be a nonempty conventional ASCII dot-atom email address with bounded local
and domain-label lengths. Quoted/internationalized addresses are conservatively
rejected. `verifiedAt` is a fresh timestamp, separate from the completion time.
Actual delivery, completed recovery and subsequent owner login require evidence;
merely supplying a syntactically valid email address does not suffice.

Deployment `project` must match the expected deploymentProject. Required access
cases describe permissions established through read-only inspection for the
intended release actor. Do not test push/deploy rights by performing writes.
Unknown/failed access checks block. This tool performs no access inspection.

## Trust boundary and limitations

All fixtures in readiness.test.js are synthetic, including its passing fixture,
email, UUIDs, hashes and claimed production provenance. No fixture is a release
record and no credentials are embedded. The tests validate this validator only.

Supply evidence and independent expectations from trusted review/build processes.
Keep actual reports, owner email and mapping artifacts private and outside source
control. Retain inspectable report artifacts for every report hash. Before any
release, independently authenticate their producers, verify the artifact bytes,
scope, production origin and approvals, and check that deployed configuration,
actual schema and source have not changed. Hash equality cannot prove authorship,
coverage, environment identity, completeness, available permissions, a reachable
email or successful restoration. This tool does not verify signatures or attest
to any of those facts. Consistently fabricated JSON can pass.

Version 1 is a necessary evidence-consistency check, never deployment approval.
It does not import test results automatically, execute embedded commands, collect
production data, provide a bypass, or automate cutover/rollback. Missing owner
recovery and real production backup/restore remain blocked until genuine evidence
exists; no synthetic example or local test result removes that requirement.
