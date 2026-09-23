import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const businessGroups = {
  sharedcatalog: ['products', 'product_categories'],
  owntransactions: ['transactions', 'order_customer_changes'],
  customerPIC: ['customers', 'debts', 'debt_payments', 'customer_owner_changes', 'receivable_customer_changes'],
  accounting: ['accounts', 'accounting_entries', 'cash_movements', 'expenses', 'purchases', 'suppliers',
    'supplier_debts', 'supplier_debt_payments', 'bank_loans', 'bank_loan_payments', 'employees',
    'employee_cash_advances', 'employee_cash_advance_payments', 'expense_categories', 'assets',
    'asset_categories', 'asset_purchase_payments', 'asset_sales', 'prepaid_rents', 'prepaid_rent_schedules',
    'liabilities', 'credibook_income', 'migration_details'],
  ownerconfig: ['settings', 'admins', 'books', 'admin_book_access', 'admin_bank_accounts',
    'admin_invoice_profiles', 'store_locations', 'store_contacts', 'store_bank_accounts'],
}
export const businessTables = Object.values(businessGroups).flat().sort()
const identifier = value => `"${value.replaceAll('"', '""')}"`
const hash = value => createHash('sha256').update(value).digest('hex')

// Metadata is supplied explicitly; this helper never connects to any database.
// Function and trigger bodies are copied verbatim, not transformed with regexes.
export function buildBusinessFixture(catalog) {
  assert.deepEqual(catalog.tables.map(t => t.name).sort(), businessTables)
  assert.equal(catalog.functions.length, 26)
  assert.equal(catalog.triggers.length, 17)
  assert.equal(catalog.enums, null, 'Review new enum metadata before regenerating')
  assert.equal(catalog.sequences, null, 'Review new sequence metadata before regenerating')
  const lines = ['-- GENERATED schema-only fixture; never execute against a real project.',
    '-- No table records, Auth accounts, Storage records, or credentials are exported.',
    '-- Core gen_random_uuid() suffices; unrelated platform extensions are not installed.',
    '-- Event-trigger function is retained; no event-trigger binding was supplied.',
    'BEGIN;', 'SET LOCAL search_path = public, pg_catalog;']
  for (const table of catalog.tables) {
    const columns = table.columns.map(column => {
      assert.equal(column.identity, '', 'Unsupported identity column')
      assert.equal(column.generated, '', 'Unsupported generated column')
      return `  ${identifier(column.name)} ${column.type}${column.default == null ? '' : ` DEFAULT ${column.default}`}${column.notnull ? ' NOT NULL' : ''}`
    })
    lines.push(`CREATE TABLE public.${identifier(table.name)} (\n${columns.join(',\n')}\n);`)
  }
  // All primary/unique keys precede FKs, so alphabetical table order is safe.
  for (const foreign of [false, true]) for (const table of catalog.tables) {
    for (const constraint of table.constraints.filter(c => (c.type === 'f') === foreign)) {
      lines.push(`ALTER TABLE public.${identifier(table.name)} ADD CONSTRAINT ${identifier(constraint.name)} ${constraint.definition};`)
    }
  }
  const constraintIndexes = new Set(catalog.tables.flatMap(t => t.constraints.filter(c => ['p', 'u', 'x'].includes(c.type)).map(c => c.name)))
  for (const index of catalog.indexes) {
    assert.equal(index.schemaname, 'public')
    if (!constraintIndexes.has(index.indexname)) lines.push(`${index.indexdef};`)
  }
  for (const fn of catalog.functions) {
    assert.equal(fn.owner, 'postgres', 'Review unexpected definer owner')
    lines.push(`${fn.definition.trimEnd()};`)
  }
  for (const trigger of catalog.triggers) lines.push(`${trigger.definition};`)
  for (const table of catalog.tables) if (table.rls) lines.push(`ALTER TABLE public.${identifier(table.name)} ENABLE ROW LEVEL SECURITY;`)
  const policies = catalog.policies.filter(p => p.schemaname === 'public')
  for (const policy of policies) {
    assert.ok(businessTables.includes(policy.tablename))
    const roles = policy.roles.map(role => role === 'public' ? 'PUBLIC' : identifier(role)).join(', ')
    lines.push(`CREATE POLICY ${identifier(policy.policyname)} ON public.${identifier(policy.tablename)} AS ${policy.permissive} FOR ${policy.cmd} TO ${roles}${policy.qual == null ? '' : ` USING (${policy.qual})`}${policy.with_check == null ? '' : ` WITH CHECK (${policy.with_check})`};`)
  }
  lines.push('COMMIT;', '')
  const manifest = {
    description: 'Schema-only metadata; ACLs in tests are intentionally adversarial, not a live ACL export.',
    tables: catalog.tables,
    indexes: catalog.indexes,
    functions: catalog.functions.map(fn => ({ name: fn.name, identity: fn.identity, definition: fn.definition, sha256: hash(fn.definition) })),
    triggers: catalog.triggers,
    publicPolicyCount: policies.length,
  }
  return { sql: lines.join('\n'), manifest }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, 'Usage: node business-fixture.js /absolute/path/to/catalog.json')
  const catalog = JSON.parse(await readFile(process.argv[2], 'utf8'))
  const fixture = buildBusinessFixture(catalog)
  await writeFile(new URL('business-schema.sql', import.meta.url), fixture.sql)
  await writeFile(new URL('business-manifest.json', import.meta.url), `${JSON.stringify(fixture.manifest, null, 2)}\n`)
  console.log(`Generated schema only: ${businessTables.length} tables, 26 functions, 17 triggers; no data.`)
}
