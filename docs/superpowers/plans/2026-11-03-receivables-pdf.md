# Receivables PDF Implementation Plan

**Goal:** Download the complete visible Book's receivables as a PDF, with totals, customer recap and invoice detail.

**Architecture:** Use the already complete, access-scoped debts passed by App. Export ignores local PIC/search/status filters so the full accessible total is reproducible. A lazy-loaded jsPDF/AutoTable module produces a local download, with no database writes or third-party data upload.

**Scope:** All non-deleted notes, including settled notes; sum each invoice's nonnegative remaining amount. Print Book, account scope and WIB generation timestamp. Do not change payments, FIFO or permissions. Work in main and deploy as previously requested.

## Steps
- [x] Test totals, deleted notes, same-name customers, missing customers, large collections and multi-page PDFs.
- [x] Build a pure report model and paginated PDF renderer with repeated column headings and page numbers.
- [x] Add a download button to Piutang and pass Book/store metadata from App; prevent stale downloads after Book/account changes.
- [x] Verify desktop/mobile download, render sample pages, run full tests/build and independent review.

## Verification
- 635 tests passed; production build passed.
- Actual downloads passed at 1280px and 390px using isolated synthetic data.
- PDF pagination tested with 1,201 invoices; first/detail/last pages visually checked.
- Non-Latin names use a lazy local licensed font; long Book metadata is bounded.
- Release through the existing main push and production deployment workflow.

## Review Focus
- Never bypass existing account/Book scope to export all data.
- Do not merge different customers with identical names.
- Long invoice identifiers and names must wrap without clipping.
- Do not truncate output at API or UI page limits.
- Async module loading must not download a previous account's report after navigation.
