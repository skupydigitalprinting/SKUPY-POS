# Payment Dates Implementation Plan

**Goal:** Record the actual WIB payment day separately from entry time, and allow audited date-only corrections of existing receivable receipts.

**Architecture:** Keep `paid_at` as effective reporting time; preserve original entry time in immutable `recorded_at`. Dated submission is an atomic, versioned RPC compatible with old pending requests. Date correction updates the matching cash/journal dates atomically without changing amounts or balances.

**Scope:** Individual Order payments, receivable FIFO allocations, receipt history and customer PDF. Existing historical dates remain unchanged until explicitly edited. Do not invent payment history for old DP lacking a receipt. No unrelated financial refactors.

## Tasks
- [x] Add SQL migration and isolated regression tests for dated submissions, audit, authorization, replay, stale corrections, ledger consistency and legacy restrictions.
- [x] Extend payment client fingerprints and recovery with optional immutable paymentDate; test legacy recovery and dated requests.
- [x] Wire store and date-only correction client with session/book fencing; never retry an uncertain money submission with another identity.
- [x] Add WIB date input to individual/FIFO payment forms and date correction to receipt detail rows.
- [x] Display original recorded timestamp separately in history/PDF and preserve effective-day totals.
- [x] Run full unit/build/SQL tests, independent review and desktop/mobile UI verification.
- [x] Inspect production schema, take targeted backup, apply tested compatible migration, verify catalog; commit/push and deploy; verify production asset and read-only views.

## Constraints
- No changes to amounts, allocation order, invoice numbering or user credentials.
- Staff corrections remain scoped to verified access. Existing RLS/ledger protections stay enabled.
- Date corrections require a reason, compare-and-swap and immutable audit evidence.
- Dates are valid calendar days, not future WIB days. UI defaults to today's WIB date for new input and current payment day for editing.
- Historical FIFO allocations remain individual receipts; never infer a batch from matching timestamps.
- Do not fabricate production transactions to test the feature.
- Leave unrelated `supabase/.temp/cli-latest` unmodified.

## Verification And Rollout
- 667 application tests passed; 77 SQL tests passed, including 46 focused date tests.
- Independent UI/client and SQL review findings resolved. Real multi-session PostgreSQL concurrency was not executed because the local server was unavailable; lock ordering reviewed against payment/refund paths.
- Migration 016 applied to project ejqfttivgovhqhzkrncx. Targeted pre-migration backup retained privately outside Git.
- Readback compared all 510 existing receipts and 173 payment events: no existing fields changed; recorded_at/effective_at backfill matched original timestamps. No test payments or date corrections were submitted to production.
- Legacy restriction: 337 existing receipts lack distinct cash postings. Date corrections for such rows are refused until their postings are reconciled; the feature does not manufacture cash/journal entries or change historical balances.
- Application commit e1a04dc pushed to main. Production deployment dpl_7dKhjrMayUNqaUmbGAaEDg8Gepzt is ready at https://pos.skupy.id/.
- Production UI verified read-only: history shows original recorded time, correction form defaults to the existing receipt day, and new FIFO payment defaults to 2026-11-03 WIB. Both forms closed without saving. Production root returned HTTP 200.
