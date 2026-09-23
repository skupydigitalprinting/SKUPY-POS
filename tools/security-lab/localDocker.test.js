import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalDocker } from './localDocker.js'

const containerId = 'a'.repeat(64)
const containerName = 'supabase_db_skupy-auth-local'
const socket = '/synthetic-home/.docker/run/docker.sock'
const endpoint = `unix://${socket}`
const validInfo = () => ({
  Id: containerId,
  Config: { Labels: { 'com.supabase.cli.project': 'skupy-auth-local' } },
  State: { Running: true },
  HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] } },
})

function fixture({ info = validInfo(), stat = () => ({ isSocket: () => true }) } = {}) {
  const calls = [], checkedPaths = []
  const env = {
    PATH: '/synthetic-bin', DOCKER_HOST: 'tcp://remote.invalid:2376', DOCKER_CONTEXT: 'remote',
    DOCKER_TLS: '1', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/remote-certs',
  }
  const docker = createLocalDocker({
    home: '/synthetic-home', env,
    stat: path => { checkedPaths.push(path); return stat(path) },
    run: (bin, args, options) => {
      calls.push({ bin, args, options })
      if (args.includes('inspect')) return JSON.stringify([info])
      if (args[0] === 'status') return '{"API_URL":"http://127.0.0.1:54321"}'
      return 'synthetic output'
    },
  })
  return { docker, calls, env, checkedPaths }
}

test('Docker inspection and exec pin the local endpoint despite hostile ambient environment', () => {
  const { docker, calls, env, checkedPaths } = fixture()
  assert.equal(docker.inspect(containerName), containerId)
  assert.equal(docker.exec(containerId, ['psql', '-d', 'synthetic'], { input: 'SELECT 1', env: { DOCKER_HOST: 'tcp://override' } }), 'synthetic output')
  assert.deepEqual(calls[0].args, ['--host', endpoint, 'inspect', containerName])
  assert.deepEqual(calls[1].args, ['--host', endpoint, 'exec', '-i', containerId, 'psql', '-d', 'synthetic'])
  assert.equal(calls[1].options.input, 'SELECT 1')
  for (const call of calls) {
    assert.equal(call.options.env.PATH, '/synthetic-bin')
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
      assert.equal(call.options.env[key], undefined)
    }
  }
  assert.ok(checkedPaths.length >= 2)
  assert.ok(checkedPaths.every(path => path === socket))
  assert.equal(env.DOCKER_HOST, 'tcp://remote.invalid:2376', 'Do not mutate the parent environment')
})

test('Supabase status uses the same validated socket with no context or TLS overrides', () => {
  const { docker, calls, checkedPaths } = fixture()
  assert.deepEqual(docker.status('supabase-test', '/private/tmp/skupy-auth-local'), { API_URL: 'http://127.0.0.1:54321' })
  assert.equal(calls[0].bin, 'supabase-test')
  assert.deepEqual(calls[0].args, ['status', '--output', 'json', '--workdir', '/private/tmp/skupy-auth-local'])
  assert.equal(calls[0].options.env.DOCKER_HOST, endpoint)
  for (const key of ['DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) assert.equal(calls[0].options.env[key], undefined)
  assert.deepEqual(checkedPaths, [socket])
})

test('missing or non-socket endpoint prevents every subprocess dispatch', () => {
  for (const stat of [() => ({ isSocket: () => false }), () => { throw new Error('Missing socket') }]) {
    const { docker, calls } = fixture({ stat })
    assert.throws(() => docker.inspect(containerName))
    assert.throws(() => docker.status('supabase', '/private/tmp/skupy-auth-local'))
    assert.throws(() => docker.exec(containerId, ['dropdb', 'synthetic']))
    assert.deepEqual(calls, [])
  }
})

test('unsafe inspect responses cannot authorize later exec or cleanup', () => {
  const mutations = [
    info => { info.Config.Labels['com.supabase.cli.project'] = 'other' },
    info => { info.State.Running = false },
    info => { delete info.State },
    info => { info.HostConfig.PortBindings = {} },
    info => { info.HostConfig.PortBindings = { '5432/tcp': [] } },
    info => { info.HostConfig.PortBindings = { '5432/tcp': null } },
    info => { info.HostConfig.PortBindings['5432/tcp'][0].HostIp = '0.0.0.0' },
    info => { info.HostConfig.PortBindings['5432/tcp'].push({ HostIp: '::', HostPort: '54322' }) },
    info => { info.Id = containerName },
  ]
  for (const mutate of mutations) {
    const info = validInfo(); mutate(info)
    const { docker, calls } = fixture({ info })
    assert.throws(() => docker.inspect(containerName))
    assert.throws(() => docker.exec(containerId, ['dropdb', 'synthetic']))
    assert.equal(calls.length, 1)
  }
})

test('exec accepts only this helper instance inspected IDs, never mutable names or replacement IDs', () => {
  const { docker, calls } = fixture()
  assert.throws(() => docker.exec(containerId, ['createdb', 'synthetic']))
  docker.inspect(containerName)
  assert.throws(() => docker.exec(containerName, ['dropdb', 'synthetic']))
  assert.throws(() => docker.exec('b'.repeat(64), ['dropdb', 'synthetic']))
  assert.equal(calls.length, 1)
  docker.exec(containerId, ['dropdb', 'synthetic'])
  assert.equal(calls.length, 2)
})

test('reinspection of a captured ID fails if inspect returns a replacement', () => {
  const info = validInfo()
  const { docker } = fixture({ info })
  docker.inspect(containerName)
  info.Id = 'b'.repeat(64)
  assert.throws(() => docker.inspect(containerId))
})
