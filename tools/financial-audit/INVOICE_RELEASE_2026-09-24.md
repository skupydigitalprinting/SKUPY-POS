# Invoice Revision Work: Not Released

## Implemented Subset

- Canonical rupiah/quantity calculator preserves payments and exposes overpayment.
- Standalone editor and delete dialog, with synthetic mobile/desktop preview.
- Candidate 011 adds authenticated, versioned edit/cancel/incorrect-receipt void/refund operations. Invoice, debt, journal, cash, customer summary, internal audit and operation result commit atomically.
- Candidate 010 has private extension hooks. Its original behavior remains covered when 011 is absent.
- Initial receipt and installment postings are reconciled individually by source, amount, tender, timestamp, account and attribution. Ambiguous history is rejected, not silently repaired or reassigned to another actor.
- Persistent client stores only actor/environment-bound operation identity and request fingerprint. Web Locks prevent concurrent same-tab/origin submission; lost responses reconcile using the same operation ID. No customer note or request body is persisted by this client.

SQL is in `supabase/security-stage2/`, outside automatic migrations. These components and the client are NOT connected to Order/Dashboard. No production auth activation, production migration, push or deployment has occurred. This is not an active feature.

## Verification

- Root `npm test`: 553 passed, zero failed.
- `npm run test:security:sql`: 107 passed, zero failed.
- Candidate backend suites: 74 passed (22 lifecycle, 23 unchanged payment-ledger tests, 29 business-operation tests), zero failed.
- Client/SQL integration using isolated PGlite: five passed, zero failed. Lost committed response reconciles once; stale edits do not overwrite; active turnover passes 10m -> 12m -> 11.5m -> 10m while real DP remains refundable. Server-confirmed stale retries and invalid-date rollbacks can recover to a corrected request.
- Production build succeeds (4.24 seconds). Unwired components are not proof of production integration.
- Existing synthetic browser verification: desktop 1366x900, mobile 390x844, no horizontal overflow; decimal quantities; DP preserved; uncertain submit locked; wrong-receipt confirmation required.
- Thirteen persistent-client tests cover reload/replay, stale sessions, environment separation, cross-tab locking, malformed receipts, storage failure and rollback/ambiguous responses.
- Independent SQL review found four defects: nullable creator authorization, aggregate-only historical receipt validation, unverified baseline insertion, and net-only journal verification. Each was reproduced and corrected with regression coverage. Follow-up review confirmed those regressions and found two more issues: legacy status-only cancellation could reactivate, and a known failed stale retry could remain blocked. Both were reproduced and fixed; final suites above passed. Full integrated release review remains outstanding.
- Direct production-workflow status updates were initially rejected after adoption. A failing regression now passes without permitting raw money/cancellation writes.
- `git diff --check` succeeds.

Real PostgreSQL concurrency is NOT verified. The opt-in test `receipt ledger PostgreSQL: simultaneous cash and bank receipts accumulate once` fails before fixture setup because the Docker Unix socket is absent. Starting Docker Desktop waited for Mac administrator authorization; the startup command was cancelled. No old lab was reset and no production database was used as a substitute. Tests skipped by the default opt-in guard are not counted as passing concurrency evidence.

## Release Blockers

- Native Git push dry-run cannot read a username credential. Connected GitHub metadata reports pull=true, push=false. Desktop login does not grant this terminal/connector write access.
- GitHub Desktop UI inspection timed out; multiple installed copies share its identifier. No credentials were extracted or Git credential configuration changed.
- Supabase Policies inspection was rejected by browser automatic review after an unrelated auth.openai.com redirect. No alternate route bypassed that denial and no production records/policies were changed.
- Current `resolveAuthMode` explicitly blocks secure auth on pos.skupy.id. Production still needs a verified identity/account transition; the guard must not simply be removed.
- The legacy checkout/payment writers are not compatible with activating candidate 010/011. Full Auth/REST/Storage integration, backup including Storage objects, isolated restore, owner recovery and rollback evidence are prerequisites.
- Explicit refund-payable account mapping remains a production prerequisite. The synthetic 2195 test account is not an approved production chart mapping.

## Remaining Work

Task 2 still requires real concurrent connections, full integration and final review. Task 3 still requires authenticated Order/Dashboard/store wiring, capabilities, reconciliation UI and compatible payment/checkout paths. Task 4 still requires canonical reports, cash/refund visibility, exports and fresh printed snapshots. Task 5 still requires backup/restore, actual write/deploy access, approved release sequencing and production smoke verification.

Do not mark Tasks 2-5 complete or deploy this candidate just because synthetic tests pass. No real invoice, payment, journal or customer data was altered for testing.
