# Invoice Revision Work: Not Released

## Implemented Subset

- Canonical rupiah/quantity calculator preserves received payments, recalculates
  remaining balance and exposes overpayment without silently clamping paid.
- Standalone invoice editor: saved product snapshots, add/remove lines, quantity,
  price, nominal discount, customer display name, notes and due date.
- Standalone delete dialog: cancelled order versus erroneous receipt, reason,
  and explicit no-real-money confirmation for a paid duplicate.
- Synthetic local preview has no Supabase/data client. External connections are
  blocked by CSP. It is not an end-to-end database workflow.

These components are NOT imported by Order or Dashboard yet. No new invoice
operation RPC, database migration, server journal adjustment, refund workflow,
report integration, production authentication activation, push or deployment
was completed by this work. Do not describe this as an active feature.

## Verification

- Initial repository suite: 509 passed, zero failed.
- Calculator: missing-module RED observed, then 25 new tests passed; full suite
  534 passed.
- Draft/render tests: missing implementation RED observed, then five tests passed.
- Rp0 rendering: assertion failed on empty zero label, then passed after fix.
- Full suite at the UI stage: 539 passed, zero failed.
- Existing production Vite build completed successfully. Because these UI
  components are not imported by production routes, this build does not prove
  their production integration; component SSR and the synthetic Vite preview
  exercised them separately.
- Browser checks: 390x844 mobile and 1366x900 desktop. Mobile form fields did
  not overflow horizontally (document width 390, offending controls zero).
- Synthetic edit: 12000000 turnover -> 11500000; invoice remains UJI-001,
  paid remains 200000; deletion -> 10000000 with refund still outstanding.
- Synthetic decimal addition: 1.25 meter at 20000 adds 25000, resulting turnover
  12025000 and remaining 1825000. Comma input accepted.
- Uncertain submit: fields and resubmit disabled, amount retained. This is only
  an in-dialog guard. Persistent actor-bound operation reconciliation is NOT
  implemented; reopening/reload must be handled before connecting a real RPC.
- Paid wrong-input deletion refuses submission until no-real-money checkbox
  is confirmed. Cancellation does not pretend an actual refund occurred.
- Independent reviewer found legacy MoneyInput stripped invalid characters and
  transformed 150000,50 into 15000050. Reproduced in the actual browser form:
  subtotal incorrectly became 300001000. Replaced that component only in this
  new editor with unsanitized text input and strict validation. Interactive
  rerun rejected 150000,50, -150000 and 12abc for both price and discount;
  valid inputs restore submit availability. Added draft-level regression tests.
- Independent review explicitly classified backend, persistent operation replay
  and production integration as outstanding work, not completed features.

## Fresh Access And Release Blockers

The user says GitHub Desktop and Supabase are signed in. This does not imply the
terminal or connector shares those credentials:

- Native Git push dry-run: failed because terminal prompts are disabled and no
  username credential was available.
- Connected GitHub repository metadata still reports pull=true, push=false.
- GitHub Desktop UI inspection timed out; a bundle lookup was ambiguous because
  several installed copies share the same bundle identifier. No credentials
  were extracted and no Git authentication settings were rewritten.
- The Supabase project Policies page initially opened. Subsequent read was
  rejected by automatic browser review because it targeted unrelated
  auth.openai.com. No alternative surface was used to bypass that denial.
  User handoff requested for the Supabase project page.
- Current source resolveAuthMode explicitly blocks secure mode at pos.skupy.id;
  it only permits the defined loopback or isolated preview setup. Do not remove
  that guard just to make this feature accessible.
- A verified complete backup/restore and real Auth/REST integration evidence
  are still prerequisites, not supplied by synthetic tests or dashboard login.

## Next Required Work

Resume Task 2 in the approved implementation plan: authenticated atomic invoice
operation, immutable payment/event reconciliation, invoice versions, debt and
journal updates, refunds and real independent-connection tests. Then connect
Task 3 to that operation with persistent replay/status handling, unify reports
in Task 4, and pass release gates in Task 5. Review the existing owner-only
historical-receipt attestation path carefully; no new owner approval should be
required for legitimate routine cashier edits/deletions.

No real order, invoice, payment, Supabase policy or production record was changed
to run these tests. No remote feature completion is claimed.
