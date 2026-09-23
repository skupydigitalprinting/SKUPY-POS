# Financial Server Follow-up

## Approved Intent

Continue the previously approved atomic-payment, receipt-ledger, cancellation and
backup plan. The user explicitly requested fixing the remaining server failures.
The owner supplied a recovery email in the conversation; delivery/recovery and
mapping are not verified by that fact. Keep the email outside committed artifacts.

## Architecture And Boundaries

Reuse the existing authenticated pos_record_payment contract, private operation
receipts and invoice/row locks. Extend candidate SQL in a new non-automatic file
after 009; preserve prior candidate and exported-schema audit as evidence.
Receipt money must be posted on actual receipt date and tender, not moved to the
sale date or overwritten by cumulative paid. A posting failure must roll back
the whole payment, and exact operation replay must not duplicate any receipt.

Do not wire or activate this privileged RPC until identity, backup/restore and
real multi-connection tests are verified. No privileged anonymous function,
unverified legacy actor, production DML, historical mass correction, weaker ACL,
new password, or automatic refund is authorized by this implementation phase.
Keep cancellation of paid invoices blocked until explicit money disposition is
implemented and verified. Do not report blocked cancellation as a refund engine.

## Work

- [x] Reproduce existing SQL payment date/tender/rollback gaps.
- [x] Implement a separately testable candidate extension and regression tests
      for actual-date mixed-tender receipts, opening debts, replay and rollback.
- [x] Inspect production backup availability read-only.
- [ ] Obtain a complete database/Storage backup and isolated restore through an
      authorized export path.
- [x] Independently review candidate changes, run existing tests and new tests;
      exercise real local PostgreSQL concurrency if the pinned lab is available.
- [x] Check authentication/mapping/recovery, all legacy write paths and frontend
      integration readiness; do not silently turn missing evidence into success.
- [ ] Complete and verify full Auth/client integration, recovery and legacy
      workflows before a coordinated production cutover.
- [x] Preserve current working production while activation gates remain unmet.

## Rulings

- Ruling: continue in a secret-free temporary copy because the actual repository
  contains user-owned dirty work. Sync only reviewed changes; no blanket commit.
- Ruling: production inspection and candidate SQL development are independent.
  One bounded SQL implementer can work while the main task verifies backup gates.
- Ruling: supplying an email is permission to use it for owner recovery, not proof
  of mailbox delivery or completion and not permission to publish it in Git.
- Progress: the unchanged exported-schema audit reproduces 8 failures; root 509,
  security 107, existing operations 29 and existing real PostgreSQL concurrency
  12 all pass. Final candidate tests pass 23/23 PGlite and 9/9 real PostgreSQL.
  Independent review identified overnight initial-sale dates and NULL row
  predicates; both fixes passed independent re-review. Candidate-only sync is
  approved; production activation and frontend wiring are not.
- Backup inspection: scheduled physical backups exist, newest 2026-09-11
  17:44:20 UTC. Storage objects are excluded. Complete export/restore remains
  blocked on authorized database access and actual artifact verification.
