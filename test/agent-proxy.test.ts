import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { tokenRetiresAt, UPSTREAM_TIMEOUT_MS } from '../ops/spicytrade/token-refresh.mjs'
import { fakeSecretTool } from './fake-secret-tool.ts'

const REFRESH_TOKEN = 'refresh-token-that-must-never-leave-this-machine'
const CLIENT_SECRET = 'client-secret-that-must-never-leave-this-machine'
const AGENT_TOKEN = 'spice_0123456789abcdef_AAAAAAAAAAAAAAAAAAAA'
const MINTED = 'minted-15-minute-access-token'

type Captured = { body: string; headers: IncomingMessage['headers'] }

let proxy: ChildProcess | undefined
let upstream: Server | undefined
/** Each fake keyring holds the test's secrets in an executable script; none may outlive the run. */
const keyrings: string[] = []

afterEach(async () => {
  proxy?.kill('SIGKILL')
  proxy = undefined
  const server = upstream
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve())
    else resolve()
  })
  upstream = undefined
  await Promise.all(keyrings.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  upstream = createServer(handler)
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
  // SAFETY: this server was just listened on a TCP port, which is the case where Node returns
  // an AddressInfo rather than a pipe path or null.
  return (upstream.address() as AddressInfo).port
}

/** The shared `secret-tool` stand-in, tracked here so its directory is cleaned up after each test. */
async function fakeKeyring(entries: Record<string, string>): Promise<string> {
  const directory = await fakeSecretTool(entries)
  keyrings.push(directory)
  return directory
}

async function startProxy(env: Record<string, string>, port: number): Promise<void> {
  proxy = spawn(process.execPath, ['ops/spicytrade/proxy.mjs'], {
    env: { ...process.env, ...env, SPICYTRADE_PROXY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not start')), 10_000)
    proxy!.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('SpicytradeProxy: http://')) {
        clearTimeout(timer)
        resolve()
      }
    })
    proxy!.on('exit', () => { clearTimeout(timer); reject(new Error('proxy exited')) })
  })
}

