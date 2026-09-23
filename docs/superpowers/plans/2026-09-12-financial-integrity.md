# Financial Integrity Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for scoped tasks and review.

**Goal:** Deliver the approved payment error containment and report consistency fixes without changing historical financial records or activating unfinished authentication migrations.

**Architecture:** Preserve current legacy login. Treat uncertain multi-write outcomes as reconciliation-required, never retry them automatically. Correct read-side cash calculations from existing transaction and payment events. A true atomic server payment requires verified server identity, row locks, operation receipts and compatible ledger posting; never publish an anonymously privileged replacement.

**Tech Stack:** React, Supabase, Node test runner, Vite, synthetic PostgreSQL tests.

**Spec:** User-approved five-step design in this conversation: payment confirmation, atomic persistence, explicit cancellation DP resolution, unified reports, backup and historical reconciliation.

## Constraints
- Preserve pre-existing dirty source and security work. Use a separate secret-free copy, then sync only reviewed changes.
- Never perform production financial DML, automatic historical corrections, or candidate security migration activation.
- No change to login mode or broad grants. Production publication is already authorized after verification.
- If server identity/backup gates cannot be satisfied, deliver bounded containment and explicitly retain the atomic/cancellation backlog.

## Task 1: Payment containment
- [x] Reproduce tools/financial-audit/payments.test.js failures with real callbacks.
- [x] Check scoped payment preflight reads and mutations; reject invalid corrections, mark uncertain writes needsReconciliation, stop FIFO at failure and preserve partial totals.
- [x] Add focused root regression tests, rerun existing checkout tests; preserve user input and block blind repeat in Order/Piutang.
- [x] Review code and actual synthetic write/read outcomes.

## Task 2: Read-side consistency
- [x] Reproduce tools/financial-audit/reports.test.js failures.
- [x] Correct Dashboard payment method allocation, period boundaries, cancelled receipts and incomplete read handling in useAccounting. Preserve uploaded/existing UI styling.
- [x] Add focused root tests; assert headline equals payment method totals and payment date attribution.
- [x] Review source completeness and cancellation semantics without inventing refund data.

## Task 3: Server/cancellation readiness
- [x] Inspect current auth boundary and candidate SQL; verified privileged server cutover is not ready without the identity migration.
- [x] Do not apply SQL until verified identity and database/file backup gates exist. No SQL or auth changes applied.
- [x] Document concrete remaining requirements; add conservative guards for destructive status changes where feasible.
- [ ] Activate verified server identity, durable atomic payment receipts, corrected event-based ledger, coordinated DP refund/credit and restore-tested backups. Deferred, not completed by this frontend release.

## Task 4: Verification and release
- [x] Run root tests, all audit suites, build, and focused UI checks with synthetic data only. Root 509/509; audit 229/237, eight unchanged SQL failures.
- [x] Independently review all scoped changes and fix regressions.
- [x] Package frontend-only release, retain previous deployment for rollback, verify candidate before promotion.
- [x] Verify public bundles and existing read-only production session. Deployed scope and remaining gates are recorded in tools/financial-audit/RELEASE_2026-09-12.md.

## Decisions
- Existing repo contains unreleased authentication work. Reuse its frontend in legacy mode as previous release did; do not claim full security cutover.
- Legacy callbacks cannot provide cross-table rollback. Error containment is an interim improvement, not atomicity or cross-cashier protection.
