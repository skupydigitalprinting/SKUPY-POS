# Invoice Edit And Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if selected by the user. Track each step below. This plan is awaiting review; it is not implementation evidence.

**Goal:** Kasir/admin mengedit barang pada invoice yang sama dan menghapus invoice dari omzet/daftar aktif tanpa ACC owner, tanpa kehilangan uang nyata atau menggandakan pembayaran.

**Architecture:** One authenticated, versioned server operation updates invoice, debt, financial events and audit atomically. The existing React Order menu and Dashboard editor use a shared item editor and the same operation client. Deletion is hidden from normal lists but retained internally; actual receipts and refunds are separate from cancelled sales.

**Tech Stack:** React 18, Vite 5, existing Lucide and UI components, Supabase PostgreSQL, node:test, PGlite and the existing pinned local PostgreSQL test harness. No new application framework.

**Spec:** `docs/superpowers/specs/2026-09-24-invoice-self-service-design.md` in `/Users/thewa/Documents/GitHub/SKUPY-POS` (commit 280bf98).

## Global Constraints

- Kasir/admin may act only on invoices permitted by server book/order access; no owner approval step.
- Keep original invoice ID/number/date, creator attribution and real payment/DP history.
- Edit product lines, quantity, price, nominal discount, notes and due date; do not reparent customer/book.
- Integer PCS; meter/yard up to two decimal places. No stock cap for custom products.
- Deleted invoices never enter active lists, active exports or active turnover, including Semua Waktu.
- Money actually received is not automatically refunded by deletion. Incorrect receipt records use an explicit correction action, not an invented cash refund.
- All financial mutations require authenticated server identity, atomic writes, concurrency control and actor-bound operation replay. No anonymous privileged RPC or browser-supplied actor authority.
- Preserve unrelated dirty work. No blanket git add, no force push, no copied .env or credentials.
- Existing 010 is candidate-only and rejects invoice lifecycle changes. Do not activate it unchanged or claim earlier candidate tests prove this feature.
- Production financial/auth migrations require verified backup/restore, compatible account/client paths, real workflow evidence and rollback. Do not test by deleting real orders.

## Review Focus

1. A catalog product was deleted or repriced after checkout: preserve existing line snapshots on open and save.
2. Total becomes less than money received: preserve receipts and expose a refund obligation, never clamp paid.
3. Another cashier adds a receipt while edit/delete is open: reject stale revision; do not overwrite the new receipt.
4. Invoice created near WIB midnight or edited in a later month: distinguish active sale-period totals from dated adjustment/cash events.
5. A retry follows lost response, reload or account switch: same actor/payload can reconcile once; a different actor cannot adopt that operation.

## Task 1: Canonical Invoice Calculations

**Files:** Create `src/utils/invoiceChanges.js`, `src/utils/invoiceChanges.test.js`.

**Interfaces:** `calculateInvoiceChange({items, discount, tax, paid})` returns `{items, subtotal, discount, tax, total, paid, remaining, overpaid}`. Each item uses existing `{productId,name,price,qty,unit}` shape. Validate decimal input before calculation; return field-specific validation errors, not silent defaults.

- [ ] Add failing tests, including these assertions and catalog-snapshot retention:

```js
const quoted = calculateInvoiceChange({
  items: [{ productId: 'shirt', name: 'Kaos', price: 100000, qty: 4, unit: 'pcs' }],
  discount: 0, tax: 0, paid: 200000,
})
assert.equal(quoted.total, 400000)
assert.equal(quoted.remaining, 200000)
assert.equal(quoted.paid, 200000)
assert.equal(calculateInvoiceChange({
  ...quoted, items: [{ ...quoted.items[0], price: 150000, qty: 1 }],
}).overpaid, 50000)
```

- [ ] Run `node --test src/utils/invoiceChanges.test.js`; confirm failures concern the missing behavior.
- [ ] Implement the pure calculator. Calculate line amounts using integer hundredths for quantity and validated integer rupiah prices; sum before final rupiah rounding. Reject unsafe integer overflow, NaN, Infinity, negative prices, zero quantity, invalid PCS fractions, excess meter/yard precision, empty items and excessive discount. Preserve stored tax unless an explicitly supported tax edit is added in a separate scope.

