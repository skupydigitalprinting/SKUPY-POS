import test from 'node:test'
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
const enabled = process.env.SKUPY_RUN_LOCAL_PAYMENT_TESTS === '1'

function verifyContainer(target = container) {
  assert.ok(statSync(socket).isSocket(), 'An actual local Docker Desktop Unix socket is required')
  const [info] = JSON.parse(execFileSync('docker', [...dockerArgs, 'inspect', target], { env: dockerEnv, encoding: 'utf8', timeout: 10000 }))
  assert.equal(info.Config.Labels['com.supabase.cli.project'], 'skupy-auth-local')
  assert.equal(info.State.Running, true)
  const ports = Object.values(info.HostConfig.PortBindings).flat()
  assert.ok(ports.length && ports.every(p => p.HostIp === '127.0.0.1'), 'Every published database port must be loopback-only')
  return info.Id
}

async function fixture(run) {
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
      INSERT INTO public.transactions(id,invoice_no,customer_id,cashier_id,book_id,total,paid,dp,remaining,status)
        VALUES('${order}','SYNTHETIC-1','${customer}','${admin}','${book}',100,20,20,80,'pending');
      INSERT INTO public.debts(id,invoice_no,customer_id,transaction_id,cashier_id,book_id,total_debt,paid,remaining)
        VALUES('${debt}','SYNTHETIC-1','${customer}','${order}','${admin}','${book}',100,20,80);`)
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
    const balances = () => JSON.parse(sql(`SELECT json_build_object('paid',t.paid,'remaining',t.remaining,'debtPaid',d.paid,'debtRemaining',d.remaining,
      'customerDebt',c.total_debt,'payments',(SELECT count(*) FROM public.debt_payments),'operations',(SELECT count(*) FROM pos_security.payment_operations),
      'cash',(SELECT sum(amount) FROM public.cash_movements WHERE source_type='sale'))
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

const options = { skip: !enabled, timeout: 90000 }
test('real PostgreSQL: overlapping identical retries produce exactly one payment', options, async () => {
  await fixture(async ({ competing, balances }) => {
    const results = await competing(Array.from({ length: 6 }, () => ({ op: id(100), amount: 30 })))
    for (const r of results) { assert.equal(r.ok, true, r.stderr); assert.deepEqual(JSON.parse(r.stdout), { invoice_no: 'SYNTHETIC-1', amount: 30, paid: 50, remaining: 50, status: 'aktif' }) }
    assert.deepEqual(balances(), { paid: 50, remaining: 50, debtPaid: 50, debtRemaining: 50, customerDebt: 50, payments: 1, operations: 1, cash: 50 })
  })
})

test('real PostgreSQL: competing final-balance payments admit one writer only', options, async () => {
  await fixture(async ({ competing, balances }) => {
    const results = await competing([{ op: id(100), amount: 80 }, { op: id(101), amount: 80 }])
    assert.equal(results.filter(r => r.ok).length, 1)
    assert.match(results.find(r => !r.ok).stderr, /22023/)
    assert.deepEqual(balances(), { paid: 100, remaining: 0, debtPaid: 100, debtRemaining: 0, customerDebt: 0, payments: 1, operations: 1, cash: 100 })
  })
})

test('real PostgreSQL: competing partial receipts accumulate without lost updates', options, async () => {
  await fixture(async ({ competing, balances }) => {
    const results = await competing([{ op: id(100), amount: 30 }, { op: id(101), amount: 40 }])
    for (const r of results) assert.equal(r.ok, true, r.stderr)
    assert.deepEqual(balances(), { paid: 90, remaining: 10, debtPaid: 90, debtRemaining: 10, customerDebt: 10, payments: 2, operations: 2, cash: 90 })
  })
})

test('real PostgreSQL: journal failure rolls back balances, receipt and operation', options, async () => {
  await fixture(async ({ pay, balances, sql }) => {
    const before = balances()
    sql(`CREATE FUNCTION public.synthetic_reject_posting() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic journal failure'; END $$;
      CREATE TRIGGER synthetic_reject_posting BEFORE INSERT ON public.accounting_entries FOR EACH ROW EXECUTE FUNCTION public.synthetic_reject_posting();`)
    const result = await pay(id(100), 30, 0)
    assert.equal(result.ok, false)
    assert.match(result.stderr, /23514:.*payment rejected/)
    assert.match(result.stderr, /acc_fn_post_transaction dilewati: synthetic journal failure/)
    assert.deepEqual(balances(), before)
    sql('DROP TRIGGER synthetic_reject_posting ON public.accounting_entries;')
    const recovered = await pay(id(100), 30, 1)
    assert.equal(recovered.ok, true, recovered.stderr)
    assert.deepEqual(balances(), { paid: 50, remaining: 50, debtPaid: 50, debtRemaining: 50, customerDebt: 50, payments: 1, operations: 1, cash: 50 })
  })
})

test('real PostgreSQL: own cashier and independent PIC collect while same-book outsider is denied', options, async () => {
  await fixture(async ({ competing, balances, asActor, sql }) => {
    const visibility = await asActor(pic, 'visibility', `SELECT count(*) FROM public.transactions WHERE id='${order}';`)
    assert.equal(visibility.ok, true, visibility.stderr)
    assert.equal(visibility.stdout, '0', 'PIC must not gain direct access to another cashier order')
    const results = await competing([
      { op: id(100), amount: 30 },
      { op: id(101), amount: 40, actor: pic },
      { op: id(102), amount: 1, actor: outsider },
    ])
    for (const result of results.slice(0, 2)) assert.equal(result.ok, true, result.stderr)
    assert.equal(results[2].ok, false)
    assert.match(results[2].stderr, /42501/)
    assert.equal(results[2].stdout, '', 'Denied collector receives no receipt')
    assert.deepEqual(balances(), { paid: 90, remaining: 10, debtPaid: 90, debtRemaining: 10, customerDebt: 10, payments: 2, operations: 2, cash: 90 })
    assert.deepEqual(JSON.parse(sql(`SELECT json_agg(json_build_object('actor',o.actor_auth_user_id,
      'cashier',p.cashier_id,'name',p.cashier_name,'amount',p.amount) ORDER BY p.amount)
      FROM pos_security.payment_operations o JOIN public.debt_payments p ON p.id=o.payment_id`)), [
      { actor: auth, cashier: admin, name: 'Synthetic', amount: 30 },
      { actor: pic.auth, cashier: pic.admin, name: pic.name, amount: 40 },
    ])
    assert.equal(sql(`SELECT cashier_id FROM public.transactions WHERE id='${order}'`), admin)
  })
})

test('real PostgreSQL: independent authorized actors cannot share an operation receipt', options, async () => {
  await fixture(async ({ competing, pay, balances, sql }) => {
    const actors = [cashier, pic]
    const results = await competing(actors.map(actor => ({ op: id(100), amount: 30, actor })))
    assert.equal(results.filter(r => r.ok).length, 1)
    const winner = results.findIndex(r => r.ok), loser = 1 - winner
    assert.match(results[loser].stderr, /42501/)
    assert.equal(results[loser].stdout, '')
    assert.equal(sql(`SELECT actor_auth_user_id FROM pos_security.payment_operations WHERE operation_id='${id(100)}'`), actors[winner].auth)
    const retry = await pay(id(100), 30, 'retry', 'cash', actors[winner])
    assert.equal(retry.ok, true, retry.stderr)
    assert.deepEqual(JSON.parse(retry.stdout), JSON.parse(results[winner].stdout))
    assert.deepEqual(balances(), { paid: 50, remaining: 50, debtPaid: 50, debtRemaining: 50, customerDebt: 50, payments: 1, operations: 1, cash: 50 })
  })
})

for (const change of ['mapping deactivation', 'book removal']) {
  test(`real PostgreSQL: committed ${change} denies a payment waiting on authorization`, options, async () => {
    await fixture(async ({ gate, waitBlocked, pay, balances, sql, readBooks }) => {
      const before = balances()
      const mutation = change === 'mapping deactivation'
        ? `UPDATE pos_security.user_access SET active=false WHERE auth_user_id='${auth}';`
        : `${actorSettings(ownerB)} ${setBooks([], 0)}`
      const [result] = await gate(mutation, async () => {
        const payment = pay(id(100), 30, 'waiting_payment')
        await waitBlocked(['waiting_payment'], ['gate'])
        return [payment]
      })
      assert.equal(result.ok, false)
      assert.match(result.stderr, /42501/)
      assert.equal(result.stdout, '')
      assert.deepEqual(balances(), before, 'Denial rolls back the operation reservation and all money writes')
      if (change === 'mapping deactivation') {
        assert.equal(sql(`SELECT active FROM pos_security.user_access WHERE auth_user_id='${auth}'`), 'f')
      } else {
        assert.deepEqual(await readBooks(ownerB), { admin_id: admin, book_ids: [], version: 1 })
      }
    })
  })

  test(`real PostgreSQL: ${change} waits for an already-authorized payment then fences new payments`, options, async () => {
    await fixture(async ({ gate, waitBlocked, pay, asActor, query, balances, readBooks }) => {
      const [payment, revoked] = await gate(`SELECT ${lock};`, async () => {
        const payment = pay(id(100), 30, 'first_payment')
        await waitBlocked(['first_payment'], ['gate'])
        const revoked = change === 'mapping deactivation'
          ? query(`BEGIN; UPDATE pos_security.user_access SET active=false WHERE auth_user_id='${auth}'; COMMIT;`, 'revoke')
          : asActor(ownerB, 'revoke', setBooks([], 0))
        await waitBlocked(['revoke'], ['first_payment'])
        return [payment, revoked]
      })
      assert.equal(payment.ok, true, payment.stderr)
      assert.equal(revoked.ok, true, revoked.stderr)
      const after = balances()
      assert.deepEqual(after, { paid: 50, remaining: 50, debtPaid: 50, debtRemaining: 50, customerDebt: 50, payments: 1, operations: 1, cash: 50 })
      const denied = await pay(id(101), 10, 'after_revoke')
      assert.equal(denied.ok, false)
      assert.match(denied.stderr, /42501/)
      assert.deepEqual(balances(), after)
      if (change === 'book removal') {
        assert.deepEqual(await readBooks(ownerB), { admin_id: admin, book_ids: [], version: 1 })
      }
    })
  })
}

test('real PostgreSQL: two owners race one book version with honest reads and no direct bypass', options, async () => {
  await fixture(async ({ gate, waitBlocked, asActor, readBooks, balances }) => {
    const before = balances()
    assert.deepEqual(await readBooks(ownerA), { admin_id: admin, book_ids: [book], version: 0 })
    const results = await gate(`SELECT 1 FROM pos_security.user_access WHERE auth_user_id='${auth}' FOR UPDATE;`, async () => {
      const jobs = [asActor(ownerA, 'owner_a', setBooks([], 0)), asActor(ownerB, 'owner_b', setBooks([book], 0))]
      await waitBlocked(['owner_a', 'owner_b'])
      return jobs
    })
    assert.equal(results.filter(r => r.ok).length, 1)
    assert.match(results.find(r => !r.ok).stderr, /40001/)
    const expected = JSON.parse(results.find(r => r.ok).stdout)
    assert.deepEqual(expected, { admin_id: admin, book_ids: results[0].ok ? [] : [book], version: 1 })
    assert.deepEqual(await readBooks(ownerA), expected)
    assert.deepEqual(await readBooks(ownerB), expected)
    for (const [actor, command] of [
      [cashier, setBooks([], 1)],
      [cashier, `SELECT public.pos_admin_book_access('${admin}');`],
      [ownerA, 'SELECT * FROM pos_security.admin_book_revisions;'],
      [ownerA, `INSERT INTO public.admin_book_access(admin_id,book_id) VALUES('${outsider.admin}','${book}');`],
      [ownerA, `UPDATE public.admin_book_access SET book_id=book_id WHERE admin_id='${admin}';`],
      [ownerA, `DELETE FROM public.admin_book_access WHERE admin_id='${admin}';`],
    ]) {
      const denied = await asActor(actor, 'bypass', command)
      assert.equal(denied.ok, false)
      assert.match(denied.stderr, /42501/)
    }
    assert.deepEqual(await readBooks(ownerB), expected)
    assert.deepEqual(balances(), before)
  })
})

test('real PostgreSQL: delayed owner grant cannot undo a newer confirmed no-op clear', options, async () => {
  await fixture(async ({ gate, waitBlocked, asActor, readBooks, balances }) => {
    const before = balances()
    const cleared = await asActor(ownerB, 'initial_clear', setBooks([], 0))
    assert.equal(cleared.ok, true, cleared.stderr)
    assert.deepEqual(await readBooks(ownerA), { admin_id: admin, book_ids: [], version: 1 })
    // Owner A sorts before the target: stall only A, without locking B's target.
    assert.ok(ownerA.auth < auth)
    const [delayed] = await gate(`SELECT 1 FROM pos_security.user_access WHERE auth_user_id='${ownerA.auth}' FOR UPDATE;`, async () => {
      const delayed = asActor(ownerA, 'delayed_grant', setBooks([book], 1))
      await waitBlocked(['delayed_grant'], ['gate'])
      const confirmed = await asActor(ownerB, 'new_clear', setBooks([], 1))
      assert.equal(confirmed.ok, true, confirmed.stderr)
      assert.deepEqual(JSON.parse(confirmed.stdout), { admin_id: admin, book_ids: [], version: 2 })
      assert.deepEqual(await readBooks(ownerB), { admin_id: admin, book_ids: [], version: 2 })
      return [delayed]
    })
    assert.equal(delayed.ok, false)
    assert.match(delayed.stderr, /40001/)
    assert.equal(delayed.stdout, '')
    assert.deepEqual(await readBooks(ownerA), { admin_id: admin, book_ids: [], version: 2 })
    assert.deepEqual(balances(), before)
  })
})
