import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'

const container = 'supabase_db_skupy-auth-local'
const socket = `${homedir()}/.docker/run/docker.sock`
const dockerArgs = ['--host', `unix://${socket}`]
const dockerEnv = { ...process.env }
for (const key of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_TLS']) delete dockerEnv[key]
const id = n => `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const auth = id(1), session = id(2), admin = id(3), book = id(4), customer = id(5), order = id(6), debt = id(7)
const cashier = { auth, session, admin, name: 'Synthetic' }
const pic = { auth: id(10), session: id(11), admin: id(12), name: 'Synthetic PIC', role: 'staff' }
const outsider = { auth: id(20), session: id(21), admin: id(22), name: 'Synthetic Outsider', role: 'staff' }
const ownerA = { auth: id(0), session: id(31), admin: id(32), name: 'Synthetic Owner A', role: 'owner' }
const ownerB = { auth: id(40), session: id(41), admin: id(42), name: 'Synthetic Owner B', role: 'owner' }
const actorSettings = actor => `SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims='${JSON.stringify({ sub: actor.auth, session_id: actor.session })}';`
const setBooks = (books, version) => `SELECT public.pos_set_admin_books('${admin}',ARRAY[${books.map(b => `'${b}'`).join(',')}]::uuid[],${version});`
const lock = "pg_advisory_xact_lock(hashtextextended('skupy:business-invoice-binding:v1',0))"
const read = path => readFile(new URL(path, import.meta.url), 'utf8')

function verifyContainer(target = container) {
  assert.ok(statSync(socket).isSocket(), 'An actual local Docker Desktop Unix socket is required')
  const [info] = JSON.parse(execFileSync('docker', [...dockerArgs, 'inspect', target], { env: dockerEnv, encoding: 'utf8', timeout: 10000 }))
  assert.equal(info.Config.Labels['com.supabase.cli.project'], 'skupy-auth-local')
  assert.equal(info.State.Running, true)
  const ports = Object.values(info.HostConfig.PortBindings).flat()
  assert.ok(ports.length && ports.every(p => p.HostIp === '127.0.0.1'), 'Every published database port must be loopback-only')
  return info.Id
}

export async function fixture(run, { initialPaid = 0 } = {}) {
  assert.ok([0, 20].includes(initialPaid), 'Only explicit synthetic balances are supported')
  const containerId = verifyContainer()
  const name = `skupy_paytest_${randomBytes(10).toString('hex')}`
  assert.match(name, /^skupy_paytest_[a-f0-9]{20}$/)
  const args = [...dockerArgs, 'exec', '-i', containerId, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', name, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']
  const pending = new Set()
  const sql = input => execFileSync('docker', args, { env: dockerEnv, input, encoding: 'utf8', stdio: ['pipe','pipe','pipe'], timeout: 15000 }).trim()
  const query = (input, worker) => {
    if (worker !== undefined) assert.match(worker, /^[a-z0-9_]+$/)
    const job = new Promise(resolve => {
      const child = execFile('docker', args, { env: dockerEnv, encoding: 'utf8', timeout: 25000 }, (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout.trim(), stderr }))
      child.stdin.on('error', () => {})
      child.stdin.end(`SET statement_timeout='12s'; SET lock_timeout='10s';
        ${worker === undefined ? '' : `SET application_name='${name}_${worker}';`} ${input}`)
    })
    pending.add(job); job.then(() => pending.delete(job))
    return job
  }
  const asActor = (actor, worker, input) => query(`BEGIN ISOLATION LEVEL READ COMMITTED; ${actorSettings(actor)} ${input} COMMIT;`, String(worker))
  const pay = (op, amount, worker, method = 'cash', actor = cashier) => asActor(actor, worker,
    `SELECT public.pos_record_payment('${op}','SYNTHETIC-1',${amount},'${method}','');`)
  const readBooks = async actor => {
    const result = await asActor(actor, 'read_books', `SELECT public.pos_admin_book_access('${admin}');`)
    assert.equal(result.ok, true, result.stderr)
    return JSON.parse(result.stdout)
  }
  async function waitBlocked(workers, blockers) {
    for (const label of [...workers, ...(blockers || [])]) assert.match(label, /^[a-z0-9_]+$/)
    const names = labels => labels.map(label => `'${name}_${label}'`).join(',')
    const deadline = Date.now() + 6000
    let blocked = 0
    do {
      blocked = Number(sql(`SELECT count(*) FROM pg_stat_activity a WHERE a.datname=current_database()
        AND a.application_name IN (${names(workers)}) AND a.wait_event_type='Lock'
        AND cardinality(pg_blocking_pids(a.pid))>0
        ${blockers ? `AND EXISTS (SELECT 1 FROM pg_stat_activity b WHERE b.datname=current_database()
          AND b.pid=ANY(pg_blocking_pids(a.pid)) AND b.application_name IN (${names(blockers)}))` : ''}`))
      if (blocked === workers.length) break
      await new Promise(resolve => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    assert.equal(blocked, workers.length, `Independent PostgreSQL backends must overlap: ${workers.join(', ')}`)
  }

  async function gate(setup, schedule) {
    const holder = spawn('docker', args, { env: dockerEnv, stdio: ['pipe','pipe','pipe'] })
    let output = '', errors = ''
    const closed = new Promise(resolve => {
      holder.on('error', e => resolve({ code: -1, errors: e.message }))
      holder.on('close', code => resolve({ code, errors }))
    })
    holder.stderr.on('data', chunk => { errors += chunk })
    holder.stdin.on('error', () => {})
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local lock holder did not become ready')), 5000)
      holder.stdout.on('data', chunk => {
        output += chunk
        if (output.includes('SKUPY_GATE_READY')) { clearTimeout(timer); resolve() }
      })
      closed.then(result => { clearTimeout(timer); reject(new Error(`Lock holder exited: ${result.code}`)) })
    })
    let jobs = []
    try {
      holder.stdin.write(`SET application_name='${name}_gate'; SET idle_in_transaction_session_timeout='15s';
        SET statement_timeout='12s'; SET lock_timeout='10s'; BEGIN ISOLATION LEVEL READ COMMITTED; ${setup}\n\\echo SKUPY_GATE_READY\n`)
      await ready
      jobs = await schedule()
      holder.stdin.end('COMMIT;\n\\q\n')
      assert.equal((await closed).code, 0, errors)
      return await Promise.all(jobs)
    } finally {
      if (!holder.stdin.writableEnded) holder.stdin.end('ROLLBACK;\n\\q\n')
      await closed
      await Promise.all(jobs)
    }
  }
  const competing = requests => gate(`SELECT ${lock};`, async () => {
    const jobs = requests.map((r, i) => pay(r.op, r.amount, `worker_${i}`, r.method, r.actor))
    await waitBlocked(requests.map((_, i) => `worker_${i}`))
    return jobs
  })

  let created = false, marked = false
  try {
    // Exclusive new database. Never reuse or reset an existing lab/database.
    execFileSync('docker', [...dockerArgs, 'exec', containerId, 'createdb', '-U', 'postgres', '-T', 'template0', name], { env: dockerEnv, timeout: 15000, stdio: 'pipe' })
    created = true
    sql(`CREATE SCHEMA local_test_guard; CREATE TABLE local_test_guard.run(name text PRIMARY KEY); INSERT INTO local_test_guard.run VALUES('${name}');`)
    marked = true
    assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated') AND NOT rolsuper AND NOT rolbypassrls"), '2')
    sql(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users,created_at timestamptz);
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;`)
    sql(await read('business-schema.sql'))
    for (const file of ['001_identity_bridge.sql','002_username_login.sql','003_password_recovery.sql','004_password_reset_status.sql','005_staff_directory.sql']) {
      sql(await read(`../../supabase/security-stage2/${file}`))
    }
    sql(`INSERT INTO auth.users VALUES('${auth}'); INSERT INTO auth.sessions VALUES('${session}','${auth}',clock_timestamp());
      INSERT INTO public.admins(id,username,name,password,role) VALUES('${admin}','synthetic','Synthetic','not-a-real-password','owner');
      INSERT INTO pos_security.user_access(auth_user_id,admin_id,role,active,login_username) VALUES('${auth}','${admin}','staff',true,'synthetic');
      INSERT INTO public.accounts(code,name,type,normal) SELECT code,code,'asset','debit' FROM unnest(ARRAY['1000','1100','1200','4000']) code;
      INSERT INTO public.books(id,name) VALUES('${book}','Synthetic');
      INSERT INTO public.admin_book_access(admin_id,book_id) VALUES('${admin}','${book}');
      INSERT INTO public.customers(id,name,owner_user_id,book_id) VALUES('${customer}','Synthetic','${admin}','${book}');
      INSERT INTO public.transactions(id,invoice_no,customer_id,cashier_id,book_id,total,paid,dp,remaining,status,created_at)
        VALUES('${order}','SYNTHETIC-1','${customer}','${admin}','${book}',100,${initialPaid},${initialPaid},${100-initialPaid},'pending','2026-08-20T10:00:00Z');
      INSERT INTO public.debts(id,invoice_no,customer_id,transaction_id,cashier_id,book_id,total_debt,paid,remaining)
        VALUES('${debt}','SYNTHETIC-1','${customer}','${order}','${admin}','${book}',100,${initialPaid},${100-initialPaid});`)
    // Synthetic identities only in this exclusive database; reuse existing SQL roles.
    for (const actor of [pic, outsider, ownerA, ownerB]) {
      sql(`INSERT INTO auth.users VALUES('${actor.auth}');
        INSERT INTO auth.sessions VALUES('${actor.session}','${actor.auth}',clock_timestamp());
        INSERT INTO public.admins(id,username,name,password,role)
          VALUES('${actor.admin}','synthetic_${actor.admin}','${actor.name}','not-a-real-password','owner');
        INSERT INTO pos_security.user_access(auth_user_id,admin_id,role,active,login_username)
          VALUES('${actor.auth}','${actor.admin}','${actor.role}',true,'synthetic_${actor.admin}');`)
    }
    sql(`INSERT INTO public.admin_book_access(admin_id,book_id) VALUES('${pic.admin}','${book}'),('${outsider.admin}','${book}');
      UPDATE public.customers SET owner_user_id='${pic.admin}' WHERE id='${customer}';`)
    sql(await read('../../supabase/security-stage2/006_business_access.sql'))
    sql(`SELECT public.recalculate_customer_summary('${customer}');`)
    sql(await read('../../supabase/security-stage2/009_business_operations.sql'))
    if (process.env.PAYMENT_LEDGER_BASELINE !== '009') sql(await read('../../supabase/security-stage2/010_payment_event_ledger.sql'))
    const balances = () => JSON.parse(sql(`SELECT json_build_object('paid',t.paid,'remaining',t.remaining,'debtPaid',d.paid,'debtRemaining',d.remaining,
      'customerDebt',c.total_debt,'payments',(SELECT count(*) FROM public.debt_payments),'operations',(SELECT count(*) FROM pos_security.payment_operations),
      'cash',(SELECT coalesce(sum(amount),0) FROM public.cash_movements))
      FROM public.transactions t JOIN public.debts d ON d.transaction_id=t.id JOIN public.customers c ON c.id=t.customer_id WHERE t.id='${order}'`))
    await run({ pay, competing, balances, sql, query, asActor, gate, waitBlocked, readBooks })
  } finally {
    await Promise.all([...pending])
    if (created) {
      assert.ok(marked, `Unmarked test database retained for manual inspection: ${name}`)
      assert.equal(verifyContainer(containerId), containerId, 'Never clean up a replacement container')
      assert.equal(sql('SELECT name FROM local_test_guard.run'), name)
      execFileSync('docker', [...dockerArgs, 'exec', containerId, 'dropdb', '-U', 'postgres', name], { env: dockerEnv, timeout: 15000, stdio: 'pipe' })
    }
  }
}

export { id, auth, session, admin, book, customer, order, debt, cashier, pic, outsider, ownerA }
