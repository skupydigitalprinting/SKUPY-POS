# 006 Business Access: Candidate Compatibility Review

Candidate only, outside automatic migrations. No real database, production,
Storage, 001-005, 007, package, or client files changed by this task.
**Not ready for production cutover or a full-workflow success claim.**

## Immediate Integration Blockers

Follow-up containment (11 September): secure UI/hook reassignment is now blocked
before requests, and customer schema downgrade retries are disabled in secure
mode. Customer deletion also checks errors/validity for both related-row counts.
These are client safeguards, not replacement transactional RPCs or proof of
global/concurrent deletion safety. See SECURITY_STAGE4.md for current tests.

| Flow | Exact current boundary / required integration |
| --- | --- |
| Customer summaries | RESOLVED at SQL boundary: `src/hooks/useStore.js` `recalculateCustomerSummary` (near 510) and `src/hooks/useAccounting.js` customer sync (near 1500) must no-op in secure mode. 006 now adds canonical AFTER INSERT/UPDATE/DELETE summary triggers on transactions/debts; tests verify payment changes `total_debt`. Every client remains denied direct aggregate changes. Uses unchanged existing helper semantics: count/sum all linked transactions, debt `status='aktif'` only, with no deleted/cancelled exclusion. This preserves old semantics, not a corrected financial definition. |
| Payment/DP/FIFO | `useStore.js` `processDebtPayment` (near 1640) performs multiple independent requests. PIC staff may read a debt but not its linked order created by another cashier. The missing order is incorrectly interpreted as a genuinely debt-only opening balance. A payment row can be inserted, but order totals/journals remain stale; direct linked-debt updates can also fail the guard's order visibility check. Needs an atomic, scoped payment contract with real concurrency/idempotency tests. No payment RPC added here. |
| Checkout | Transaction INSERT and its ledger/summary triggers work. Stock decrement and debt creation remain separate requests and can partially fail. Skip secure-mode client aggregate writes after this candidate is applied. This is NOT an end-to-end checkout pass. |
| Cancellation/deletion | Changing own order `order_status` to `dibatalkan` removes its sale journal/cash rows. Related debts/payments are not automatically reconciled. Customer summaries recompute using the old helper, which still includes cancelled/deleted rows. Staff cannot soft/hard delete transaction/debt rows. Existing sale trigger does not handle `deleted_at`; owner/admin soft deletion alone can leave journal rows. |
| Reassignment | `useStore.js` customer PIC reassignment, receivable transfer and order customer changes (near 900-1150) directly relink rows and insert audit events. These are denied, even for owner: book/identity/parent links immutable; three audit tables client-read-only. Hide/disable secure-mode commands pending transactional authorized RPCs with trusted audit attribution. |
| Accounting maintenance | Owner/admin read and source-entry access retained. Direct journal/cash writes denied. `acc_resync` and `acc_delete_employee_advance` owner-only; supplier delete owner/admin. Direct bank recalculation, asset repost and customer-summary RPCs revoked as internal helpers. Existing callers must not silently fall back. |
| Accounting edits | Payment parent IDs, attribution IDs, book IDs and source IDs cannot change. Supplier/employee `paid` updates must come from payment triggers. Direct hard deletes owner-only. `accounts` and `migration_details` writes owner-only. Check existing edit/import/opening-balance screens against these contracts. |
| Books | Owner/admin all books; staff requires an explicit `admin_book_access(admin_id,book_id)` joined to active, nondeleted book. Null/missing membership is not global access. Owner CRUD on mappings exists, owner/admin read all, staff read own. Provision after trusted account creation; replacement is not atomic through separate table requests. No assignment RPC added. |

## Invoice Binding / 009 Contract

- Finding status: **CLOSED at the candidate SQL write boundary after green
  regression tests**, not production or historical-data certification. New
  linked debts derive `invoice_no` from their actual
  `transaction_id`, with matching customer/book. Omission is allowed only on a
  new debt; an explicitly inconsistent invoice is rejected, not overwritten.
- Existing linked debts with missing/mismatched invoices, mismatched parents,
  duplicate links/labels, or inconsistent payment references fail closed with
  generic `42501`. No matching by invoice alone, guessing, automatic backfill, or
  legacy data cleanup is performed by this candidate. Reviewed repair is a
  separate prerequisite for affected historical rows, including deleted rows.
- Unlinked debts can retain distinct opening labels or NULL. A label cannot
  equal any transaction invoice, even in another book or on a deleted row.
  Conversely, later transaction writes cannot capture existing opening labels.
  Multiple NULL opening labels remain valid because payments bind by debt ID.
- Three `01_business_invoice_guard` BEFORE triggers on transactions/debts/payments
  run after the invoker guard. They check global references as definer without
  granting caller access to foreign rows, and also apply to table-owner/definer
  writes. The helper has no PUBLIC/anon/authenticated/service execution grant.
- **009 lock order:** acquire
  `pg_advisory_xact_lock(hashtextextended('skupy:business-invoice-binding:v1',0))`
  at RPC entry, before business row locks. The triggers take the same transaction
  lock. Use READ COMMITTED (READ UNCOMMITTED has equivalent PostgreSQL semantics);
  stronger snapshot isolation is rejected with `25000`. This conservative preview
  lock serializes these invoice-bearing writes across books. Direct multi-row
  writes can still deadlock with other lock orders and must fail/retry atomically.
- 009 must authorize and resolve by debt/transaction IDs, retain the trigger
  checks, propagate failures, and never repair a legacy invoice while paying it.
  This is an integrity contract, not a replacement for its actor/session/book
  checks, payment idempotency, or atomic posting. No 009 file was edited here.