describe('local agent proxy', () => {
  it('attaches a freshly minted broker token and never forwards the long-lived credential', async () => {
    const captured: Captured[] = []
    let tokenRequests = 0
    const port = await listen((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        if (request.url?.endsWith('/oauth/token')) {
          tokenRequests += 1
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ access_token: MINTED, expires_in: 900 }))
          return
        }
        captured.push({ body, headers: request.headers })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/client-secret': CLIENT_SECRET,
      'tastytrade/refresh-token': REFRESH_TOKEN,
    })
    const proxyPort = 18_787
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)

    const call = () => fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    // `Response.ok` would also match this shape, so assert the forwarded body explicitly.
    expect(await (await call()).json()).toEqual({ ok: true })
    expect(await (await call()).json()).toEqual({ ok: true })

    expect(captured).toHaveLength(2)
    for (const request of captured) {
      expect(request.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
      expect(request.headers['x-spice-broker']).toBe('tastytrade')
      expect(request.headers['x-spice-broker-token']).toBe(MINTED)
      // The whole reason this process exists: the permanent credential stays here.
      const serialized = JSON.stringify(request)
      expect(serialized).not.toContain(REFRESH_TOKEN)
      expect(serialized).not.toContain(CLIENT_SECRET)
    }
    // Minted once and reused inside its lifetime, not re-fetched per request.
    expect(tokenRequests).toBe(1)
  }, 30_000)

  it('forwards the market surface when no brokerage credential is configured', async () => {
    const captured: Captured[] = []
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        captured.push({ body: '', headers: request.headers })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN })
    const proxyPort = 18_788
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)

    await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]?.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
    // No broker headers at all, so the Worker's account tools answer with their own
    // connect-a-brokerage message rather than being handed a half-configured credential.
    expect(captured[0]?.headers['x-spice-broker']).toBeUndefined()
    expect(captured[0]?.headers['x-spice-broker-token']).toBeUndefined()
  }, 30_000)

  it('still runs an install from before the rename: old keyring entry', async () => {
    const captured: Captured[] = []
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        captured.push({ body: '', headers: request.headers })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({ 'spicy-trade/mcp-token': AGENT_TOKEN })
    const proxyPort = 18_798
    proxy = spawn(process.execPath, ['ops/spicytrade/proxy.mjs'], {
      env: {
        ...process.env,
        PATH: `${keyring}:${process.env.PATH ?? ''}`,
        SPICYTRADE_PROXY_PORT: String(proxyPort),
        SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('proxy did not start')), 10_000)
      proxy!.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('SpicytradeProxy: http://')) {
          clearTimeout(timer)
          resolve()
        }
      })
      proxy!.on('exit', () => { clearTimeout(timer); reject(new Error('proxy exited')) })
    })

    await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]?.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
  }, 30_000)

  it('forwards MCP session headers in both directions', async () => {
    const captured: Captured[] = []
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        captured.push({ body: '', headers: request.headers })
        response.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'session-from-worker',
          'mcp-protocol-version': '2025-03-26',
        })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN })
    const proxyPort = 18_789
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)

    const response = await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'initialize' }),
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-03-26',
        'mcp-session-id': 'session-from-client',
        'last-event-id': '42',
      },
      method: 'POST',
    })
    expect(response.headers.get('mcp-session-id')).toBe('session-from-worker')
    expect(response.headers.get('mcp-protocol-version')).toBe('2025-03-26')
    expect(captured).toHaveLength(1)
    expect(captured[0]?.headers['mcp-session-id']).toBe('session-from-client')
    expect(captured[0]?.headers['mcp-protocol-version']).toBe('2025-03-26')
    expect(captured[0]?.headers['last-event-id']).toBe('42')
  }, 30_000)

  it('refuses a request that names another host or carries an Origin, before attaching anything', async () => {
    const captured: Captured[] = []
    let tokenRequests = 0
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        if (request.url?.endsWith('/oauth/token')) {
          tokenRequests += 1
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ access_token: MINTED, expires_in: 900 }))
          return
        }
        captured.push({ body: '', headers: request.headers })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/client-secret': CLIENT_SECRET,
      'tastytrade/refresh-token': REFRESH_TOKEN,
    })
    const proxyPort = 18_790
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)

    // `fetch` will not let a caller set Host, so this speaks HTTP directly, the way a rebound
    // browser request arrives: to 127.0.0.1, naming the attacker's host.
    const status = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest({ headers, host: '127.0.0.1', method: 'POST', path: '/mcp', port: proxyPort }, (reply) => {
        reply.resume()
        resolve(reply.statusCode ?? 0)
      })
      outgoing.on('error', reject)
      outgoing.end(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }))
    })
    expect(await status({ 'content-type': 'application/json', host: `attacker.example:${proxyPort}` })).toBe(403)
    expect(await status({
      'content-type': 'application/json',
      host: `127.0.0.1:${proxyPort}`,
      origin: 'http://attacker.example',
    })).toBe(403)
    expect(captured).toHaveLength(0)
    expect(tokenRequests).toBe(0)

    // Both loopback spellings still work for a local client.
    expect(await status({ 'content-type': 'application/json', host: `localhost:${proxyPort}` })).toBe(200)
    expect(await status({ 'content-type': 'application/json', host: `127.0.0.1:${proxyPort}` })).toBe(200)
    expect(captured).toHaveLength(2)
  }, 30_000)

  it('cuts a stream that fails mid-way instead of appending an error to it', async () => {
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('event: message\ndata: {"partial":true}\n\n')
        // The Worker's connection drops with the event stream under way.
        setTimeout(() => response.destroy(), 50)
      })
    })
    const keyring = await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN })
    const proxyPort = 18_792
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)

    const outcome = await new Promise<{ body: string; complete: boolean; contentType?: string }>((resolve, reject) => {
      const outgoing = httpRequest({
        headers: { 'content-type': 'application/json', host: `127.0.0.1:${proxyPort}` },
        host: '127.0.0.1', method: 'POST', path: '/mcp', port: proxyPort,
      }, (reply) => {
        let body = ''
        reply.on('data', (chunk: Buffer) => { body += chunk.toString() })
        reply.on('end', () => resolve({ body, complete: reply.complete, contentType: reply.headers['content-type'] }))
        reply.on('aborted', () => resolve({ body, complete: false, contentType: reply.headers['content-type'] }))
        reply.on('error', () => resolve({ body, complete: false, contentType: reply.headers['content-type'] }))
      })
      outgoing.on('error', reject)
      outgoing.end(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call' }))
    })
    expect(outcome.contentType).toBe('text/event-stream')
    expect(outcome.body).toContain('"partial":true')
    // A clean end, or the proxy's JSON error inside the event stream, would read as a whole reply.
    expect(outcome.body).not.toContain('could not complete')
    expect(outcome.complete).toBe(false)
  }, 30_000)

  it('logs a refused token exchange as TastytradeAuth with its status, never the credential', async () => {
    let forwarded = 0
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        if (request.url?.endsWith('/oauth/token')) {
          // A revoked grant. The body echoes the credential, which must not reach the log.
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'invalid_grant', refresh_token: REFRESH_TOKEN }))
          return
        }
        forwarded += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/client-secret': CLIENT_SECRET,
      'tastytrade/refresh-token': REFRESH_TOKEN,
    })
    const proxyPort = 18_793
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)
    let stderr = ''
    proxy!.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const reply = await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(reply.status).toBe(502)
    await expect.poll(() => stderr).toContain('SpicytradeProxy: POST TastytradeAuth 401\n')
    expect(stderr).not.toContain(REFRESH_TOKEN)
    expect(stderr).not.toContain(CLIENT_SECRET)
    expect(forwarded).toBe(0)
  }, 30_000)

  it('logs an unreachable or unreadable token exchange as TastytradeAuth, not as a Worker failure', async () => {
    let forwarded = 0
    let tokenAnswer: 'html' | 'refuse' = 'html'
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        if (request.url?.endsWith('/oauth/token')) {
          if (tokenAnswer === 'refuse') {
            // The connection drops before any status: a transport failure, like an unreachable host.
            response.destroy()
            return
          }
          // A 2xx that is not JSON, as a captive portal or a misrouted proxy answers.
          response.writeHead(200, { 'content-type': 'text/html' })
          response.end(`<html>${REFRESH_TOKEN}</html>`)
          return
        }
        forwarded += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/client-secret': CLIENT_SECRET,
      'tastytrade/refresh-token': REFRESH_TOKEN,
    })
    const proxyPort = 18_794
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)
    let stderr = ''
    proxy!.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const call = () => fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect((await call()).status).toBe(502)
    await expect.poll(() => stderr).toContain('SpicytradeProxy: POST TastytradeAuth invalid-token-response\n')

    tokenAnswer = 'refuse'
    expect((await call()).status).toBe(502)
    await expect.poll(() => stderr).toMatch(/SpicytradeProxy: POST TastytradeAuth unreachable( [A-Za-z0-9_]+)?\n/)
    expect(stderr).not.toContain('TypeError')
    expect(stderr).not.toContain('SyntaxError')
    expect(stderr).not.toContain(REFRESH_TOKEN)
    expect(stderr).not.toContain(CLIENT_SECRET)
    expect(forwarded).toBe(0)
  }, 30_000)

  it('exits non-zero when the keyring cannot be read rather than starting market-only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spicytrade-keyring-'))
    keyrings.push(directory)
    await writeFile(join(directory, 'secret-tool'), `#!/usr/bin/env bash
case "$3/$5" in
  spicytrade/mcp-token) printf '%s' '${AGENT_TOKEN}' ;;
  *) echo 'Cannot create an item in a locked collection' >&2; exit 1 ;;
esac
`)
    await chmod(join(directory, 'secret-tool'), 0o755)
    const child = spawn(process.execPath, ['ops/spicytrade/proxy.mjs'], {
      env: { ...process.env, SPICYTRADE_PROXY_PORT: '18791', PATH: `${directory}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proxy = child
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    expect(code).not.toBe(0)
    expect(stdout).not.toContain('SpicytradeProxy: http://')
  }, 30_000)

  it('mints an app grant through the Worker and forwards only the access token', async () => {
    const captured: Captured[] = []
    const mints: Captured[] = []
    let directMints = 0
    const port = await listen((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        if (request.url?.endsWith('/oauth/token')) {
          // An app grant never goes to tastytrade directly: it has no client secret to send.
          directMints += 1
          response.writeHead(500)
          response.end()
          return
        }
        if (request.url === '/api/brokers/tastytrade/token') {
          mints.push({ body, headers: request.headers })
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ accessToken: MINTED, expiresIn: 900 }))
          return
        }
        captured.push({ body, headers: request.headers })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/app-refresh-token': REFRESH_TOKEN,
    })
    const proxyPort = 18_795
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)

    const call = () => fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(await (await call()).json()).toEqual({ ok: true })
    expect(await (await call()).json()).toEqual({ ok: true })

    // Minted once, by the Worker, with the agent token and the refresh token and nothing else.
    expect(mints).toHaveLength(1)
    expect(directMints).toBe(0)
    expect(mints[0]?.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
    expect(JSON.parse(mints[0]!.body)).toEqual({ refreshToken: REFRESH_TOKEN })
    expect(captured).toHaveLength(2)
    for (const request of captured) {
      expect(request.headers['x-spice-broker']).toBe('tastytrade')
      expect(request.headers['x-spice-broker-token']).toBe(MINTED)
      expect(JSON.stringify(request)).not.toContain(REFRESH_TOKEN)
    }
  }, 30_000)

  it('logs a relayed tastytrade refusal of an app grant by tastytrade status, never the credential', async () => {
    let forwarded = 0
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        if (request.url === '/api/brokers/tastytrade/token') {
          response.writeHead(502, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'tastytrade refused the grant', tastytradeStatus: 401 }))
          return
        }
        forwarded += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/app-refresh-token': REFRESH_TOKEN,
    })
    const proxyPort = 18_796
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    }, proxyPort)
    let stderr = ''
    proxy!.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const reply = await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(reply.status).toBe(502)
    await expect.poll(() => stderr).toContain('SpicytradeProxy: POST TastytradeAuth 401\n')
    expect(stderr).not.toContain(REFRESH_TOKEN)
    expect(forwarded).toBe(0)
  }, 30_000)

  it('refuses to start when the keyring holds both an app grant and a personal grant', async () => {
    const personalGrants: Array<Record<string, string>> = [
      { 'tastytrade/client-secret': CLIENT_SECRET, 'tastytrade/refresh-token': REFRESH_TOKEN },
      // Even half a personal grant beside an app grant is ambiguous, not a partial one to ignore.
      { 'tastytrade/client-secret': CLIENT_SECRET },
    ]
    for (const personal of personalGrants) {
      const keyring = await fakeKeyring({
        'spicytrade/mcp-token': AGENT_TOKEN,
        'tastytrade/app-refresh-token': 'app-refresh-token-value',
        ...personal,
      })
      const child = spawn(process.execPath, ['ops/spicytrade/proxy.mjs'], {
        env: { ...process.env, SPICYTRADE_PROXY_PORT: '18797', PATH: `${keyring}:${process.env.PATH ?? ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      proxy = child
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
      expect(code).not.toBe(0)
      expect(stdout).not.toContain('SpicytradeProxy: http://')
      expect(stderr).toContain('the keyring holds both a tastytrade app grant')
      expect(stderr).not.toContain(CLIENT_SECRET)
      expect(stderr).not.toContain('app-refresh-token-value')
    }
  }, 30_000)
})

