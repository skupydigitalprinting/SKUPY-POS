# Payment Event Ledger Candidate: 2026-09-12

**CANDIDATE ONLY. NOT DEPLOYED. NOT CLIENT-WIRED. NOT ALL EIGHT AUDIT FAILURES FIXED.**

## Owned Files

- `supabase/security-stage2/010_payment_event_ledger.sql`
- `tools/security-lab/payment-event-ledger.test.js`
- `tools/security-lab/payment-event-ledger-review.md` (this report)

No changes to 001-009, exported schema, old audit, source clients, authentication,
or parent-owned PostgreSQL fixtures/tests. No commits, subagents, Docker, network,
real database connection or production DML performed by this implementer.

## Contract

Apply explicitly to an isolated database in this order: exported
`tools/security-lab/business-schema.sql`, 001-006, 009, then 010. Files remain
outside automatic migrations. Installation performs no historical row updates
and creates no baseline records. Test data and Auth/session rows are synthetic.

`pos_record_payment(uuid,text,numeric,text,text)` retains 009's five arguments,
normalized request fingerprint, actor-bound operation reservation/replay, fresh
profile checks, access checks, and result shape. The result remains
`{invoice_no, amount, paid, remaining, status}`. Legacy 009 completed operations
may replay their original result but never create a new event or repair history.

An unpaid order must have `paid=dp=0`, a matching valid debt or no debt, a valid
customer/book link, no receipt history, and an exact balanced sale journal. If
missing, one debt is created atomically. First accepted payment establishes a
private baseline. An opening debt must be explicitly `is_opening=true`, have no
transaction link, `paid=0`, no payment history, and no ambiguous existing journal
under that invoice/debt ID. Subsequent balances must match baseline plus events.

Each accepted receipt creates one `pos_security.payment_events` row, one
`public.debt_payments` row, two accounting entries and one cash movement:

- `payment_events.payment_id = debt_payments.id = accounting_entries.source_id = cash_movements.source_id`.
- Both public journal sources use `source_type='debt_payment'`.
- `received_at`, `paid_at` and `moved_at` use one server `clock_timestamp()` value.
- Accounting receipt date is explicitly `(received_at AT TIME ZONE 'Asia/Jakarta')::date`.
- Cash debits account 1000; transfer and QRIS debit 1100, retaining their distinct
  tender strings; the balancing credit is receivable account 1200.
- Sale revenue, initial DP, initial tender, original sale journal IDs and dates
  remain unchanged. No cumulative-paid cash repost occurs after adoption.
- New sale journals also use explicit Asia/Jakarta date, independent of session
  timezone. Existing mismatched historical dates remain blocked, not repaired.

No caller-supplied/backdated receipt date is supported. This is the server
acceptance time, not evidence of an offline receipt's earlier physical time.
Legacy report functions still cast timestamps in the caller/session timezone;
WIB report-boundary normalization beyond the new posting contract is not done.

## Historical Initial-DP Attestation

The only supported historical reconciliation is
`public.pos_reconcile_initial_receipt(order_id, expected_json, evidence_ref)`.
It is authenticated, current-owner-only, per invoice, locked, and insert-only.
It does not modify any transaction, debt, payment, journal or cash movement.

`expected_json` must contain exactly these fields: `invoice_no`, `customer_id`,
`book_id`, `total`, `paid`, `dp`, `remaining`, `payment_method`, `created_at`.
Values must match the locked order; `created_at` must parse to the same timestamp.
Use a reviewed external receipt evidence reference, 1-1000 nonblank characters;
do not include credentials. The private baseline records the owner Auth ID,
snapshot, reference and attestation time. The reference is an assertion by the
owner, not automated proof that an external receipt exists or is accurate.

This requires `0 < paid = dp < total`, exact debt/order binding, no installments
(including deleted ones), no completed old payment operation for the order/debt,
and exact original-date/tender balanced sale and cash rows. A fully paid invoice,
overwritten DP, historical installments, duplicate debts, old-date mismatch or
damaged journal is rejected. Existing attestations cannot be overwritten, even
by repeated calls. Other histories need a separately reviewed, explicit
per-invoice reconciliation design and evidence; there is no bulk fallback.

## Fail-Closed Boundaries

Once adopted, all order/debt updates outside this RPC are blocked, including
no-op reposts, notes/status edits, reassignment, cancellation and corrections.
Deletes and protected sale/receipt journal changes are blocked. Direct legacy
debt-payment insert/update/delete is blocked globally. Pre-adoption balance/DP/
tender corrections are blocked too. Paid cancellation/deletion is blocked before
adoption as well. These are containment failures, not successful refunds.

The five guarded public tables reject TRUNCATE, including privileged maintenance
calls. `public.acc_resync()` authenticates the owner then raises; the legacy
internal resync remains inaccessible to clients and its order updates cannot
repost adopted invoices. Exported sale posting no longer catches and ignores
posting errors. Other legacy accounting subsystems are not rewritten.

