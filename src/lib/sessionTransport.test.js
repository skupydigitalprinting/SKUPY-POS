import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionTransport } from './sessionTransport.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('inactive transport rejects every URL before contacting the network', async () => {
  let calls = 0
  const transport = createSessionTransport(() => { calls++; return new Response() })
  for (const url of ['/rest/v1/orders', '/storage/v1/object/a', '/auth/v1/user']) {
    await assert.rejects(transport.fetch(url), { name: 'AbortError' })
  }
  assert.equal(calls, 0)
})

test('activation forwards input and options and returns an actual Response', async () => {
  const response = new Response('{"count":2}', { status: 201 })
  const input = new URL('https://example.test/rest/v1/orders')
  let received
  const transport = createSessionTransport((...args) => { received = args; return response })
  transport.activate()
  const result = await transport.fetch(input, { method: 'POST', body: 'payload' })
  assert.equal(result, response)
  assert.equal(received[0], input)
  assert.equal(received[1].method, 'POST')
  assert.equal(received[1].body, 'payload')
  assert.equal(received[1].signal.aborted, false)
  assert.deepEqual(await result.json(), { count: 2 })
})

test('invalidate aborts all pending reads and rejects even if fetch ignores signals', async () => {
  const requests = []
  const transport = createSessionTransport((input, { signal }) => {
    const request = deferred()
    requests.push({ ...request, signal })
    return request.promise
  })
  transport.activate()
  const first = assert.rejects(transport.fetch('/rest/v1/orders'), { name: 'AbortError' })
  const second = assert.rejects(transport.fetch('/storage/v1/object/a'), { name: 'AbortError' })
  transport.invalidate()
  assert.ok(requests.every(request => request.signal.aborted))
  await Promise.all([first, second])
  requests[0].resolve(new Response('old data'))
  requests[1].reject(new Error('late network failure'))
  await assert.rejects(transport.fetch('/rest/v1/orders'), { name: 'AbortError' })
  assert.equal(requests.length, 2)
})

test('a new activation rejects an old-generation Response even at the resolution boundary', async () => {
  const old = deferred()
  let calls = 0
  const transport = createSessionTransport(() => ++calls === 1 ? old.promise : new Response('new'))
  transport.activate()
  const rejected = assert.rejects(transport.fetch('/rest/v1/orders'), { name: 'AbortError' })
  old.resolve(new Response('old'))
  transport.activate()
  await rejected
  assert.equal(await (await transport.fetch('/rest/v1/orders')).text(), 'new')
})

test('caller cancellation combines with session cancellation without aborting siblings', async () => {
  const caller = new AbortController()
  const signals = []
  const transport = createSessionTransport((input, { signal }) => {
    signals.push(signal)
    return new Promise(() => {})
  })
  transport.activate()
  const first = assert.rejects(transport.fetch('/a', { signal: caller.signal }), { name: 'AbortError' })
  const second = assert.rejects(transport.fetch('/b'), { name: 'AbortError' })
  caller.abort(new Error('custom cancellation'))
  await first
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  transport.invalidate()
  await second
})

test('Request signals are honored, with init.signal overriding them', async () => {
  let calls = 0
  const caller = new AbortController()
  const request = new Request('https://example.test/a', { signal: caller.signal })
  caller.abort()
  const transport = createSessionTransport(() => { calls++; return new Response('ok') })
  transport.activate()
  await assert.rejects(transport.fetch(request), { name: 'AbortError' })
  await assert.rejects(transport.fetch('/a', { signal: caller.signal }), { name: 'AbortError' })
  assert.equal(calls, 0)
  await transport.fetch(request, { signal: new AbortController().signal })
  await transport.fetch(request, { signal: null })
  assert.equal(calls, 2)
})

test('active network errors propagate unchanged', async () => {
  const failure = new Error('offline')
  const transport = createSessionTransport(() => { throw failure })
  transport.activate()
  await assert.rejects(transport.fetch('/a'), error => error === failure)
})

test('synchronous abort plus fetch failure does not leave an unhandled rejection', async () => {
  const transport = createSessionTransport(() => {
    transport.invalidate()
    throw new Error('network failure after abort')
  })
  transport.activate()
  await assert.rejects(transport.fetch('/a'), { name: 'AbortError' })
  await new Promise(resolve => setImmediate(resolve))
})

test('request abort listeners are released when fetch finishes', async () => {
  const { getEventListeners } = await import('node:events')
  const signals = []
  const transport = createSessionTransport((input, { signal }) => {
    signals.push(signal)
    return new Response('ok')
  })
  transport.activate()
  const caller = new AbortController()
  for (let index = 0; index < 50; index++) await transport.fetch('/a', { signal: caller.signal })
  assert.ok(signals.every(signal => getEventListeners(signal, 'abort').length === 0))
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
  transport.invalidate()
  assert.ok(signals.every(signal => signal.aborted))
})

test('default fetch works without network access and accepts null RequestInit', async () => {
  const transport = createSessionTransport()
  transport.activate()
  assert.equal(await (await transport.fetch('data:text/plain,ok', null)).text(), 'ok')
})

test('missing AbortSignal.any fails clearly before network without dropping caller cancellation', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined })
  try {
    let calls = 0
    const transport = createSessionTransport(() => { calls++; return new Response('ok') })
    const caller = new AbortController()
    await assert.rejects(transport.fetch('/a', { signal: caller.signal }), { name: 'AbortError' })
    transport.activate()
    await assert.rejects(transport.fetch('/a', { signal: caller.signal }), { name: 'NotSupportedError' })
    assert.equal(calls, 0)
    caller.abort()
    await assert.rejects(transport.fetch('/a', { signal: caller.signal }), { name: 'AbortError' })
    assert.equal(calls, 0)
    assert.equal(await (await transport.fetch('/a')).text(), 'ok')
    assert.equal(calls, 1)
    transport.invalidate()
    await assert.rejects(transport.fetch('/a'), { name: 'AbortError' })
    assert.equal(calls, 1)
  } finally {
    Object.defineProperty(AbortSignal, 'any', descriptor)
  }
})
