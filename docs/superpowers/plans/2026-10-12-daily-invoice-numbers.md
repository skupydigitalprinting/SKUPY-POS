# Daily Invoice Numbers

**Goal:** New invoices use SKP-INV-YYYYMMDD-NNNN; historical numbers remain unchanged.

**Design:** Allocate a global daily number in PostgreSQL, using Asia/Jakarta. A private counter row serializes allocation across cashiers/books. Existing checkout operation IDs continue to provide replay protection. The global invoice uniqueness index remains the final duplicate guard. Only the invoice-number assignment changes; order numbers and financial behavior do not.

- [x] Reproduce the long number in a checkout regression test.
- [x] Add migration 015 with private daily counters and a guarded update to the existing checkout function.
- [x] Test concurrent checkout on isolated PostgreSQL, replay, deletion, WIB boundaries, more than 9999 invoices, historical preservation, permissions, and rollback.
- [x] Run full app tests and build; retain the previous production function before deployment.
- [x] Apply the migration atomically and verify the production definition without creating a real sale.

Verified: 604 app tests, 21 focused checkout/numbering tests, and 6 isolated multi-connection PostgreSQL tests. Production readback confirms only the invoice-number assignment changed, all 736 historical invoice/order numbers are unchanged, and direct client access to the counter is denied. Release the verified source through the existing GitHub/Vercel deployment.

The first allocation counts existing invoices that day, including cancelled/deleted ones, and respects any higher existing daily suffix. Failed transactions may reuse an unissued number; committed numbers are never reused. Gaps after deletion are intentional. No invoice is created or renumbered by the migration itself.
