# Isolated identity security tests

Run from this directory: `npm ci --ignore-scripts`, then `npm test`.
Run the Auth adapter tests from the repository root:
`node --test src/lib/posAuth.test.js`.

The default lab uses an in-memory PostgreSQL engine (PGlite) with synthetic users.
It does not accept a database URL, load environment files, call Supabase,
or copy production records. Dependencies are separate from the POS bundle.

Verified here: SQL syntax, function privileges, mapping isolation, disabled
and unlinked identities, role source, and preserving legacy admin IDs.
Auth adapter tests use a fake SDK boundary to exercise local failure paths.

NOT verified by the in-memory tests: real JWT validation, GoTrue/REST integration, production
triggers/default privileges, Auth email delivery, business-table policies,
Storage policies, or backup restoration. The auth.uid function is simulated;
passing these tests is not authorization to deploy or close legacy access.

An additional opt-in `local-auth.test.js` exercises real local Supabase Auth
and REST. It is skipped by default and is not part of `npm test`. See
`server/USERNAME_LOGIN.md` for prerequisites and scope. It only accepts the
isolated CLI project `/private/tmp/skupy-auth-local`, validates loopback port
bindings and container labels, and refuses non-lab schemas. It creates and
cleans up synthetic Auth/admin fixtures; never run it against production.

On 10 September 2026, all 43 in-memory tests and the real Auth/REST test passed.
The latter verifies bound-session login/restore/logout, inactive users, wrong
passwords, RPC privileges, concurrent rate limiting, owner reset, directory
roles, old session denial, concurrent reset locks, and reconciliation of lost
responses after real SQL commits, including delayed begin/finish transitions
that commit after reconciliation. Candidates 001-005 are applied only to the
checksum-matched synthetic lab. It does not test business tables, Storage,
Realtime, recovery email, or authenticated cashier workflows.

For a localhost login preview, run from the repository root:
`SUPABASE_BIN=/path/to/supabase node tools/security-lab/serve-preview.mjs`.
The helper validates the same local CLI project and loopback-bound containers,
loads local keys in memory, and chooses a free localhost port. The service key
stays server-side. It does not provision accounts or modify data. Production
accounts cannot log in to the local lab. Test fixtures are removed after tests,
so no shared demo password is available. See SECURITY_STAGE3.md for scope.

The candidate SQL is deliberately outside supabase/migrations. Execute only
on an isolated Supabase test project after reproducing the real schema and
reviewing privileges. Never run the fixture SQL against a real project.

Production migration must preserve admins.id, use newly provisioned Auth
accounts without exporting old passwords, and explicitly approve each
auth_user_id/admin_id/role mapping. New mappings default to inactive.
