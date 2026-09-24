# Invoice Integration Checkpoint

Status: local implementation checkpoint, NOT a completed production release.
Base: 9ea6a02ad9532d9373088f0e004f034a31eeb712.

## Implemented In This Checkpoint

- App supplies a verified-session-only invoice workflow to Order and Dashboard.
- Order action menu and cancellation selector open the shared edit/removal workflow.
- Dashboard invoice actions use the same item editor, rather than overwriting total/DP directly in secure mode.
- Fresh server invoice version and stored item snapshots are loaded before editing.
- Successful changes refresh related invoice/debt/customer/payment collections together; failed refresh is explicitly distinguished from failed mutation.
- Invoice previews close on confirmed mutations. Reads started before a mutation/book switch cannot overwrite the refreshed collections.
- Pending operations can be checked independently of invoice visibility, including a deleted invoice.
- Exact pending request is retained in tab-only sessionStorage for reload recovery, scoped by project and verified actor. Shared localStorage contains identity/fingerprint only. Completion/known rollback cleans both. Another tab without the original draft can check status but cannot invent a retry payload.
- Operation clients are bound to book generation as well as verified login. A changed book cannot send a delayed pre-dispatch request or erase evidence of an in-flight request.

## Verification

- Root application suite: 570 passed, zero failures/skips.
- Security SQL suite: 107 passed, zero failures/skips.
- Invoice SQL + client/PGlite integration: 27 passed, zero failures/skips.
- Real local PostgreSQL payment concurrency: 9 passed, zero failures/skips.
- Real local PostgreSQL invoice concurrency: 7 passed, zero failures/skips (edit/pay, cancel/pay, duplicate requests, competing refunds, actor collision, revocation, lost-response status).
- Build passed; git diff --check passed.
- Real Order component browser checks with synthetic transport: 12m -> 11.5m -> 10m; DP retained; lost response/status recovery; unknown-request exact retry; recovery of a deleted invoice absent from active rows.
- Desktop/mobile screenshots and DOM-width checks showed no horizontal overflow. Browser viewport override restored after tests.

The browser transport is synthetic; PostgreSQL tests use synthetic Auth claims in exclusive fresh databases. These are not full Auth/REST/Storage or production workflow evidence.

## Review Fixes

Independent review found delayed-read overwrite, recovery after reopen, and book-switch loss of operation evidence. Added regressions and fixed them. Store regressions failed on the earlier integration and passed after the fixes. Exact-request reload tests similarly failed before pending/resume support was added.

## Remaining Release Gates

- Existing production login is legacy. resolveAuthMode intentionally prevents secure mode on pos.skupy.id; unchanged here.
- Checkout and payment writers still require compatible atomic RPC integration before activating 010/011. The new invoice UI is not a substitute for this work.
- Refund management and canonical dated cash/correction reporting still need full application integration.
- Verify production account mapping, owner recovery, complete database/Storage backup and isolated restore.
- Verify the complete workflow with real Auth/REST/Storage in an isolated environment, then coordinate backend/frontend cutover and rollback.
- Fresh authorized Supabase access is needed for production inspection. No production SQL or transaction data was changed in this checkpoint.

GitHub push authentication was repaired previously. Do not report it as a remaining blocker. Do not claim that deploying this checkpoint activates the requested feature in production.
