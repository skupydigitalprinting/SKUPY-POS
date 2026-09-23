# Account lifecycle candidate 007

Preview only. No production changes or migrations executed. Candidates 001-006 and existing reset modules are unchanged by this task.

Current candidate 007 SHA-256 (editable until review approval): `1e3da19df8622a6c132006a3219e62957e735fd0d4203a5287870d84eede47d1`.

## Main wiring contract

- Default exports: `src/components/ManagedAccounts.jsx` and `src/components/SelfPasswordChange.jsx`.
- Both accept `{currentUser, getSession, fetchImpl, isCurrent}`. `currentUser` must be the verified profile containing `authUserId` and `authSessionId`. `getSession()` returns the SDK `{data:{session},error}` shape. Pass a bound function, not an unbound SDK method. `fetchImpl` defaults to global fetch; inject the captured session-bound helper. `isCurrent()` must compare the captured ready phase, epoch and principal. Missing guard fails closed.
- `ManagedAccounts` renders only for owner. `SelfPasswordChange` renders for owner/admin/staff and additionally requires `onSessionEnd(result)`.
- `onSessionEnd` must synchronously invalidate the captured data context/unmount before awaiting credential cleanup/sign-out, and must independently refuse to affect a newer context. The component/client recheck SDK subject/session and captured guard immediately before calling it. A switched SDK session or superseded context suppresses this callback. Main's normal session controller must handle SDK logout and context invalidation independently; no stale callback can be used to clean a newer login.
- Components capture helpers for their mounted session. Key the Settings subtree by verified epoch. The components also remount their internal forms on principal/session changes and clear secrets on dispatch. Unmounted forms discard UI updates, not required password-change cleanup: `settlePasswordChange` still invokes the session-bound `endPasswordSession` after a successful or uncertain response. Its captured-context/SDK checks continue to protect newer logins.
- API default exports: `api/accounts.js`, `api/auth/change-password.js`. Preview factories: `createPreviewAccountsHandler(env)`, `createPreviewSelfPasswordHandler(env)` from `server/supabaseAccounts.js`.
- Local preview DI exports: `createAccountLifecycleHandler(dependencies)`, `createSelfPasswordHandler(dependencies)` from `server/accountLifecycle.js`; `createSupabaseAccountDependencies(config, factory?)` from `server/supabaseAccounts.js`. Handlers require explicit enabled/origin/HMAC/trusted-IP settings. Factories reuse the existing strict isolated-preview config, never production.

## HTTP

Every request is a same-origin `POST`, JSON, `Authorization: Bearer <token>`, no cookies; responses are `no-store`. Mutations require `Idempotency-Key: <UUID>`. Use one key per logical operation, never automatically retry an ambiguous mutation. No passwords, Auth identities or tokens are returned.

`/api/accounts` accepts exactly one of:

```json
{"action":"list"}
{"action":"status","operationId":"<UUID>"}
{"action":"create","username":"cashier","name":"Cashier","role":"staff","initialPassword":"<secret>","ownerPassword":"<current secret>"}
{"action":"update","targetAdminId":"<legacy UUID>","expectedVersion":1,"patch":{"name":"Name","role":"admin","active":false},"ownerPassword":"<current secret>"}
```

Create username is normalized lowercase, 3-32 ASCII letters/digits/dot/underscore/hyphen, starting alphanumeric. Name is trimmed, 1-100 characters. Only staff/admin roles. Update patch is nonempty and permits only name/role/active. Unknown fields are rejected. New passwords reuse the 12-codepoint/72-byte policy and must differ from the current proof password.

`/api/auth/change-password`: `{"currentPassword":"<secret>","newPassword":"<secret>"}`. Target is exclusively the verified caller, never an input ID.

Success: create `201`, others `200`, `{ok:true,operationId,account}`; list `{ok:true,accounts}`; nonterminal status `{ok:true,operationId,state:"reserved"|"auth_started"|"unknown"}`; self `{ok:true,operationId,reauthenticationRequired:true}`.

