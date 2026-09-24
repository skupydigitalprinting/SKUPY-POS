# Atomic Checkout Integration Checkpoint

This is a tested source checkpoint, NOT production activation of invoice
edit/delete. Candidate013 is outside automatic Supabase migrations. The
production auth guard and legacy online behavior remain unchanged.

## Implemented

- Verified-session checkout submits one server operation for invoice, receipt,
  debt, customer totals and future installment baseline. There are no sequential
  browser writes in this path and no stock limit for made-to-order products.
- The server derives actor and invoice snapshots from authorized records and
  validates persisted money rows before returning a receipt.
- DP under Hutang/Tempo has an explicit cash/transfer/QRIS method. Outstanding
  balances require a registered customer and due date.
- One actor/project checkout intent survives reload; exact retries use the same
  operation. Draft customer data stays in sessionStorage, not shared localStorage.
- Server-confirmed abandonment records a terminal marker using the same unique
  operation lock as checkout. It cannot cancel an existing invoice or permit a
  delayed original checkout to commit. This recovers closed-tab drafts safely.
- Successful commits remain successful when refresh fails, with subsequent
  checkout blocked until refresh. Session changes cannot expose the prior
  account's receipt. UI recovery clears the completed cart.

## Verification

Executed on 24 September 2026, on the final checkout source:

- Root `npm test`: 583 passed, 0 failed/skipped.
- Security SQL baseline: 107 passed, 0 failed/skipped.
- Checkout SQL/client, invoice SQL/client, payment recovery and payment event
  suites together: 69 passed, 0 failed/skipped.
- Real local PostgreSQL checkout concurrency: 5 passed, 0 failed/skipped.
  Includes duplicate submissions, conflicting payloads, revocation, abandonment
  racing an in-flight checkout, and delayed checkout after abandonment.
- Production build: passed in 4.00 seconds. `git diff --check`: clean.
- Actual Kasir component with synthetic transport: desktop1366x900 and
  mobile390x844 screenshots checked; DP method visible; successful checkout
  created one synthetic invoice; lost-response recovery kept one invoice and
  cleared the cart; mobile document width390/scrollWidth390.
- Independent review found closed-tab and rejected-resend dead ends. Failing
  regression tests were added before the terminal-abandonment fix. A separate
  failing session-change regression was fixed and now passes.

The browser preview does not test real Auth/REST. SQL fixtures do not prove live
JWT or full production workflow correctness. No real invoice was edited,
deleted, paid or refunded during these tests.

## Production Readiness Still Incomplete

- The owner Auth identity now exists, created by the user. This does not prove
  POS role mapping, password recovery or staff provisioning.
- Supabase dashboard is accessible, but the CLI project-list operation returns
  missing platform authorization. A normal CLI browser authorization is being
  requested; no token has been copied into source or chat.
- Latest visible scheduled backup: 23 Sep2026 17:44:55UTC, physical. The page
  explicitly excludes Storage objects. Complete export and isolated restore
  have not been performed.
- Historical payment reconciliation, refund/report integration, full isolated
  Auth/REST/Storage workflows, owner/staff cutover and rollback remain unfinished.
- Do not activate production by removing auth guards, granting anonymous
  financial RPC access, or labelling this checkpoint as the online fix.
