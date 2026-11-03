import { readFile } from 'node:fs/promises'
import { fixture, actors, id, book, customer, order, debt } from './invoice-lifecycle-fixture.js'

export { actors, id, book, customer, order, debt }
const read = name => readFile(new URL(`../../supabase/security-stage2/${name}`, import.meta.url), 'utf8')
export const installDates = async db => {
  try { return await db.exec(await read('016_payment_dates.sql')) }
  catch (error) { delete error.query; throw error }
}

export async function datesFixture(t, { beforeDates, migrate = true, ...options } = {}) {
  const db = await fixture(t, { paid: 0, ...options })
  for (const name of ['012_payment_recovery.sql', '013_atomic_checkout.sql',
    '014_invoice_refund_account.sql', '015_daily_invoice_numbers.sql']) await db.exec(await read(name))
  if (beforeDates) await beforeDates(db)
  if (migrate && process.env.PAYMENT_DATES_BASELINE !== '015') await installDates(db)
  return db
}

export async function actorQuery(db, sql, params = [], { actor = 'cashier', role = 'authenticated', zone = 'UTC' } = {}) {
  return db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}`)
    await tx.query("SELECT set_config('TimeZone',$1,true)", [zone])
    await tx.query("SELECT set_config('request.jwt.claims',$1,true)",
      [JSON.stringify({ sub: actors[actor].auth, session_id: actors[actor].session })])
    return (await tx.query(sql, params)).rows
  })
}

export const submit = async (db, { op = id(800), day = '2026-09-01', amount = 100000,
  method = 'transfer', notes = 'Synthetic payment', legacy = false, ...actor } = {}) => {
  const sql = legacy ? 'SELECT public.pos_submit_payment($1,$2,$3,$4,$5) result'
    : 'SELECT public.pos_submit_payment_dated($1,$2,$3,$4,$5,$6::date) result'
  const params = [op, 'INV-LIFE', amount, method, notes]
  if (!legacy) params.push(day)
  return (await actorQuery(db, sql, params, actor))[0].result
}
export const payment = async db => (await db.query('SELECT *,paid_at::text AS paid_at FROM public.debt_payments ORDER BY id')).rows[0]
export const iso = value => new Date(value).toISOString()
export const correct = async (db, { op = id(900), paymentId, expected, day = '2026-09-02',
  reason = 'Correct bank statement day', ...actor } = {}) =>
  (await actorQuery(db, 'SELECT public.pos_change_payment_date($1,$2,$3::timestamptz,$4::date,$5) result',
    [op, paymentId, expected, day, reason], actor))[0].result

export async function allRows(db) {
  const result = {}
  const { rows: tables } = await db.query(`SELECT schemaname,tablename FROM pg_tables
    WHERE schemaname IN ('public','pos_security') ORDER BY schemaname,tablename`)
  for (const { schemaname, tablename } of tables) result[`${schemaname}.${tablename}`] =
    (await db.query(`SELECT to_jsonb(t) row FROM "${schemaname}"."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows
  return result
}