Account shape: `{id,username,name,role,active,pending,version}`. ID is immutable legacy admins ID. Pending unbound creation has version 0 and may include its creating owner's `operationId`; other owners cannot inspect its operation status. No owner records, passwords, aliases or Auth IDs leave the directory.

Failures: malformed 400/413/415, missing bearer 401, origin/proof/authorization 403, stale update 409, rate limit 429, unavailable/uncertain 503. Do not expose backend details. Uncertain mutations include `uncertain:true,operationId`; self also requests reauthentication. Ambiguous finish does **not** assert `locked:true`; only an acknowledged begin followed by a negative Auth update with no finish attempted is reported locked by the server. The client conservatively does not propagate a definite lock for ambiguous outcomes.

## SQL and SDK boundary

Prerequisites: 001-005, actual `admins` schema (NOT NULL password), Auth users/sessions. Test deliberately excludes 006. Deployment still requires 006 business/legacy-login denial; 007 alone does not secure legacy routes.

Service-only RPCs, fixed empty search path, private ledger with direct access revoked:

| RPC | Parameters after actor UUID, session UUID |
| --- | --- |
| `pos_managed_accounts` | none |
| `pos_account_reserve` | operation UUID, username, name, role, keyed fingerprint |
| `pos_account_claim` | operation UUID |
| `pos_account_finish_create` | operation UUID, verified new Auth UUID |
| `pos_account_update` | operation UUID, legacy target UUID, expected version, JSON patch, keyed fingerprint |
| `pos_account_status` | operation UUID |
| `pos_self_password_begin` | operation UUID, keyed fingerprint |
| `pos_self_password_finish` | operation UUID |
| `pos_self_password_status` | operation UUID |

Owner verification reuses `createSupabaseRecoveryDependencies.verifyOwner`, then matches decoded session routing subject to its verified Auth ID. Owner current-password proof reuses `reauthenticate`. Staff-capable self proof uses a fresh unprivileged client, verified user/profile and mandatory local sign-out of the temporary session. No service-role sign-in. Shared global/IP and keyed token/actor rate checks run before proofs.

The shared IP key is exactly `ip:HMAC_SHA256(secret, "ip:" + ip)`, matching login/reset. All endpoint instances must use the same HMAC secret and limiter store. Account mutations consume the shared IP budget for both their token and stable-actor checks; rotating tokens does not bypass the IP budget.

SQL locks mappings and checks the actual actor `auth.sessions.id`, matching user, active private role, absent reset and session creation strictly after cutoff. Browser roles/IDs are never authorization. Mutation versions and operation UUIDs are enforced transactionally. Fingerprints are keyed server HMACs, not plaintext passwords or unsalted password hashes; current proof passwords are excluded. Identity and username never change. Display-only changes preserve session validity; role/active changes advance a monotonic cutoff. No owner target, owner promotion, hard delete, or pending-reset edit.

Create sequence: durable name/legacy-ID reservation -> one-shot dispatch claim -> one Auth create -> SQL binding. Auth alias is exactly `<operationUUID>@staff.skupy.invalid`; `email_confirm:true` confirms only this server-controlled synthetic identifier, never real email ownership. Binding verifies this alias and rejects an existing mapping. Legacy password is a random, >72-character unusable sentinel generated in SQL, never the new Auth password. Mapping becomes active only at successful finish; earlier sessions remain excluded.

Exactly-once remote completion cannot be guaranteed across network failure. The claim guarantees at-most-once Auth dispatch. A lost claim/create/finish remains pending unless matching historical completion is confirmed. No lease takeover, email adoption, blind create retry or automatic Auth deletion. An unmapped Auth orphan is denied POS access. Resolving an orphan/reservation requires a separately reviewed operator procedure; this batch intentionally provides no unsafe compensating unlock or cancellation.

