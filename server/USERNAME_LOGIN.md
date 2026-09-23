# Username login preparation (10 September 2026)

## Scope

`api/auth/login.js` is a new server endpoint, disabled by default. It is allowed
only in Vercel preview, on an explicitly selected nonproduction Supabase test
project. It rejects the known SKUPY production project and production origin.
`src/lib/posAuth.js` is wired to the preview-only verified app boundary. Legacy
production access remains unchanged. Owner-driven staff reset is implemented
only for isolated preview/local testing; production cutover is not complete.

## Flow

1. Browser posts username/password as JSON to same-origin `/api/auth/login`.
2. Server validates Origin, method, input size, and trusted Vercel IP header.
3. Service-only RPC consumes PostgreSQL rate limits before account lookup.
4. Service-only mapping lookup obtains the Auth user ID from private data.
5. Server gets the account's internal Auth email and verifies the password on
   a fresh anon-key Auth client, never on its privileged service client.
6. getUser and pos_current_profile must agree with the expected mapped ID.
   Only access/refresh tokens are returned, with no-store headers. JWTs may
   contain the internal Auth email; it is not a secrecy boundary.
7. Browser sets the Auth session, verifies getUser/profile, and returns a
   credential-free POS profile. Mutating Auth operations are serialized.

Unknown or inactive usernames follow dummy directory/Auth processing and the
same public failure body, with a 1.5-second minimum plus small random delay.
This reduces timing differences; it does not prove network-level constant time.
There is no fallback to legacy password queries and no public email lookup.

## Limits

SQL candidate `supabase/security-stage2/002_username_login.sql` follows 001.
Each 15-minute fixed window allows 10 attempts per username, 60 per IP, and
1000 IP-admitted requests globally. Already-blocked IP requests do not consume
the shared admission budget. Counters are atomically locked in global-first
order. Keys contain server-keyed HMACs, not raw usernames/IPs. Rows older than
one day are cleaned during successful admissions; they may persist while idle.

Distributed abuse, slow requests, and requests to Auth directly still need
platform rate limits and monitoring. Per-account throttling can temporarily
block a targeted account; do not describe these limits as complete DDoS defense.

## Preview configuration (server only)

- POS_USERNAME_LOGIN_ENABLED=true
- VERCEL_ENV=preview (provided by Vercel)
- POS_AUTH_TEST_PROJECT_REF: exact test project reference, not production
- SUPABASE_URL: exact https://<test-reference>.supabase.co URL
- SUPABASE_ANON_KEY: public key for that test project
- SUPABASE_SERVICE_ROLE_KEY: service key for the same test project
- POS_LOGIN_HMAC_SECRET: randomly generated secret, at least 32 characters
- POS_APP_ORIGIN: exact HTTPS origin of the chosen preview, no path/wildcard

Never prefix server secrets with VITE_, put them in source, or reuse production
credentials in this test setup. No environment values have been configured or
uploaded by this implementation. For local integration tests the handler is
instantiated directly; the preview guard is not weakened for localhost.

## Account provisioning before cutover

Keep admins.id. Create individual Auth identities with new passwords; never
copy old passwords or share one staff account. For staff without email, use a
unique internal Auth alias provisioned by the server, with owner-assisted
recovery. Approve login_username/admin_id/auth_user_id/role mappings explicitly.
The private login_username is unique, lowercase ASCII, 1-64 characters with
letters, digits, dot, underscore or hyphen, starting with a letter or digit.
Audit real usernames for compatibility before migrating; do not auto-rename.

Session/cache invalidation, cross-tab events, stale requests and token cleanup
failures now have preview integration and tests. Owner recovery, provisioning,
replacement account CRUD, and business RLS/Storage/RPCs remain outside this
candidate. See SECURITY_STAGE3.md for current blockers and verified scope.

## Staff password recovery

Candidates 003-005 apply after 001-002. The owner-only directory RPC reads
trusted private roles and the verified current session, never legacy roles.
The same-origin `/api/auth/reset-staff-password` endpoint requires a bearer
session and the owner's current password, then obtains a service-only target
lock. It excludes owners, inactive mappings and unmapped targets. New passwords
require 12 Unicode code points minimum and 72 UTF-8 bytes maximum. It updates
Auth only after locking and clears the lock only after confirmed Auth success.
Old and during-reset sessions remain invalid after completion. Private audit
records contain operation IDs and actor/target IDs, never credentials.

Lost begin/finish responses are reconciled through the service-only status RPC.
Nonterminal not-started/pending snapshots cannot rule out a remote transition
committing later and therefore remain uncertain after transport failure.
An unconfirmed Auth update leaves the staff mapping locked for operator recovery;
an unavailable status returns an uncertain outcome, not success or a definite
lock. There is no automatic unlock. Recovery shares login admission limits.
The new server routes cannot be enabled in production by their current guard.

Client preview also requires VITE_POS_AUTH_MODE=preview,
VITE_POS_AUTH_TEST_PROJECT_REF, VITE_SUPABASE_URL and the test project's public
VITE_SUPABASE_ANON_KEY. Invalid requested mode blocks rather than falling back.
Every business client is bound to its verified Auth user and session ID;
logout invalidates requests and remounts providers/stores for the next session.

## Verification commands

From repository root:
`node --test tests/*.test.js src/lib/*.test.js src/utils/*.test.js`

From tools/security-lab after npm ci --ignore-scripts:
`npm test`

Optional real Auth/REST test: tools/security-lab/local-auth.test.js is skipped
unless SKUPY_RUN_LOCAL_AUTH_TESTS=1. It requires the isolated CLI project at
`/private/tmp/skupy-auth-local`, API bound to 127.0.0.1:54321, a correctly
labeled Docker database, and SUPABASE_BIN pointing to the installed CLI.
It refuses an existing public schema without its exact lab manifest. Exact
previous lab manifests can be upgraded through candidate 005; any other change
requires rebuilding that isolated lab. It creates and removes
only synthetic users and their fixture rows. No production URL is accepted.

## Verified result (10 September 2026)

120 JavaScript tests, 43 in-memory SQL tests, and 1 real localhost Auth/REST
integration test passed. The integration test includes 20 concurrent limiter
calls with exactly 10 admissions, bound-session login/restore/logout, inactive
mapping, incorrect password, anonymous RPC denial, username exhaustion, owner
staff reset, trusted-role directory, one winner of concurrent reset attempts,
old-session denial, lost committed RPC response reconciliation, and delayed
remote begin/finish commits after reconciliation. Synthetic
Auth users and admin fixtures are removed in test cleanup. Vite build passed
on an isolated repository copy without production environment configuration.
Independent review results are tracked in SECURITY_STAGE3.md. Browser checks
cover only the login screen and invalid credentials, not authenticated cashier
workflows. Results do not cover full business schema, Storage, Realtime, owner
recovery, or production deployment. Nothing has been deployed.

## References

- https://vercel.com/docs/functions/runtimes/node-js
- https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for
- https://supabase.com/docs/reference/javascript/auth-signinwithpassword
- https://supabase.com/docs/reference/javascript/auth-getuser
