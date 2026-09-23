// Canonical real-callback payment suite, shared with npm test.
// The historical audit had 95 cases (39 passing, 56 failing), documented in
// AUDIT_2026-09-11.md. Its assertions assumed corrections wrote history before
// reading balances and a missing debt caused a NULL debt_id insert. Containment
// now rejects these before dispatch; selected writes must return matching rows.
// paymentIntegrity retains the baseline invariants, updates those contracts and
// adds malformed-response, retry, tender, deletion, status, and drift regressions.
// No failure is skipped, expected, or suppressed by this entry point.
import '../../tests/paymentIntegrity.test.js'
