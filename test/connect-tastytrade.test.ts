import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { fakeSecretTool } from './fake-secret-tool.ts'

/*
 * `connect-tastytrade.mjs` end to end against a stand-in Worker: the real loopback listener, the
 * real keyring code over a file-backed `secret-tool`, and a no-op browser opener and systemctl,
 * so a run never opens a browser or restarts a service on the machine running the tests.
 */

const AGENT_TOKEN = 'spice_0123456789abcdef_AAAAAAAAAAAAAAAAAAAA'
const STATE = 'S'.repeat(43)
const CODE = 'authorization-code-from-tastytrade'
const REFRESH_TOKEN = 'app-refresh-token-that-belongs-in-the-keyring'

/** Everything the CLI may send the Worker; a field it should not send fails the parse. */
const WorkerCallBodySchema = z.strictObject({
  code: z.string().optional(),
  port: z.number().int().optional(),
  state: z.string().optional(),
})

type WorkerCall = { body: z.infer<typeof WorkerCallBodySchema>; headers: IncomingMessage['headers']; path: string }

let cli: ChildProcess | undefined
let worker: Server | undefined
const directories: string[] = []

afterEach(async () => {
  cli?.kill('SIGKILL')
  cli = undefined
  const server = worker
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  worker = undefined
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

/** The shared `secret-tool` stand-in, plus inert `xdg-open`, `open`, and `systemctl` beside it. */
async function fakeTools(entries: Record<string, string>): Promise<string> {
  const directory = await fakeSecretTool(entries)
  directories.push(directory)
  await writeFile(join(directory, 'xdg-open'), `#!/usr/bin/env bash\necho "$1" > '${directory}/opened'\n`)
  await writeFile(join(directory, 'open'), `#!/usr/bin/env bash\necho "$1" > '${directory}/opened'\n`)
  await writeFile(join(directory, 'systemctl'), '#!/usr/bin/env bash\nexit 1\n')
  for (const tool of ['xdg-open', 'open', 'systemctl']) await chmod(join(directory, tool), 0o755)
  return directory
}

async function fakeWorker(exchangeAnswer: () => { body: unknown; status: number }) {
  const calls: WorkerCall[] = []
  worker = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = WorkerCallBodySchema.parse(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
      calls.push({ body, headers: request.headers, path: request.url ?? '' })
      const answer = request.url === '/api/brokers/tastytrade/authorize'
        ? {
            body: {
              authorizationUrl: `https://my.tastytrade.com/auth.html?state=${STATE}`,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              state: STATE,
            },
            status: 200,
          }
        : exchangeAnswer()
      response.writeHead(answer.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => worker!.listen(0, '127.0.0.1', resolve))
  // SAFETY: this server was just listened on a TCP port, which is the case where Node returns
  // an AddressInfo rather than a pipe path or null.
  return { calls, port: (worker.address() as AddressInfo).port }
}

function startCli(tools: string, workerPort: number) {
  let stdout = ''
  let stderr = ''
  cli = spawn(process.execPath, ['ops/spicytrade/connect-tastytrade.mjs'], {
    env: { ...process.env, SPICYTRADE_MCP_URL: `http://127.0.0.1:${workerPort}/mcp`, PATH: `${tools}:${process.env.PATH ?? ''}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  cli.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  cli.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const exited = new Promise<number | null>((resolve) => cli!.on('exit', resolve))
  return { exited, output: () => ({ stderr, stdout }) }
}

/** A browser-shaped GET to the loopback listener; `host` lets a test imitate a rebound page. */
function visit(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ body: string; status: number }>((resolve, reject) => {
    const outgoing = httpRequest({ headers: { host: `127.0.0.1:${port}`, ...headers }, host: '127.0.0.1', path, port }, (reply) => {
      let body = ''
      reply.on('data', (chunk: Buffer) => { body += chunk.toString() })
      reply.on('end', () => resolve({ body, status: reply.statusCode ?? 0 }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

async function loopbackPort(calls: WorkerCall[], output: () => { stdout: string }): Promise<number> {
  // The listener takes the state from the authorize answer, which the CLI prints the URL after.
  await expect.poll(() => output().stdout, { timeout: 10_000 }).toContain('Approve spicytrade on tastytrade')
  const port = calls.find((call) => call.path === '/api/brokers/tastytrade/authorize')?.body.port
  if (port === undefined) throw new Error('the CLI started without naming its loopback port')
  return port
}

describe('connect-tastytrade', () => {
  it('redeems the return through the Worker and stores the refresh token in the keyring only', async () => {
    const tools = await fakeTools({ 'spicytrade/mcp-token': AGENT_TOKEN })
    const { calls, port } = await fakeWorker(() => ({ body: { refreshToken: REFRESH_TOKEN }, status: 200 }))
    const run = startCli(tools, port)
    const listener = await loopbackPort(calls, run.output)

    // A rebound page and a return that is not this run's are both refused, and the run goes on.
    expect((await visit(listener, `/callback?code=${CODE}&state=${STATE}`, { host: `attacker.example:${listener}` })).status).toBe(403)
    expect((await visit(listener, `/callback?code=${CODE}&state=${STATE}`, { origin: 'http://attacker.example' })).status).toBe(403)
    expect((await visit(listener, `/callback?code=${CODE}&state=${'T'.repeat(43)}`)).status).toBe(400)
    const returned = await visit(listener, `/callback?code=${CODE}&state=${STATE}`)
    expect(returned.status).toBe(200)
    expect(returned.body).not.toContain(CODE)

    expect(await run.exited).toBe(0)
    expect(await readFile(join(tools, 'store', 'tastytrade_app-refresh-token'), 'utf8')).toBe(REFRESH_TOKEN)
    expect(calls.map((call) => call.path)).toEqual([
      '/api/brokers/tastytrade/authorize',
      '/api/brokers/tastytrade/exchange',
    ])
    for (const call of calls) expect(call.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
    expect(calls[1]?.body).toEqual({ code: CODE, state: STATE })
    const { stderr, stdout } = run.output()
    for (const secret of [REFRESH_TOKEN, CODE, AGENT_TOKEN]) {
      expect(stdout).not.toContain(secret)
      expect(stderr).not.toContain(secret)
    }
    // The consent URL is printed and handed to the opener, nothing more.
    // The opener is detached, so it may still be writing when the run exits.
    await expect.poll(() => readFile(join(tools, 'opened'), 'utf8').catch(() => ''))
      .toContain('https://my.tastytrade.com/auth.html')
  }, 30_000)

  it('reports a refusal by its OAuth code and stores nothing', async () => {
    const tools = await fakeTools({ 'spicytrade/mcp-token': AGENT_TOKEN })
    const { calls, port } = await fakeWorker(() => ({ body: { refreshToken: REFRESH_TOKEN }, status: 200 }))
    const run = startCli(tools, port)
    const listener = await loopbackPort(calls, run.output)
    expect((await visit(listener, `/callback?error=access_denied&state=${STATE}`)).status).toBe(200)
    expect(await run.exited).toBe(1)
    expect(run.output().stderr).toContain('tastytrade did not grant access (access_denied)')
    expect(calls.map((call) => call.path)).toEqual(['/api/brokers/tastytrade/authorize'])
    await expect(readFile(join(tools, 'store', 'tastytrade_app-refresh-token'), 'utf8')).rejects.toThrow()
  }, 30_000)

  it('reports a tastytrade refusal of the code by status, never a body', async () => {
    const tools = await fakeTools({ 'spicytrade/mcp-token': AGENT_TOKEN })
    const { calls, port } = await fakeWorker(() => ({
      body: { error: 'tastytrade refused the grant', tastytradeStatus: 400 },
      status: 502,
    }))
    const run = startCli(tools, port)
    const listener = await loopbackPort(calls, run.output)
    await visit(listener, `/callback?code=${CODE}&state=${STATE}`)
    expect(await run.exited).toBe(1)
    expect(run.output().stderr).toContain('tastytrade refused the grant (HTTP 400)')
    expect(run.output().stderr).not.toContain(CODE)
  }, 30_000)

  it('refuses to start over a personal grant, before reaching the Worker', async () => {
    const tools = await fakeTools({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/client-secret': 'personal-client-secret',
    })
    const { calls, port } = await fakeWorker(() => ({ body: {}, status: 500 }))
    const run = startCli(tools, port)
    expect(await run.exited).toBe(1)
    expect(run.output().stderr).toContain('already holds a tastytrade personal grant')
    expect(run.output().stderr).not.toContain('personal-client-secret')
    expect(calls).toEqual([])
  }, 30_000)
})
