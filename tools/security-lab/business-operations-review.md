# 009 Business Operations Candidate

Owned files only: `supabase/security-stage2/009_business_operations.sql`,
`tools/security-lab/business-operations.test.js`, this report. No 006/client/007/008
edits, package changes, real database access, commits, or subagents.
Schema + 001-006 are prerequisites; this is not an automatic migration or
authorization to apply SQL to a database.

## Integration Block: Payment Must Remain Unconnected

**BLOCKED for payment-client wiring, activation, and production.** Main reports
auto-review rejected the secure payment-client patch because mixed-tender and
financial concurrency gaps remain unresolved. The user was notified and asked
for approval for isolated testing only; this report does not assert that approval
has been granted. Earlier approval covers candidate SQL, PGlite tests and this
report only. No alternative wiring or activation path is authorized here.

Before any payment hook is connected:

1. Obtain independent review of 009 authorization, idempotency, financial posting,
   supported tender restrictions, reversals and historical-data failure cases.
2. Obtain explicit authorization for the separate isolated real-database tests.
   Then verify multi-connection duplicate/replayed operations, competing final-
   balance payments, invoice collisions, mapping/book changes, legacy writers,
   lock ordering, deadlock rollback/retry and lost-response reconciliation.
3. Resolve or explicitly approve the supported financial/tender contract with
   evidence, and pass the review gate before requesting client integration.

Passing PGlite tests does not satisfy these gates. Keep `pos_record_payment`
unconnected; do not activate 009 or apply it in production. Main reports only the
book UI is wired to `pos_set_admin_books`, behind its existing preview guard.
That separate preview wiring does not authorize payment wiring or activation.

## Client Contracts

The payment contract below is candidate documentation for review, not an
instruction to connect a client before the integration block is cleared.

`pos_record_payment(p_operation_id uuid,p_invoice_no text,p_amount numeric,p_method text,p_notes text)`
returns ONE JSON object, e.g.:

```json
{"invoice_no":"INV-A","amount":30,"paid":50,"remaining":50,"status":"aktif"}
```

- `status` is debt status: `aktif` while remaining > 0, otherwise `lunas`.
  `paid` is cumulative, `amount` this receipt. No customer/Auth/operation IDs or
  credentials returned. Order status is separately set to `pending`/`lunas`;
  workflow status, initial DP, creator/cashier and original sale method stay intact.
- Amount must be finite, positive, **whole rupiah**, and not exceed remaining.
  No rounding/clamping or guessing corrupt old balances. Invoice trimmed, method
  trimmed/lowercased (`cash`, `transfer`, `qris`); NULL notes become empty string.
  Invoice max 256 chars; notes max 4000. Other methods/empty invoice/null op deny.
- Linked orders support only the same cash/bank account as the original tender.
  Cash and `hutang` map to 1000; transfer/QRIS map to 1100. A transfer/QRIS payment
  against a `hutang` or cash order, or cash against a bank order, fails 22023 with
  no committed operation or money change. **Do not fall back to direct writes.**
  Opening debt has no original order tender and uses the requested method.
- Main must generate and retain one operation UUID per logical payment. On lost
  response, retry the SAME UUID and same normalized payload, never a fresh UUID.
  Exact actor/payload replay returns the original receipt, even after later payments.
  Same UUID/different actor -> 42501; different payload -> 22023. Replays require a
  current valid profile/session, but may read their own receipt after book revocation.
- SQLSTATE 42501 means denied; 22023 invalid/ambiguous/inconsistent/overpay;
  23514 can mean journal verification failure. Unexpected SQLSTATEs fail/rollback;
  messages are generic and never include definer row details. Transport uncertainty
  is not proof of rollback: retry same operation. Main owns HTTP behavior.

The preview book UI now needs the versioned contract (the old two-argument
setter is removed):

- Owner-only `pos_admin_book_access(p_admin_id uuid)` reads current assignments.
- Owner-only `pos_set_admin_books(p_admin_id uuid,p_book_ids uuid[],p_expected_version bigint)`
  replaces them only when the supplied version still matches.

Both return ONE JSON object:

```json
{"admin_id":"<legacy-admin-uuid>","book_ids":["<book-uuid>"],"version":1}
```

- Current trusted owner only; target must be a mapped, active, non-reset-pending
  **staff** account. Reject owner/admin/unmapped/inactive/self-owner targets.
- Setter accepts valid active, nondeleted books only. Duplicates normalized; result UUIDs sorted.
  `[]` clears access. NULL list/null members/invalid books reject atomically.
  At most 1000 inputs. Does not provision Auth or modify private identity authority.
- Existing assignments start at version 0. Read returns actual stored IDs, including
  any inactive/missing book IDs; it does not hide existing assignments or initialize
  a revision row. Version and assignments are read together under the target lock.