describe('broker token retirement', () => {
  it('retires a token one upstream timeout before expiry, so no forwarded request outlives it', () => {
    // tastytrade's 15-minute token: a tenth is 90 s, so the whole 60 s timeout is spared. A fixed
    // 30 s margin let a placement forwarded 45 s before expiry run on a token that died under it.
    const lifetimeMs = 15 * 60_000
    const retiresAt = tokenRetiresAt(0, lifetimeMs)
    expect(retiresAt).toBe(lifetimeMs - UPSTREAM_TIMEOUT_MS)
  })

  it('keeps a token too short-lived to spare a whole timeout for nine tenths of its life', () => {
    expect(tokenRetiresAt(1_000, 100_000)).toBe(1_000 + 90_000)
  })
})

/** The JSON-RPC error the proxy answers a failed request with; any other shape fails the parse. */
const ProxyFailureSchema = z.strictObject({
  error: z.strictObject({ code: z.number().int(), message: z.string() }),
  id: z.union([z.number(), z.string(), z.null()]),
  jsonrpc: z.literal('2.0'),
})

/** What a test sends: a request when it has an id, a notification when it does not. */
type JsonRpcMessage = { id?: number | string; jsonrpc: '2.0'; method: string }

/** What the stand-in Worker answers the app-grant mint with, changed between calls. */
type WorkerAnswer = { body: { error: string; tastytradeStatus?: number }; status: number }