- Existing staff debt INSERT with `RETURNING` can fail its self-querying SELECT
  policy. Positive binding tests insert then SELECT; they do not claim direct
  `INSERT ... RETURNING` compatibility or change that policy.
- Multi-connection lock ordering and concurrent opening/transaction collision
  tests remain a real local integration gate. PGlite here is single-connection;
  the passing tests do not prove concurrent behavior or clean historical data.

## Product Contract / Cost Privacy

- `pos_product_costs()` returns all `{id,modal}` rows only for a current trusted owner.
- `pos_save_product(p_id uuid,p_values jsonb)` returns one JSON object, not an array.
  NULL id creates; existing id updates under a row lock; unknown id raises P0002.
  Allowed keys: `name,category,price,modal,stock,description,image,unit,is_favorite`.
  Extra keys/nonobjects rejected; omitted fields preserve existing values/defaults.
  Presence of `modal`, including JSON null, requires owner. Nonowner result strips cost.
- Direct product SELECT/INSERT/UPDATE column ACLs exclude `modal`; direct favorite
  update and shared product/category CRUD remain available to all valid profiles.
  Existing `SELECT *`/whole-row return paths must use explicit safe columns.
- Product definer error details could reveal hidden cost on a NOT NULL failure.
  Regression test reproduced this; RPC now rethrows generic message + SQLSTATE.
- `src/pages/Kasir.jsx:183` constructs cart fields explicitly, excluding cost;
  line 299 strips stock/image before persisting. `useStore.js` `trxToDB` forwards
  `items` unchanged. No observed normal cashier path copies product cost. Arbitrary
  historical/import JSON has NOT been inspected (no business data access): existing
  `transactions.items` containing costs would remain visible to authorized order
  readers. Do not claim historical JSON scrubbed. No broad item-schema redesign.

## RPC / Trigger Inventory

- Checked owner/admin: `acc_dashboard(date,date)`, `acc_summary(date,date)`,
  `acc_recap_admin(date,date)`, `acc_delete_supplier_debt(uuid)`.
- Checked owner-only: `acc_resync()`, `acc_delete_employee_advance(uuid)`.
- Internal, no app EXECUTE: `acc_cash_code(text)`, `acc_recalc_bank_loan(uuid)`,
  `acc_repost_asset_purchase(uuid)`, `recalculate_customer_summary(uuid)`.
- `acc_bootstrap_migration_details()` is an inert 42501 denial, with app/service
  EXECUTE revoked; its historical public-policy/GRANT body cannot reopen access.
- Original six exposed financial bodies moved verbatim to `pos_security`, behind
  checked wrappers. All 26 original functions have fixed empty search paths and
  explicit revoked client execution; callable wrappers grant authenticated only.
- Existing 17 table triggers preserved; two canonical AFTER summary triggers added
  on transactions/debts, running after legacy triggers and locking affected customer
  rows in ID order. Asset repost and customer summary trigger
  helpers run as definer to retain narrow internal write authority. Original
  financial trigger bodies catch/swallow errors: positive posting tests do not
  prove failure atomicity. This remains a release risk, not silently repaired.
- Three additional BEFORE invoice-integrity triggers protect debt/transaction/
  payment references, including definer writes, as described in the 009 contract.

## Fixture / Evidence / Limits

- `business-fixture.js` mechanically emits `business-schema.sql` and
  `business-manifest.json` from the private 20260911 catalog: exactly 41 tables,
  26 functions and 17 table triggers, original defaults/constraints/indexes/bodies,
  no records, credentials or Auth/Storage data. Raw catalog is not included.
- Original event-trigger function retained; live event-trigger binding, live
  ACLs/default-ACL owners/role memberships were not exported. Tests instead inject
  adversarial PUBLIC/anon/authenticated table/function defaults and column ACLs.
- RLS groups (all table names) are the exported `businessGroups` allowlist in
  `business-fixture.js`; SQL is explicitly scoped to those 41 public tables.
- RED before 006: fixture fidelity passed; 9 security/contract groups failed.
  Product-error privacy test reproduced a leak before its fix. Two canonical
  summary tests failed on payment-update staleness before the new triggers.
  Original complete business run: **18/18 passed**, no skips (10.6 seconds).
- Invoice-binding TDD: the 18 existing tests stayed green; new spoofing,
  canonicalization, ambiguity, and legacy-reference regressions were observed
  failing before the fix. The initial positive test was adjusted to avoid the
  separate INSERT RETURNING limitation, then failed on NULL vs canonical invoice.
  Final isolated-source PGlite run: **32/32 tests passed**, no skips (18.5 seconds):
  the original 18 groups plus 8 new groups and 6 nested legacy-data cases.
  Test inputs were copied narrowly into
  `/private/tmp/skupy-security-stage2/invoice-review-ACJEYa`; the existing lab
  dependency fallback was used, with no real database or production access.
  Source/test byte equality and unchanged 001-005/fixture inputs were checked.
  Only 006, business.test.js, and this report changed in this fix.
- Unchanged identity/username/recovery suites: **43/43 passed**, no skips
  (14.7 seconds), using the existing local PGlite dependency via a read-only Node
  resolver hook. No dependency install or package-file edit.
  This prior 43-test result was not rerun for the invoice-only change.
- In-memory PGlite is not real Auth, PostgREST, Storage, UI, multi-connection locks,
  a live restore rehearsal, or proof of all business workflows. Main owns integration.

## Owned Files

- `supabase/security-stage2/006_business_access.sql`
- `tools/security-lab/business.test.js`
- `tools/security-lab/business-fixture.js`
- `tools/security-lab/business-schema.sql`
- `tools/security-lab/business-manifest.json`
- `tools/security-lab/business-review.md`