- Each successful CAS increments the private per-staff revision, **even if the
  desired assignment set is unchanged or already empty**. Revisions are persistent,
  nonnegative JSON-safe integers and are never reset by this candidate. Exhaustion
  fails closed. Invalid/null versions -> 22023; stale expectations -> **40001**.
- On timeout, read current state/version. Keep the original expected version for
  retries of the same request; do not silently rebase a delayed grant onto a fresh
  version. A confirmed newer clear is a sequencing barrier: delayed older grants
  fail 40001. A read showing an empty set alone does NOT cancel a pending request;
  clearing still requires a successful CAS, including when it is a no-op.
- Use after successful provisioning, passing the preserved legacy admin ID.
  Replacement, revision initialization/increment and returned version commit
  atomically. Failed membership writes leave both assignment and version unchanged.
- 009 now revokes PUBLIC/anon/authenticated direct membership INSERT/UPDATE/DELETE,
  including inherited column INSERT/UPDATE ACLs; legacy owner-client table writes
  can no longer bypass CAS. Read permissions from 006 remain. Private revision
  table is RLS-enabled and denies PUBLIC/anon/authenticated/service raw access.
- Both book RPCs require READ COMMITTED (or PostgreSQL's equivalent READ UNCOMMITTED),
  with actor/target identity locks in stable Auth-ID order. Stronger snapshot
  isolation rejects 25000, preventing stale snapshots after waiting for the lock.
  Privileged database maintenance must coordinate revisions; this is not a defense
  against database owners bypassing SQL privileges. Real concurrency gates remain.

## Payment Authorization / Integrity

- Trusted owner/admin all books. Staff needs explicit 006 book access and either
  the order's original cashier authority or its customer's PIC authority.
  PIC can pay a linked order hidden by ordinary transaction RLS; no SELECT policy
  is broadened and original cashier is not changed. Collector attribution on the
  new debt-payment row comes only from the verified current profile.
- Uses definer reads to distinguish an actually absent order from an RLS-hidden
  one. Linked debt MUST match canonical order ID, invoice, customer, book, total,
  paid and remaining. More than one matching debt rejects; no arbitrary LIMIT 1.
- True debt-only path requires `transaction_id IS NULL` and no order with that
  invoice, a valid active customer/book link and authorized PIC/manager.
  Hidden, dangling, conflicting, deleted or cancelled links never become opening debt.
- A debt whose invoice label itself is NULL cannot be addressed by this invoice-
  based API. It requires a separately reviewed identifier-based flow; no label is
  fabricated and no fallback selects one of multiple unlabeled debts.
- An order without a debt creates exactly one debt from the locked order's
  existing balances and customer. No customer/no valid customer link -> reject.
  No customerless order-only payment alternative or fabricated customer is added.
- Reject null/nonfinite/fractional/negative/inconsistent stored balances, overpay,
  deleted/cancelled orders and non-active debts. Preserve old inconsistent data for
  reviewed repair rather than silently normalizing it.
- Operation reservation, money updates, payment INSERT, 006 customer summaries,
  journal verification and durable receipt all share one SQL transaction.
  `pos_security.payment_operations` has global unique operation ID, actor Auth ID,
  canonical SHA-256 request fingerprint, IDs and minimal result; no password/raw
  notes. RLS enabled, all PUBLIC/anon/authenticated/service raw privileges revoked.

## Accounting Boundaries / Remaining Risks

- Linked order uses the **existing** sale posting trigger. Its exact expected
  cumulative debit/credit/cash shape is checked after UPDATE, so swallowed posting
  errors cannot record successful payment. No duplicate linked receipt journal.
- Existing sale tender/date allocation is retained: cumulative paid is reposted
  under the original sale method/date, while `debt_payments` records actual method
  and time. Cross-account mixed tender now FAILS CLOSED. Transfer vs QRIS both use
  1100 and are permitted, but cash-movement method labels/date retain the original
  sale attribution. This does not claim complete installment/date allocation.
  Historical missing/other sale-method values follow the unchanged helper's cash
  fallback; only supported request methods are accepted. No stored method is changed.
- Debt-only receipts lack an order trigger, so this RPC writes actual receipt
  Dr cash/bank, Cr 1200 and one cash movement (`source_type='debt_payment'`, source
  ID = payment UUID). It does NOT invent an opening sale or initial receivable.
  Existing opening balances must have their own correct historical treatment.
- Later direct edits/deletions of these opening payment rows do not have a new
  reversal trigger here. Main must not claim payment edit/delete/reversal solved.
- 006 still allows some legacy direct money mutations. Atomic/idempotency guarantees
  apply to this RPC, not every pre-existing SQL route. Any future approved secure
  payment branch must replace the old multi-request/debt-only fallback while
  preserving legacy mode. No such payment branch is connected by this task.
- Lock order: actor mapping SHARE, operation row, 006 global invoice-binding lock,
  invoice advisory lock, order,
  debt rows in ID order, customer UPDATE, book SHARE. Book replacement locks owner
  and target mappings in Auth-ID order, then the private revision, then books in ID
  order. Book reads take mapping SHARE locks in the same order. Advisory locks
  use the same `skupy:business-invoice-binding:v1` key as the reviewed 006 guard.
  New payments require read committed isolation. Other legacy writers can still create incompatible
  rows or deadlocks; real PostgreSQL multi-connection tests and retry handling are
  required. PGlite queued calls are NOT concurrency proof.
- No claim that full checkout, FIFO batches, cancellation, reassignment, historical
  data repair, mixed-tender accounting, backup, UI or production cutover is solved.

## Verification

- TDD: initial suite failed on missing RPCs before 009 was written.
- Initial PGlite pass: 15/15 tests on mechanical full catalog fixture + 001-006.
- Expanded verification: 19/19 passed with the updated 006 invoice guard. Historical
  corruption is seeded BEFORE 006, never by disabling guards during the RPC tests.
- Mixed-tender RED reproduced silent acceptance of cash -> transfer before the
  account-match guard. Final combined run: **53/53 passed**, no skips, 22.2 seconds
  (21 operation tests + the other task's 32 current 006 tests):
  `node --test tools/security-lab/business-operations.test.js tools/security-lab/business.test.js`.
- This proves the tested single-connection SQL paths, not concurrent production
  safety, real Auth, PostgREST/HTTP retry behavior, or full cashier UI workflows.
- Book CAS review fix: five new focused groups failed before implementation,
  including the still-open direct membership write path. Delayed grant/confirmed
  clear, no-op barriers, honest version reads, forbidden raw/legacy access, rollback,
  lost-response reconciliation, queued CAS and snapshot-isolation tests were added.
  Updated combined run: **61/61 passed**, no skips, 24.9 seconds (29 operation
  tests + 32 unchanged 006 tests), using the same two-file command above.
- The blocked `pos_record_payment` function definition is byte-for-byte unchanged
  by this book fix (SHA-256
  `0a50b79a567c8f537028cfea9b3e391cdab3ffa67dabb47546bb397c95d24c98`).
  This book-only security fix does not lift the payment integration block.

### Isolated Real PostgreSQL Follow-up (11 September 2026)

`payment-concurrency-local.test.js` now exercises candidate 009 on separate,
fresh synthetic databases in the pinned local Docker Desktop container. Run
explicitly with `SKUPY_RUN_LOCAL_PAYMENT_TESTS=1 node --test --test-concurrency=1
tools/security-lab/payment-concurrency-local.test.js` from the repository root.
It is skipped by default and is not part of automatic deployment evidence.

Final run: 4/4 passed, zero skips, 5.13 seconds. Independent PostgreSQL backends
must all be observed blocked at a shared lock barrier before release. Tested:
six same-operation retries yield one payment; competing full-balance operations
admit one; partial receipts accumulate; injected journal failure rolls back and
the same operation succeeds after removing the fault. Failure assertions check
SQLSTATE 23514 and the injected trigger warning, not just generic rejection.

Docker calls use an explicit validated local Unix socket, ignore Docker endpoint
environment overrides, and pin the inspected container ID. Cleanup is restricted
to the newly created database with its matching run marker, without force drop.
The existing Auth lab and production databases are not altered. Final execution
also passed with intentionally invalid DOCKER_HOST and DOCKER_CONTEXT values.

This closes only these SQL-level overlap/rollback test gaps. All requests use the
same synthetic identity with manually supplied SQL claims, not real Auth/REST or
two different cashiers. Book/mapping races, other writers, full accounting
date/tender allocation, editing/reversals, cancellation and UI remain unverified.
No payment client wiring or production activation is authorized by these tests.

### Independent Actors And Access Races

The subsequent expansion passed 12/12 real local PostgreSQL tests in 19.04
seconds with no skips, including the original four. New tests use separate
synthetic cashier, customer PIC, same-book outsider and two owner identities.
They verify collector attribution without exposing another cashier's order,
actor-bound operation receipts, payment vs mapping/book revocation in both lock
orders, competing owner revision saves, and a delayed grant after a newer no-op
clear. Worker blocking relationships are observed before releasing each gate.
Focused independent review found no actionable issue. Cleanup left no test
databases or worker sessions. All SQL inputs remain synthetic; this is not
actual JWT/REST, UI or complete financial workflow evidence. Candidate 009 is
still disconnected and not approved for production activation.