```js
const subtotal = Math.round(items.reduce((sum, item) =>
  sum + item.price * Math.round(item.qty * 100), 0) / 100)
const total = subtotal - discount + tax
const remaining = Math.max(0, total - paid)
const overpaid = Math.max(0, paid - total)
```

- [ ] Test numeric/comma parsing at the form boundary separately. The calculator and SQL receive canonical numbers only.
- [ ] Run tests for unchanged catalog snapshots, invalid inputs and decimal rounding. Commit only these files after they pass.

## Task 2: Atomic Server Lifecycle Operations

**Files:** Create `supabase/security-stage2/011_invoice_lifecycle.sql`, `tools/security-lab/invoice-lifecycle.test.js`, `tools/security-lab/invoice-lifecycle-concurrency-local.test.js`; extend candidate 010 only where its immutable guards and payment updates must cooperate.

**Interfaces:**

```sql
public.pos_apply_invoice_change(
  p_operation_id uuid, p_invoice_id uuid, p_expected_version bigint,
  p_kind text, p_payload jsonb
) RETURNS jsonb;
public.pos_invoice_change_status(p_operation_id uuid) RETURNS jsonb;
```

`p_kind`: `edit`, `void_error`, `cancel`, `refund`. Edit payload allowlists `{items,discount,notes,due_date,reason}`; tax and customer identity are read from the locked row. Void/cancel require `{reason}`. Refund requires `{amount,method,occurred_at,reference,reason}` with cash/transfer/qris. Actor/session/book/customer/paid fields are never accepted from payload. Response: `{operationId,invoiceId,invoiceNo,version,state,total,paid,remaining,refundDue}`. Status is actor-scoped and exposes only terminal results or pending state.

- [ ] In an isolated schema, add failing behavioral tests: own cashier edit/delete allowed; manager allowed; unassigned book, anonymous, inactive and forged actor denied. Test 500000/200000 edited to 400000/200000, and 150000 with overpaid 50000.
- [ ] Add private operation/audit/event storage with RLS and explicit revoked default grants. Add a server-owned invoice version. Do not store secrets or arbitrary request bodies in public audit views.
- [ ] Implement transaction sequence: verify/lock current principal, reserve operation fingerprint, lock binding/invoice/linked debts deterministically, validate expected version and fresh data, validate payload and recalculate using the Task 1 rules in SQL, persist all effects, verify stored rows, save receipt and return. Preserve exact replay; reject changed actor/payload. Include payment/checkout/legacy-writer fencing in this same migration so concurrent writers cannot bypass versioning.

```sql
-- Inside the definer operation after principal and lock validation:
IF actual_version <> p_expected_version THEN
  RAISE EXCEPTION 'invoice changed; refresh before retry' USING ERRCODE='40001';
END IF;
-- Never UPDATE transactions SET paid = least(paid, new_total).
-- Every public return follows successful journal, debt and audit verification.
```

- [ ] Keep initial-sale and receipt events intact. Edit changes sale value and remaining claims through explicit adjustment postings; cancel removes the active claim and establishes refund due; void_error reverses erroneous sale/receipt records without fabricating a real outgoing payment; refund reduces cash and refund due once. Determine the dedicated refund-payable account from an explicit mapping verified against the chart; refuse a conflicting account definition. Do not reuse existing 2000 supplier or 2100 bank/asset accounts as customer-refund accounts.
- [ ] Add cases for absent debt, anonymous customer with no debt, customer-linked debts, legacy initial DP and historical installments. Permit history only when locked totals and available receipts reconcile exactly; return a specific mismatch otherwise, without owner-approval wording or automatic mass repair.
- [ ] Inject failure and silent row suppression at each write stage; assert all row snapshots are unchanged on failure. Check every nullable row predicate with `IS TRUE`, not nullable `bool_and` alone.
- [ ] Test real independent connections for edit-vs-pay, delete-vs-pay, duplicate retries, competing refunds, same-ID/different-actor, revocation and lost-response replay. Reuse only the inspected loopback Docker lab and fresh randomly named databases; do not reset another test database.
- [ ] Run new suites plus unchanged 009/010 suites. Document intentional superseded lifecycle restrictions in new tests without deleting legacy audit evidence. Request independent SQL/security review before integration.

