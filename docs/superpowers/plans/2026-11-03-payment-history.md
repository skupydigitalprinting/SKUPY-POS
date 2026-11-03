# Complete receivable payment history implementation plan

> Execute inline using superpowers:executing-plans and test-driven-development.

Goal: restore visibility of existing payments and correct receivable totals without modifying financial data or access policies.

Spec: investigation findings from 3 November: luby naira has 163 debts, 32 payment allocations totaling IDR170m; the global 500-debt slice loads only 106 unpaid debts. The user requested the proposed repair now.

Architecture: paginate the lightweight, book-scoped/RLS-protected debt collection in every load/refresh path, publishing only a complete result. Batch history reads by the resulting debt IDs, preserving legacy payments with null customer/book columns and server authorization. Reuse the existing error/retry/date-grouped history component in both entry points. Heavy transaction item payloads retain their existing bounds.

Constraints: no SQL migrations, data edits, permission changes, or unrelated UI redesign. Preserve pre-existing supabase/.temp/cli-latest modification. Test with synthetic records; production validation is read-only.

Review focus: server page caps; errors after first page; book/session changes; old payment rows with null customer fields; history close/reopen races. Use existing hook tests for session fencing and new regression cases for pagination and batched reads.

- [x] Add regression tests showing old paid debts beyond the first 500 must populate totals/history, including later-page failure and scoped queries; observe failure.
- [x] Add reusable complete read helper and apply to refreshAll, refreshDebts, and invoiceWorkflow.refresh.
- [x] Add batched paginated payment-history reads with debt-ID linkage and all-or-error semantics; connect both history entry points and test.
- [x] Run full tests/build, obtain independent code review, address material findings.
- [ ] Commit/push the repair, deploy to existing production project, verify totals and payment history in the authenticated owner UI.

Ruling: retain the existing collection/grouping architecture but paginate the complete scoped lightweight debts; this fixes all PIC summaries and individual history together. Per-customer lazy queries alone would leave the PIC summary incorrect. No change to access policy for legacy null book_id records.

Validation: baseline604 passed; regression tests observed failing before repair; final613 passed, no skips; Vite build succeeded. Independent reviewer found count-change pagination issue; addressed with a failing-then-passing regression and verified review. Existing concurrent fixture now binds invoice response by table rather than request-start order.