Guard statement locks acquire the existing 006 binding advisory lock before row
locks. This serializes more than one invoice, including unrelated writes to the
guarded accounting tables; throughput is deliberately conservative. The private
write-context table is not a caller-settable GUC. Its capability exists only
during one RPC and disappears on success or rollback. RLS plus explicit ACL
revocation protects all new private tables and internal functions, even with
adversarial default grants. No anonymous or raw service-role RPC execution.
Database owners able to disable triggers/change functions remain trusted.

Errors: `42501` access/session/actor denial; `22023` invalid request, unsupported
or ambiguous history/balance; `23514` stored receipt/journal verification failure;
`55000` unsupported lifecycle/legacy mutation; `25000` unsupported isolation.
Constraint/posting errors preserve their SQLSTATE. Public RPC messages are
sanitized. No error should be interpreted as a successful payment or refund.

## Verification

All tests use real in-memory PGlite with schema + 001-006 + 009 + 010, not SQL
text matching or mocked journals. Dependency import uses the local lab package.
Missing 010 fails loading. Only explicit `PAYMENT_LEDGER_BASELINE=009` omits it.

- Initial red run against unchanged 009: 15 cases, 1 pass / 14 failures. The date
  assertion found zero receipt journal rows instead of two; mixed tender failed
  22023; legacy mutation and silent suppression did not reject. Missing new APIs
  in other cases were setup/API absence, not independent behavioral red proof.
- Additional red: silent receipt alteration committed instead of rejecting.
- Additional red: new midnight-boundary sale posted 2026-09-11 instead of WIB
  2026-09-12. No historical fixture was changed to make this pass.
- Independent review identified nullable predicates being ignored by `bool_and`.
  Both supplied scenarios reproduced locally as missing expected rejection:
  a late trigger nulled one receipt journal cashier, and a historical journal
  row had NULL invoice binding. All four full row predicates now use `IS TRUE`
  inside `bool_and`; targeted date/NULL regression run passed 3/3.
- Final candidate: `node --test tools/security-lab/payment-event-ledger.test.js`:
  **23/23 pass, 0 failures, 0 skipped**, including both independent-review fixes.
- Preserved 009 operations: `node --test tools/security-lab/business-operations.test.js`: **29/29 pass**.
- Preserved exported-schema audit: `node --test tools/financial-audit/database.test.js`: **2/10 pass, 8 failures**, unchanged legacy evidence.
- Intermediate candidate syntax/name-collision failures were real failed runs,
  corrected before final verification; they are not counted as successes.

Coverage includes exact date/tender posting, preserved DP, opening receipts,
actor-bound and old-009 replay, snapshot/history ambiguity, ACL/default grants,
invalid sessions/requests, hidden orders, atomic missing-debt creation, insertion
failure/suppression, silent row alteration, GUC spoofing, legacy and maintenance
mutation containment, new-sale posting errors and UTC/WIB midnight boundaries.
Nullable journal fields cannot be silently omitted from aggregate verification.
Queued requests on PGlite's single connection do not prove concurrent locking.
The parent owns separate independent PostgreSQL tests and review evidence.
At handoff, the parent reports a fresh independent **23/23 PGlite and 9/9 real
PostgreSQL** pass, including initial DP, overnight sale and NULL-journal cases.
Those PostgreSQL runs were not performed by this implementer. Focused final
independent review remains pending; none of these results activates production.

Preservation SHA-256, checked before and after implementation:

```text
009_business_operations.sql    0d58fd13da88829e4592c5f77730ac89360cb1a6d9b915e9f69bb48060e150d4
database.test.js               69424258d454bed93b77e2f348da741fdaeac7810bbccf837a20250cf0e8087c
business-operations.test.js    714f59befa30ca1135b2b7f35eea5ddff0a37d15ef2bfdc059ef363159ff9362
```

Final candidate SHA-256:

```text
010_payment_event_ledger.sql   4e39f137d2d93298bafe5e3fe05fae038cf62821dd5a68a69ce54563457e3cef
payment-event-ledger.test.js  fe466fcc244646c661c3fb82fad798521c90cccccd19b5bd37fe2a29653e5baa
```

## Remaining Release Gates

Independent SQL/security review and real multi-connection PostgreSQL validation
are parent-owned, not established by this PGlite run. All legacy writers and
report consumers require a coordinated cutover before this can be activated.
There is no full DP/refund/cancellation/correction workflow, historical
installment conversion, opening-balance journal reconstruction, report-wide
fix, or client integration in this candidate. In particular, opening receipts
credit receivables but do not manufacture the historical opening debit.

Parent reports a physical backup dated 2026-09-11 17:44:20 UTC; Storage objects
are excluded and a direct dump requires an unavailable database password.
This is not verified isolated restore or complete recovery evidence. Recovery
email configuration/delivery and authoritative owner mapping/session readiness
remain unverified. No email value is included in these artifacts. Verified
backup/isolated restore (including Storage), identity/recovery, independent
review, real concurrency and a complete coordinated integration/cutover remain
required. No production activation is authorized by these test results.