describe('local agent proxy failures an agent can act on', () => {
  async function failingCall(proxyPort: number, body: JsonRpcMessage) {
    const reply = await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    return { failure: ProxyFailureSchema.parse(await reply.json()), status: reply.status }
  }

  it('answers a Worker refusal of the agent token with the command that signs in again', async () => {
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        // The Worker's own 401 challenge, which must not reach the client as one.
        response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
        response.end(JSON.stringify({ error: 'invalid_token' }))
      })
    })
    const keyring = await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN })
    const proxyPort = 18_801
    await startProxy({ PATH: `${keyring}:${process.env.PATH ?? ''}`, SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp` }, proxyPort)
    let stderr = ''
    proxy!.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const { failure, status } = await failingCall(proxyPort, { id: 7, jsonrpc: '2.0', method: 'tools/list' })
    // Not relayed as a 401: that would send an MCP client looking for an OAuth flow here.
    expect(status).toBe(502)
    expect(failure.jsonrpc).toBe('2.0')
    expect(failure.id).toBe(7)
    expect(failure.error.code).toBe(-32001)
    expect(failure.error.message).toMatch(/^spicytrade rejected the agent token in this machine's keyring\. Run: \S*spicytrade(\.mjs)? login$/)
    await expect.poll(() => stderr).toContain('SpicytradeProxy: POST AgentTokenRefused 401\n')
    expect(JSON.stringify(failure)).not.toContain(AGENT_TOKEN)
    expect(stderr).not.toContain(AGENT_TOKEN)
  }, 30_000)

  it('answers a refused app-grant mint by what was refused, and a notification with a null id', async () => {
    let refusal: WorkerAnswer = { body: { error: 'Unauthorized' }, status: 401 }
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(refusal.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(refusal.body))
      })
    })
    const keyring = await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/app-refresh-token': REFRESH_TOKEN,
    })
    const proxyPort = 18_802
    await startProxy({ PATH: `${keyring}:${process.env.PATH ?? ''}`, SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp` }, proxyPort)

    // The Worker refused the agent token on the mint itself.
    const tokenRefused = await failingCall(proxyPort, { id: 'a', jsonrpc: '2.0', method: 'tools/list' })
    expect(tokenRefused.status).toBe(502)
    expect(tokenRefused.failure.id).toBe('a')
    expect(tokenRefused.failure.error.code).toBe(-32001)
    expect(tokenRefused.failure.error.message).toMatch(/ login$/)

    // tastytrade refused the grant, relayed by the Worker: reconnect, not sign in.
    refusal = { body: { error: 'tastytrade refused the grant', tastytradeStatus: 401 }, status: 502 }
    const grantRefused = await failingCall(proxyPort, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(grantRefused.status).toBe(502)
    expect(grantRefused.failure.id).toBeNull()
    expect(grantRefused.failure.error.code).toBe(-32002)
    expect(grantRefused.failure.error.message).toMatch(/^tastytrade refused this machine's brokerage connection \(HTTP 401\)\. Reconnect with: \S*spicytrade(\.mjs)? connect-tastytrade$/)
    expect(JSON.stringify(grantRefused.failure)).not.toContain(REFRESH_TOKEN)
  }, 30_000)

  it('answers a refused personal grant with the command that stores a new one', async () => {
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'invalid_grant' }))
      })
    })
    const keyring = await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/client-secret': CLIENT_SECRET,
      'tastytrade/refresh-token': REFRESH_TOKEN,
    })
    const proxyPort = 18_803
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)

    const { failure } = await failingCall(proxyPort, { id: 1, jsonrpc: '2.0', method: 'tools/list' })
    expect(failure.error.code).toBe(-32002)
    expect(failure.error.message).toMatch(/personal grant \(HTTP 401\).*store-credentials\.sh tastytrade$/)
    expect(JSON.stringify(failure)).not.toContain(CLIENT_SECRET)
  }, 30_000)

  it('answers an unreachable Worker by naming it and the transport failure', async () => {
    // A port that was listening and is closed again, so nothing answers on it.
    const port = await listen(() => {})
    await new Promise<void>((resolve) => upstream!.close(() => resolve()))
    upstream = undefined
    const keyring = await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN })
    const proxyPort = 18_804
    await startProxy({ PATH: `${keyring}:${process.env.PATH ?? ''}`, SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp` }, proxyPort)

    const { failure, status } = await failingCall(proxyPort, { id: 1, jsonrpc: '2.0', method: 'tools/list' })
    expect(status).toBe(502)
    expect(failure.error.code).toBe(-32003)
    expect(failure.error.message).toMatch(/^spicytrade could not be reached from this machine \(ECONNREFUSED\)\. .* doctor$/)
  }, 30_000)
})
