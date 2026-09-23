# Supplied-artifact backup bundles

This tool packages an already supplied, nonempty database file and supplied
Storage files. It does not connect to production, run a production export, or
prove that the supplied artifacts are a complete or consistent production
snapshot. A successful checksum check is not production cutover approval.

## Inputs and commands

Run from the repository root. Use an existing private working directory whose
parent chain you control. Output directories must not already exist.

```sh
node tools/backup/cli.mjs pack --database /private/work/source.dump --storage /private/work/storage --inventory /private/work/inventory.json --output /private/work/bundle --project local-synthetic
node tools/backup/cli.mjs verify /private/work/bundle
node tools/backup/cli.mjs restore-files /private/work/bundle --output /private/work/restored
```

The Storage directory contains object paths under `products`, `logos`, and
`invoices`. Inventory JSON is an array such as
`[{"bucket":"products","name":"sample.png","size":26}]`; provide `[]` for no
objects. The inventory must exactly match supplied files and sizes. Empty
directories are not Storage objects and are not preserved.

The manifest records SHA-256 hashes, sizes, and caller-supplied project metadata.
Verification rejects missing, extra, changed, or unsafe file paths. Checksums
detect disagreement with the manifest, not authenticity: someone able to replace
both files and manifest can produce another valid bundle. Packaging does not
validate database dump format, export coverage, or cross-service consistency.
Treat bundle contents as sensitive; there is no encryption in this tool.

## Filesystem safety

- Pack output must be outside its Storage source. Restore output must be outside
  its source bundle, including through symlinked output parents.
- Existing output paths are never reused. Files are created exclusively; new
  directories use mode `0700` and files use `0600`.
- The canonical output parent must be owned by the current user and must not be
  group/world writable. Direct output into a shared temporary directory is
  refused; create a private working directory first. POSIX ownership is required.
- Rollback checks the device/inode identities of the created directory and its
  parent against held directory handles. On a detected replacement, it refuses
  cleanup and reports the failure. The replacement and any renamed partial
  directory are left for inspection; do not blindly delete the reported path.

Keep source files and all relevant directories stable throughout each operation.
These pathname-based checks are not an atomic filesystem sandbox. They cannot
protect against a hostile same-user/root process changing paths between checks
and filesystem calls, or access granted through ACLs not reflected by mode bits.
Use a controlled parent chain, no concurrent directory mutators, and a filesystem
with reliable POSIX identity/permission semantics. Interrupted processes or
refused/failed cleanup can leave partial directories, which are not valid backups.

## Local drill and limits

```sh
node --test tools/security-lab/backup.test.js
SKUPY_RUN_LOCAL_BACKUP_TESTS=1 node --test tools/security-lab/backup-local.test.js
```

The opt-in drill checks the known `supabase_db_skupy-auth-local` container's
`com.supabase.cli.project=skupy-auth-local` label and loopback-only published
bindings before database writes. It creates randomly named synthetic databases,
runs real `pg_dump`/`pg_restore`, checks synthetic row totals, and compares supplied
Storage-file bytes. The restore-target validator only permits a named
`skupy_restore_<hex>` database at `127.0.0.1:54322` as `postgres`, without URL
query parameters or fragments. The drill executes in the known container and
cleans up the databases it created.

Passing this drill does not test a production snapshot, Supabase Storage service
upload/metadata restoration, Auth recovery, business RLS, ownership/privilege
restoration, or application-wide recovery. The CLI restores Storage files to a
new local directory only; it does not restore a database or contact Storage.
Production export completeness, recovery procedures, and release authorization
remain separate gates.