Review correction: definite pre-acknowledgement SQL errors (`42501`, `23505`, `22023`, `40001`) are rejected without status reconciliation. A completed UUID belonging to a different payload/password cannot turn a reservation conflict into HTTP success. Automatic reconciliation requires an acknowledged request-validated reservation or self-password begin; create completion must also match the reserved legacy ID. Lost reservation or atomic-update responses remain uncertain because UUID-only status does not validate their submitted fingerprint. Identical acknowledged reservation replay remains idempotent. The explicit status action reports historical operation state, not proof that a differently submitted request/password was accepted.

Self password sequence: verified original session + fresh password proof and proof-session cleanup -> private one-shot operation and existing `reset_operation` cutoff -> Auth password update -> exact scoped finish with final cutoff. Finish/status do not require the now-invalid original session, but are service-only and require the stored actor/session/operation. Lost begin never redispatches; ambiguous Auth update stays pending; delayed finish can already have unlocked, so status absence/nonterminal state is not proof of a permanent lock. Begin/final cutoffs deny old and during-operation sessions. Existing 003 resets cannot be overwritten or finished through 007.

## Verification and remaining gates

- TDD red/green: 31 focused Node tests (handler 15, SDK boundary 5, session-bound client/settlement 10, JSX render 1). Prior SQL verification: 13 actual PGlite tests loading 001-005 + 007 with catalog-shaped admins fixture and synthetic history FK; SQL is unchanged by the dismissal fix.
- Latest broad run: `node --test src/lib/*.test.js tests/*.test.js`, 148 passed, one unrelated failure: `src/lib/paymentClient.test.js` imports the not-yet-created `src/lib/paymentClient.js`. The payment files were not modified. The earlier pre-dismissal-review run had 145 passes and zero failures.
- Dismissal regression first failed with zero cleanup calls after unmount. Tests exercise the production settlement helper used by the component with a deferred real account-client request: successful/uncertain responses still clean up, no post-dismissal UI callbacks run, newer SDK sessions/contexts are untouched, and cleanup exceptions are contained without updating a dismissed form. No source-text assertions or additional UI dependencies were used. Component props and main's guarded `onSessionEnd` contract are unchanged.
- New regressions first reproduced false HTTP 201 on conflicting completed UUIDs and the cross-endpoint IP-budget bypass. Tests cover changed password/fields, unacknowledged history, wrong reserved IDs, three endpoint exhaustion directions, actual SQL reservation conflicts and actual SQL limiter exhaustion. No real Auth lab was executed; SDK Auth creation remains mocked at that boundary.
- SQL tests include one-shot/replayed operations, private actor/session checks, version conflicts, preserved legacy IDs/history, reset interoperability, cutoff monotonicity, rollback on ledger failure and RPC/private-table grants despite permissive defaults. PGlite queues transactions; this is not proof of multi-connection PostgreSQL locking behavior.
- Focused command: `node --test tests/accountLifecycle.test.js tests/accountDependencies.test.js tests/accountViews.test.js src/lib/accountClient.test.js`.
- SQL command in the isolated dependency environment: `POS_PGLITE_MODULE=/private/tmp/skupy-security-stage2/tools/security-lab/node_modules/@electric-sql/pglite/dist/index.js node --test tools/security-lab/accounts.test.js`. Normal lab installation can omit that environment variable.
- Main reports Settings integration, local preview routing and the epoch-bound session-ending adapter wired. Full 006+007 Auth/REST lab tests, browser interaction/mobile review and real Supabase cross-service failure probes remain main's verification gates. No production approval is implied.
- Separate gap: 006 staff book access requires explicit owner-managed `admin_book_access`. This batch intentionally does not assign books or implement its UI. Creating/reactivating a staff account grants no book access by itself.
- Owner email recovery is not implemented. It remains gated on verified owner email plus approved email delivery/redirect configuration and a separately reviewed proof/recovery flow. Synthetic staff aliases are not recovery addresses. No fake email-success UI exists.
