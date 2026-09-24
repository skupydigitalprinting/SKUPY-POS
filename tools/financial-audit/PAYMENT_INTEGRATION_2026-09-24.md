# Verified Payment Integration Checkpoint

Status: candidate integration only. Invoice self-service is NOT activated online.
Base: eb6e934d2ea41d27151a379541e19810015e64b5.

## Production Inspection

Authorized Supabase browser access now works. A read-only readiness query found zero
Auth users and no public pos_* functions. Production therefore still uses the
legacy login/payment paths. GitHub credentials and Docker are also available;
none of these access problems should be reported as current blockers.

The backups screen showed daily physical database backups, latest displayed
2026-09-23 17:44:55 UTC. Storage objects are explicitly excluded. No complete
database/Storage export or isolated restore was performed. No production SQL,
accounts, invoices, payments or policies were changed in this checkpoint.

## Implemented

- Candidate 012 wraps the atomic payment RPC with transactionally verified private
  request/result receipts and actor/book-authorized status recovery.
- The verified-session store now uses that RPC for installments instead of direct
  sequential table writes. The legacy production path is unchanged.
- Browser client retains a stable operation ID and fingerprint, locks concurrent
  tabs, verifies returned results, and permits only exact original-request retry.
  Request contents are kept in actor/project-scoped sessionStorage, not shared
  localStorage. Lost responses can be reconciled without resending money.
- Global, Order and Piutang recovery controls distinguish uncertain payment from
  confirmed payment awaiting a balance refresh. No fallback to legacy writes.
- Fresh balances release only resolved UI/FIFO blocks. Refresh recovery remains
  available after successful operations clear their pending request metadata.
- Full refresh captures the current Book generation and rejects old callbacks.

## Verification

- Root application tests: 571 passed, zero failures/skips.
- Existing security SQL tests: 107 passed, zero failures/skips.
- New payment recovery SQL/client integration: 5 passed, zero failures/skips.
- Real local PostgreSQL recovery concurrency: 2 passed, zero failures/skips.
  Four concurrent identical requests produce one payment/receipt; revocation
  while status waits prevents disclosure.
- Production build passed (2356 modules, 3.57 seconds); diff check passed.
- Synthetic browser preview tested desktop and 390x844 mobile, status -> unknown
  -> exact retry -> one payment. Mobile document/client width both 390px.
- Independent review found three recovery defects (lost refresh control, stuck
  Order payment issue, stuck FIFO customer block). Regression tests reproduced
  them before fixes and passed afterwards. A stale Book refresh regression also
  failed before its guard was added. These tests do not represent full production
  Auth/REST/Storage workflow verification.

## Still Required Before Activation

1. Verified owner/staff provisioning, immutable legacy mappings and owner recovery.
   Owner must privately open the activation link and create their own password.
2. Atomic checkout integration and reconciled adoption of historical paid invoices.
3. Refund management and canonical dated cash/correction reporting integration.
4. Real isolated Auth/REST/Storage workflow tests, complete database/Storage backup,
   isolated restore and coordinated backend/frontend cutover with rollback.

Auth production-origin guards remain unchanged. Applying candidate migrations or
deploying source alone does not complete this release. Do not describe owner
activation as the only remaining task.
