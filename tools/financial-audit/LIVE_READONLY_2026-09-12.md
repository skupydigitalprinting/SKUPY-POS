# Read-only production checks, 12 September 2026

Inspected the authenticated Supabase dashboard for project `ejqfttivgovhqhzkrncx`
using its Table Editor SQL panel. Executed only the SELECT statements below.
No financial rows, schema, grants, accounts or balances were changed. No customer
names, contact information, credentials or individual invoice rows were selected.

## Column contract

```sql
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('debt_payments', 'transactions', 'debts')
  AND (table_name = 'debt_payments'
       OR column_name IN ('deleted_at', 'order_status', 'paid', 'remaining', 'dp'))
ORDER BY table_name, ordinal_position;
```

The displayed debt_payments columns were id, debt_id, amount, payment_method,
notes, paid_at, cashier, cashier_id, invoice_no, cashier_name, deleted_at,
customer_id, customer_name, book_id. id/debt_id/amount are NOT NULL. There is no
created_at or note column. This confirms the report query mismatch and the
required linked-debt contract; it is not a complete live catalog/security audit.

## Aggregate financial diagnostics

```sql
SELECT 'invoice_balance_mismatch' AS check_name, count(*) AS affected
FROM public.transactions
WHERE deleted_at IS NULL AND total IS DISTINCT FROM (paid + remaining)
UNION ALL
SELECT 'linked_debt_balance_mismatch', count(*)
FROM public.debts d JOIN public.transactions t ON t.id = d.transaction_id
WHERE d.deleted_at IS NULL AND t.deleted_at IS NULL
  AND (d.paid IS DISTINCT FROM t.paid OR d.remaining IS DISTINCT FROM t.remaining
       OR d.total_debt IS DISTINCT FROM t.total)
UNION ALL
SELECT 'cancelled_with_receipts', count(*) FROM public.transactions
WHERE deleted_at IS NULL AND order_status = 'dibatalkan' AND paid > 0
UNION ALL
SELECT 'cancelled_with_remaining', count(*) FROM public.transactions
WHERE deleted_at IS NULL AND order_status = 'dibatalkan' AND remaining > 0
UNION ALL
SELECT 'installment_history_exceeds_paid', count(*) FROM public.debts d
JOIN (SELECT debt_id, sum(amount) AS paid FROM public.debt_payments
      WHERE deleted_at IS NULL GROUP BY debt_id) p ON p.debt_id = d.id
WHERE d.deleted_at IS NULL AND p.paid > d.paid;
```

| Check | Affected |
| --- | ---: |
| Invoice total differs from paid + remaining, including NULL mismatch | 6 |
| Linked active invoice/debt balance or total mismatch | 12 |
| Active cancelled invoice with receipts | 0 |
| Active cancelled invoice with remaining balance | 2 |
| Active debt installment history exceeds mirrored paid | 0 |

Counts may overlap; they are not 20 distinct affected transactions. Linked-debt
check covers non-null transaction_id matches only. These diagnostics do not
establish whether money was lost, reconstruct initial DP, explain each mismatch,
verify journal correctness or authorize correction. A consistent backup and
individual read-only reconciliation with source documents precede corrections.

### Rounding follow-up

An additional read-only aggregate classified the six invoice equation mismatches:
zero NULL-balance cases, six differences strictly between zero and one rupiah,
zero differences of at least one rupiah. These are sub-rupiah differences, not
evidence of material missing payments. They must not be described as six large
financial discrepancies. No stored amount was rounded or updated by this check.

```sql
SELECT count(*) FILTER (WHERE total IS NULL OR paid IS NULL OR remaining IS NULL) AS null_balance_rows,
 count(*) FILTER (WHERE abs(total-paid-remaining)>0 AND abs(total-paid-remaining)<1) AS sub_rupiah_difference,
 count(*) FILTER (WHERE abs(total-paid-remaining)>=1) AS difference_at_least_one_rupiah
FROM public.transactions
WHERE deleted_at IS NULL AND total IS DISTINCT FROM (paid+remaining);
```

A separate comparison of the 12 linked invoice/debt mismatches returned zero
remaining mismatches after rounding each paid/remaining/total to integer rupiah,
and 12 rounding-only cases. This supports keeping the existing integer-rupiah
calculation convention when processing a newly authorized payment, rather than
blocking these records solely for floating-point artifacts. It does not authorize
batch updates or establish the correctness of every historical payment/journal.

```sql
SELECT count(*) FILTER (WHERE round(d.paid) IS DISTINCT FROM round(t.paid)
 OR round(d.remaining) IS DISTINCT FROM round(t.remaining)
 OR round(d.total_debt) IS DISTINCT FROM round(t.total)) AS mismatch_after_rupiah_rounding,
 count(*) FILTER (WHERE round(d.paid) IS NOT DISTINCT FROM round(t.paid)
 AND round(d.remaining) IS NOT DISTINCT FROM round(t.remaining)
 AND round(d.total_debt) IS NOT DISTINCT FROM round(t.total)) AS rounding_only
FROM public.debts d JOIN public.transactions t ON t.id=d.transaction_id
WHERE d.deleted_at IS NULL AND t.deleted_at IS NULL
 AND (d.paid IS DISTINCT FROM t.paid OR d.remaining IS DISTINCT FROM t.remaining
      OR d.total_debt IS DISTINCT FROM t.total);
```

## Offline checker

`reconcile.js` exports `reconcileSnapshot({ transactions, debts, debt_payments })`.
It examines only supplied rows, returns findings without updates, performs no
I/O and explicitly returns `productionVerified: false`. It does not download or
prove completeness of a production snapshot. Its synthetic tests cover identity
conflicts, invalid money, cancelled balances, orphans and receipt-history bounds.

## Server release boundary

Current legacy login does not issue a server-verifiable user session. An atomic
payment function must not trust browser adminId/role or shared publishable keys.
Candidate security-stage2/009 is dependent on the unfinished identity migration
and retains incomplete linked-payment date/tender posting. It is not activated.
True atomic payments require authenticated authority, locked canonical rows,
durable operation receipts, event-based ledger posting and exclusion of legacy
writers, followed by real authenticated concurrency and restore verification.

Reference: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
and [database functions](https://supabase.com/docs/guides/database/functions).
