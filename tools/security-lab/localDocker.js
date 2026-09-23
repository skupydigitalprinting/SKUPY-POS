import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'

export function createLocalDocker({ run = execFileSync, env = process.env, stat = statSync, home = homedir() } = {}) {
  const socket = `${home}/.docker/run/docker.sock`
  const endpoint = `unix://${socket}`
  const dockerEnv = { ...env }
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[key]
  const inspected = new Set()
  const checkSocket = () => assert.ok(stat(socket).isSocket(), 'An actual local Docker Desktop Unix socket is required')
  return {
    inspect(target) {
      checkSocket()
      const [info] = JSON.parse(run('docker', ['--host', endpoint, 'inspect', target], { env: dockerEnv, encoding: 'utf8', timeout: 10000 }))
      assert.match(info?.Id, /^[a-f0-9]{64}$/)
      if (/^[a-f0-9]{64}$/.test(target)) assert.equal(info.Id, target, 'Never use a replacement container')
      assert.equal(info.Config?.Labels?.['com.supabase.cli.project'], 'skupy-auth-local')
      assert.equal(info.State?.Running, true, 'The local lab container must be running')
      const bindings = Object.values(info.HostConfig?.PortBindings || {}).flat()
      assert.ok(bindings.length && bindings.every(binding => binding?.HostIp === '127.0.0.1'), 'Lab ports must be explicitly loopback-bound before writes')
      inspected.add(info.Id)
      return info.Id
    },
    exec(containerId, command, options = {}) {
      assert.ok(inspected.has(containerId), 'Only an inspected container ID may be used for exec or cleanup')
      checkSocket()
      return run('docker', ['--host', endpoint, 'exec', '-i', containerId, ...command], { ...options, env: dockerEnv })
    },
    status(bin, dir) {
      checkSocket()
      // Supabase CLI uses the Docker SDK environment instead of Docker's --host flag.
      return JSON.parse(run(bin, ['status', '--output', 'json', '--workdir', dir], {
        env: { ...dockerEnv, DOCKER_HOST: endpoint }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
      }))
    },
  }
}
