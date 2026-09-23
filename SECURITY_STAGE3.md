# Security completion design and execution ledger

Approved direction: owner-managed staff password recovery, username login,
server-verified roles, cashier lifecycle cleanup, tested access controls, then
automatic deployment only after the production cutover gates pass.

## Design

Keep the existing admin IDs and three roles. Owner manages accounts; admin
retains existing Accounting access; staff is scoped to its orders and customer
PIC assignments. Never use legacy profile storage or admins.role as authority.

Use the existing Supabase Auth username endpoint. Password management runs
server-side, requires a verified active owner and current owner password, and
cannot reset another owner. New passwords must contain at least 12 Unicode
code points and at most 72 UTF-8 bytes, matching the Auth password limit. No
passwords or tokens in audit records or logs. Before reset, lock the target
mapping and invalidate its existing sessions; unlock only after Auth confirms
the password update. Ambiguous failures leave the account locked for explicit
recovery, never claim success. Lost SQL responses are reconciled through a
service-only operation audit before reporting success or a definite lock.
The existing owner is never a staff-reset target. The reset directory derives
roles from private mappings, not legacy admins.role, and excludes owners.

The authenticated app mounts only after verified Auth/profile validation.
Logout immediately unmounts business UI, aborts pending data requests, stops
subscriptions, and resets shared category caches. A new login remounts a fresh
store, including confirmation dialogs and toasts. Bind each data client to its
verified Auth user and session ID so a token switch cannot authorize old UI
actions under a new account. Session storage is the default; remember-me is
optional. Revalidate on Auth events, tab focus and a 60-second timer. Fail closed
when verification or cleanup fails. Client cleanup does not replace server RLS.

All new authentication remains opt-in for isolated preview until the complete
database/Storage policy set, identity provisioning, owner recovery, backups,
restore and cashier workflows are verified. Production deployment must not
silently enable the new mode or close anonymous access before that point.

## Execution plan

- [x] Recovery SQL: add session invalidation and service-only reset operations;
  test active owner, staff denial, invalid target, concurrent lock, failure state,
  old session denial, fresh session acceptance, and private audit privileges.
- [x] Recovery HTTP: test first, implement bearer/profile/current-password
  verification, strict method/origin/input handling, rate limits, generic errors,
  Auth update and SQL completion. Keep route preview-only.
- [x] Client lifecycle implementation: test session controller and abort boundary first; mount
  business UI only after verification, clear logout state, reset category cache,
  remove legacy credential operations from secure mode, integrate reset UI.
- [x] Run existing tests, isolated SQL/Auth tests, build and login browser checks.
- [x] Complete independent final SQL/HTTP re-review. The delayed-transition
  finding was reproduced, fixed, and re-reviewed without further findings in
  that focused scope. This is not a review of all production authorization.
- [ ] Exercise full authenticated cashier/Accounting UI, confirmation unmount,
  Storage and Realtime in a schema-complete isolated environment.
- [ ] Audit final business/Storage/RPC policies against real schema, prepare
  backup/restore and identity provisioning, verify owner recovery, then deploy.

## Production gates

Owner recovery email has not been provided. No live Auth accounts have been
provisioned. Full business RLS and Storage changes have not passed staging.
The final policy set for 41 tables and business RPCs is not implemented here.
Database and Storage restoration have not been verified. Secure mode deliberately
disables legacy account creation/edit/delete and own-password forms; replacement
account lifecycle and owner recovery workflows remain necessary before cutover.
Do not bypass these gates because deployment is requested.

No commit, push, remote environment configuration, production SQL, account
provisioning, production password change or deployment was performed. A Vercel
project page was inspected read-only but its data failed to load. Existing Git
credentials previously lacked repository push permission; no blind retry.
Final browser access was unavailable because the Mac was locked. Unlocking
the Mac alone does not satisfy the remaining production cutover gates.

## Verification

Fresh verification on 10 September 2026:

- 120 JavaScript tests passed with `node --test tests/*.test.js src/lib/*.test.js src/utils/*.test.js`.
- 43 PGlite tests passed in the isolated repository copy. Includes candidates
  001-005, private roles, session cutoffs, reset audit, pending locks, operation
  status reconciliation and owner-only reset directory. Earlier SQL candidates
  were not rewritten to implement later changes.
- 1 real local Supabase Auth/REST integration test passed in 27.6 seconds using
  synthetic accounts and candidate SQL 001-005. It verifies bound-session
  login/restore/logout, wrong-password/inactive denial, private-role directory,
  owner current-password proof, staff reset denial, old-session denial, fresh
  login after reset, lost committed RPC responses, delayed begin/finish commits
  after status reconciliation, one winner of 8 simultaneous
  reset attempts, and exactly 10 admitted calls from 20 concurrent limiter calls.
  Synthetic accounts and profile rows were removed by test cleanup.
- Build passed in 4.85 seconds in `/private/tmp/skupy-security-stage2`, without
  production environment files. `git diff --check` passed.
- Browser login inspected at desktop 1280x720 and mobile 390x844: form fits,
  remember-me unchecked, no shared default password hint, no business screen
  before login, wrong synthetic credentials show generic denial. Viewport and
  form restored. Full authenticated business workflows were not exercised.
- Review-driven fixes include matching Auth's 72-byte password limit, reconciling
  committed SQL with lost HTTP responses, binding data to verified session IDs,
  cancelling old confirmations/category callbacks, and trusted staff directory.
  Final review reproduced a pending/not-started snapshot racing a delayed SQL
  transition: nonterminal snapshots now remain uncertain. Browser transport loss
  after dispatch also reports uncertainty, not a definitely failed reset.

Local login preview: `http://127.0.0.1:55017/` while the preview server is running.
It uses only loopback Supabase and synthetic lab schema. Production credentials
will not work there. It is not a deployed or schema-complete POS staging system.
Use `tools/security-lab/serve-preview.mjs` to start another local preview; it
chooses an available port. It does not create demo accounts or modify data.

Known scope limits: business RLS/RPC/Storage, production grants/triggers, owner
email delivery/recovery, staff provisioning, and backup restoration are untested.
AbortSignal.any support is required when composing caller cancellation signals;
older browsers fail closed for those requests. One earlier expanded Auth run
timed out; loopback health checks and subsequent runs passed. Its cause
was not established, so this does not prove long-running infrastructure stability.

Previous-stage results are historical in SECURITY_STAGE2.md.
