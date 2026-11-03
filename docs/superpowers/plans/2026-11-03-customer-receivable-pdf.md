# Customer Receivable PDF Implementation Plan

**Goal:** Add an export in the customer debt detail dialog showing totals, all notes and actual payment history for that customer only.

**Architecture:** Reuse the existing local PDF renderer and access-scoped customer group. Read payment history with the existing paginated reader. Include daily payment totals and per-invoice allocations; label differences from invoice paid totals without inventing old payment dates. No write, payment, or permission changes. Use existing libraries, main folder and automatic deployment as requested.

## Steps
- [x] Test customer isolation, settled notes, history deduplication, failures and old DP gaps.
- [x] Extend report/PDF and add an isolated download control above the customer tabs; cancel stale exports after closing or switching customer/Book/account.
- [x] Verify PDF text and rendered pages, desktop/mobile controls, full tests and build; independently review.

## Verification
- Actual customer downloads passed at 1280px and 390px, with totals and history verified via PDF text extraction.
- All four sample PDF pages reviewed; phone totals stack without overlap.
- Stale group regression observed RED then GREEN. Closing detail or switching Book during history loading cancels the download.
- Independent reviewer confirmed the live-only detail group fix.
- Release via main push and production deploy; verify a read-only customer download online.