## Task 3: Editor, Delete Dialog And Client Integration

**Files:** Create `src/components/InvoiceEditor.jsx`, `src/components/InvoiceDeleteDialog.jsx`, `src/lib/invoiceChangeClient.js`, `src/lib/invoiceChangeClient.test.js`, `tests/invoiceLifecycleUI.test.js`; modify `src/pages/Order.jsx`, `src/pages/Dashboard.jsx`, `src/hooks/useStore.js`, `src/App.jsx`.

**Interfaces:**

```jsx
<InvoiceEditor invoice={invoice} products={products} onClose={close}
  onSave={draft => changeInvoice(invoice.id, invoice.version, 'edit', draft)} />
<InvoiceDeleteDialog invoice={invoice} onClose={close}
  onConfirm={(kind, payload) => changeInvoice(invoice.id, invoice.version, kind, payload)} />
```

`changeInvoice(id, expectedVersion, kind, payload)` returns `{ok:true,data}` only after a verified result; otherwise `{ok:false,error,needsReconciliation,operationId}`. It uses the bound authenticated data client and persists the pending operation identity locally without treating local identity as server authority. Never auto-retry with a new operation ID after an ambiguous result.

- [ ] Write failing UI/client tests for item changes, decimal quantity, existing product snapshots, preserved DP, stale response/session switch, duplicate submission and no owner-approval fields.
- [ ] Add Edit Invoice and Hapus Invoice to the existing responsive Order action menu. Use existing Modal/Button/Input and Lucide icons; keep mobile fields readable and controls keyboard accessible. Reuse product fallback assets for product selection rather than adding unrelated decorative media.
- [ ] Editor opens stored lines, preserves invoice number/date, allows line addition/removal/repricing and nominal discount, and displays paid read-only with updated remaining/overpaid. Require reason on submit. Cancel leaves all data untouched.
- [ ] Delete dialog chooses salah input/duplikat versus pesanan tidak jadi. Unpaid invoice needs only reason/confirmation. Paid cancellation defaults to refund not performed; actual refund entry is separate and never transfers money automatically. Do not label a physically retained invoice as permanently destroyed.
- [ ] Route Dashboard edits/deletes through the same operation, replacing direct total/paid writes. Refresh invoices, customer/debt, report state and print/WhatsApp snapshots only after success. Remove the owner-reconciliation blanket message only where the new operation is actually connected and validated.
- [ ] On missing server capability, show feature unavailable with a clear technical release status, not owner approval; never fall back to unguarded legacy DELETE. Do not claim this unavailable state meets acceptance or ship it as a completed feature.
- [ ] Run UI/client and existing payment integrity tests. Independently review client replay/session binding and form arithmetic.

## Task 4: Omzet, Piutang, Cash And Printed Invoice Consistency

**Files:** Modify `src/utils/financialReports.js`, `src/utils/excelExport.js`, `src/hooks/useAccounting.js`, `src/pages/Dashboard.jsx`, `src/pages/Order.jsx`, `src/pages/Piutang.jsx`, `src/components/Invoice.jsx`; extend Task 2 reporting SQL for identical scope/period semantics. Create `tests/invoiceLifecycleReports.test.js` and extend `tools/financial-audit/reports.test.js` with new-contract cases while preserving legacy baselines.

**Interfaces:** Add `activeInvoiceRevenue(rows)` in `src/utils/invoiceChanges.js`: sum current invoice totals excluding server-confirmed removed/cancelled rows. Cash report readers consume canonical receipt/correction/refund events even when an invoice no longer appears in the active sales query.

- [ ] Write the user's exact acceptance test before implementation:

```js
const original = [{ total: 10000000, state: 'active' }]
const extra = { total: 2000000, state: 'active' }
assert.equal(activeInvoiceRevenue([...original, extra]), 12000000)
assert.equal(activeInvoiceRevenue([...original, { ...extra, state: 'cancelled' }]), 10000000)
assert.equal(activeInvoiceRevenue([...original, { ...extra, total: 1500000 }]), 11500000)
```

