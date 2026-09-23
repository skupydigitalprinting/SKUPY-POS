# Server payment follow-up: production readiness

## Read-only observations

On 2026-09-12, the authenticated Supabase dashboard for project
`ejqfttivgovhqhzkrncx` showed seven scheduled PHYSICAL backups. The newest was
`2026-09-11 17:44:20 UTC` (`2026-09-12 00:44:20 Asia/Jakarta`).
The dashboard explicitly says Storage objects are not included. Its available
action was Restore, not a downloadable logical dump. No restore was requested
or executed. Availability is not proof of a successful restoration drill.

The Connect > Direct view showed the project connection string with a
`[YOUR-PASSWORD]` placeholder. This session has no verified database credential
for a complete logical export. No password reset, credential creation, plan
upgrade, financial data write, or production SQL change was performed.

The owner supplied a recovery mailbox in the private conversation. The mailbox
is intentionally not reproduced here. This resolves the missing address only:
Auth identity mapping, email delivery, recovery and session revocation remain
unverified. It does not authorize substituting another identity or activating
the candidate login path.

## Current release

Production remains on the bounded frontend containment release documented in
`RELEASE_2026-09-12.md`. This follow-up changes candidate SQL/tests only, not
production authentication, payment RPC routing, grants, data, or ledger history.

The original exported-schema SQL audit was rerun unchanged: 10 tests, 2 passed,
8 failed. These are reproducible synthetic legacy-path defects, not eight
proven corrupt production transactions. Passing a new candidate suite does
not turn that baseline into a passing production audit.

## Activation remains blocked

- Obtain a complete authorized database and Storage-object export with an
  inventory and checksums, stored privately outside Git.
- Restore those actual artifacts into an isolated environment and verify
  records and file bytes. Synthetic backup tests are not this evidence.
- Verify the owner recovery flow, authenticated staff mappings and access rules.
- Integrate and test all payment writers, not just one RPC. Legacy checkout,
  corrections, cancellation and deletion must not bypass the receipt contract.
- Verify full client/Auth/REST workflows and a coordinated migration/rollback
  before production deployment. No automatic refunds or mass corrections.

Do not mark release-readiness gates as passed from this document; it records
observations and unresolved prerequisites, not a deploy approval.

## Candidate verification completed

The new `supabase/security-stage2/010_payment_event_ledger.sql` remains outside
automatic migrations. No client source or production data was changed.

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Existing application tests | 509 | 0 | 0 |
| Existing SQL security suite | 107 | 0 | 0 |
| Existing 009 operations | 29 | 0 | 0 |
| Existing real PostgreSQL concurrency | 12 | 0 | 0 |
| New 010 PGlite receipt ledger | 23 | 0 | 0 |
| New 010 real PostgreSQL concurrency | 9 | 0 | 0 |
| Unchanged exported-schema legacy audit | 2 | 8 | 0 |

The first security run lacked the existing lab dependency in the temporary copy;
after linking that local dependency, the complete rerun passed 107/107. Failed
intermediate candidate runs exposed variable-name collisions. Independent review
also reproduced a new overnight-sale timezone mismatch and nullable predicates
ignored by journal validation. These were fixed and independently rechecked;
there are no outstanding findings from that bounded review. It approves keeping
the candidate in source, not activation or a certification of the whole POS.

The nine real PostgreSQL cases use independent connections and observed lock
overlap in new, randomly named databases inside the pinned, loopback-only local
Supabase container. Identities and money are synthetic; this is not real Auth,
REST, Storage or a production workflow test. Cases cover mixed tenders, six
simultaneous identical retries, competing final balances, full rollback, separate
actors, concurrent deactivation, preserved attested DP, NULL journal attribution,
and overnight new sales. Cleanup inspection found zero `skupy_paytest_*` databases.

Commands:

```sh
node --test tools/security-lab/payment-event-ledger.test.js
SKUPY_RUN_LOCAL_PAYMENT_TESTS=1 node --test --test-concurrency=1 tools/security-lab/payment-event-concurrency-local.test.js
```

Final candidate SHA-256:

```text
4e39f137d2d93298bafe5e3fe05fae038cf62821dd5a68a69ce54563457e3cef  010_payment_event_ledger.sql
fe466fcc244646c661c3fb82fad798521c90cccccd19b5bd37fe2a29653e5baa  payment-event-ledger.test.js
2bfa8e3e8af8572fc460656e55e54884ad2466a6f5bae15a6ac028747205c29c  payment-event-concurrency-local.test.js
2b4d37f74bfe88254a4a18f099390de6af874d951db283cdefb595f54bbe168d  payment-event-postgres-fixture.js
```

See `../security-lab/payment-event-ledger-review.md` for supported receipt
eligibility, the narrow initial-DP attestation contract and intentional lifecycle
restrictions. Historical installments, refunds/cancellation, correction workflows
and complete client integration remain outstanding work.