- [ ] Separate active sales from money events. A wrongly recorded receipt has an explicit correction that reduces net recorded inflow; actual cancellation retains received cash until an outgoing refund is recorded. Do not filter all cash events merely because invoice state is cancelled.
- [ ] Assert identical active turnover across Dashboard, Order, server summary and Excel for all-time and WIB period filters. Date-adjustment audit and cash-event reports keep their actual dates and must not be presented as the same metric as restated active sales.
- [ ] Exclude cancelled debt from active collection; expose refund due separately from amounts the customer owes. Preserve no-negative-remaining invariant.
- [ ] Refresh Invoice print and WhatsApp amount/items from the saved server result. Hide old invoice selection dialogs on deletion; do not print a stale active invoice after successful removal.
- [ ] Test WIB midnight, previous-month edits, incomplete paginated reads, anonymous customers, partially refunded cancellation and paid invoice edited below paid. Report load failure remains an error, not zero or stale totals.

## Task 5: Verify, Review, Push And Deploy

**Files:** Create `tools/financial-audit/INVOICE_RELEASE_2026-09-24.md`; update only explicit changed-file manifests and existing readiness evidence inputs. Do not alter the readiness validator to waive failures.

- [ ] Inspect current working tree and retain user changes. Obtain actual complete database/Storage backup and isolated restore evidence before any production migration. Verify owner recovery and account mapping without putting credentials in source or chat. Secure payment/lifecycle RPCs cannot activate under anonymous legacy identity.
- [ ] Validate candidate integration in a separate full Auth/REST/Storage test environment. Do not reset the existing minimal lab or infer end-to-end success from synthetic SQL identities.
- [ ] Run and retain these command results, plus the new real concurrency and browser workflows:

```sh
npm test
npm run test:security:sql
node --test tools/security-lab/payment-event-ledger.test.js
node --test tools/security-lab/invoice-lifecycle.test.js
npm run build
git diff --check
```

- [ ] Start the local test preview on a free port; verify desktop/mobile screenshots, editor overflow, delete confirmation, invoice print, all error states and the 10m/12m/10m scenario using synthetic data. Stop test-only processes when finished; provide a preview URL if it is intentionally left running for the user.
- [ ] Obtain whole-change independent review. Resolve important findings and rerun affected tests against final source hashes.
- [ ] Restore GitHub write access. Current connector metadata reports `push:false`; a 2026-09-24 native Git dry-run failed with invalid username/token. User must authenticate a permitted GitHub account through their normal credential UI; do not request pasted secrets or create unauthorized credentials.
- [ ] Inspect the existing Vercel project and deployment identity read-only. Package an explicit secret-free release; do not include unrelated preview account routes, candidate security migrations or every untracked file just because the user said all changes above.
- [ ] Commit only reviewed feature files and required already-deployed dependencies. Push non-force only after branch divergence checks and green gates. If push triggers auto-deploy, do it only after readiness is established. No global git credential edits or history rewrite.
- [ ] Deploy a compatible backend/frontend sequence with an identified rollback release; verify production bundles and a read-only UI smoke test. Do not perform real deletions/payments to prove the feature. Failed migration or smoke test prevents promotion and yields an honest blocker report.

## Completion Contract

The feature is complete only when Edit and Hapus work for legitimate cashier/admin sessions, the active-turnover example passes end to end, DP/refund handling is correct, Git push succeeds, and the production release is verified. A plan, candidate SQL, synthetic UI or successful build alone is not completion.

## Plan Self-Review

The five review-focus cases map to Tasks 1/3, 1/2/4, 2/3, 2/4, and 2/3 respectively.
All features in the approved scope are assigned above. Deployment has explicit
identity/backup/access prerequisites and cannot be represented as an unconditional
last command. Recommended execution: native in this task, with an independent
whole-change review before release; the tasks share the same financial contract.

No implementation, new feature test result, push or deployment is claimed by this
document. The next step is user review of this written plan and execution method.
