import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { type IncomingMessage, type Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { fakeSecretTool } from './fake-secret-tool.ts'
import { closeLoopback, listenLoopback } from './loopback.ts'

/*
 * `spicytrade connect-tastytrade` end to end against a stand-in Worker: the real polling, the
 * real keyring code over a file-backed `secret-tool`, and a no-op browser opener, so a run never
 * opens a browser on the machine running the tests.
 */

const OLD_TOKEN = 'spice_0123456789abcdef_AAAAAAAAAAAAAAAAAAAA'
const AGENT_TOKEN = 'spice_fedcba9876543210_BBBBBBBBBBBBBBBBBBBB'
const REFRESH_TOKEN = 'app-refresh-token-that-belongs-in-the-keyring'

/** Everything the CLI may send the Worker; a field it should not send fails the parse. */
const WorkerCallBodySchema = z.strictObject({
  codeVerifier: z.string(),
  previousToken: z.string().optional(),
})

type WorkerCall = { body: z.infer<typeof WorkerCallBodySchema>; headers: IncomingMessage['headers']; path: string }
type Answer = { body: unknown; status: number }

let cli: ChildProcess | undefined
let worker: Server | undefined
const directories: string[] = []

afterEach(async () => {
  cli?.kill('SIGKILL')
  cli = undefined
  await closeLoopback(worker)
  worker = undefined
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

/** The shared `secret-tool` stand-in, plus inert `xdg-open` and `open` beside it. */
async function fakeTools(entries: Record<string, string>): Promise<string> {
  const directory = await fakeSecretTool(entries)
  directories.push(directory)
  await writeFile(join(directory, 'xdg-open'), `#!/usr/bin/env bash\necho "$1" > '${directory}/opened'\n`)
  await writeFile(join(directory, 'open'), `#!/usr/bin/env bash\necho "$1" > '${directory}/opened'\n`)
  for (const tool of ['xdg-open', 'open']) await chmod(join(directory, tool), 0o755)
  return directory
}

/** A Worker whose member has approved the link, and which answers each poll for the grant with `grant()`. */
async function fakeWorker(grant: () => Answer) {
  const calls: WorkerCall[] = []
  const { port, server } = await listenLoopback((request, raw, response) => {
    const body = WorkerCallBodySchema.parse(JSON.parse(raw || '{}'))
    calls.push({ body, headers: request.headers, path: request.url ?? '' })
    const answer = request.url === '/api/agent-logins/exchange' ? { body: { token: AGENT_TOKEN }, status: 200 } : grant()
    response.writeHead(answer.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(answer.body))
  })
  worker = server
  return { calls, port }
}

function startCli(tools: string, workerPort: number) {
  let stdout = ''
  let stderr = ''
  cli = spawn(process.execPath, ['ops/spicytrade/spicytrade.mjs', 'connect-tastytrade'], {
    env: { ...process.env, SPICYTRADE_MCP_URL: `http://127.0.0.1:${workerPort}/mcp`, PATH: `${tools}:${process.env.PATH ?? ''}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  cli.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  cli.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const exited = new Promise<number | null>((resolve) => cli!.on('exit', resolve))
  return { exited, output: () => ({ stderr, stdout }) }
}

const PENDING: Answer = { body: { pending: true }, status: 202 }
const GRANTED: Answer = { body: { refreshToken: REFRESH_TOKEN }, status: 200 }

describe('connect-tastytrade', () => {
  it('signs in on the same link, collects the grant once the browser is back, and stores it in the keyring only', async () => {
    const tools = await fakeTools({ 'spicytrade/mcp-token': OLD_TOKEN })
    let polls = 0
    const { calls, port } = await fakeWorker(() => (polls++ === 0 ? PENDING : GRANTED))
    const run = startCli(tools, port)

    expect(await run.exited).toBe(0)
    expect(await readFile(join(tools, 'store', 'tastytrade_app-refresh-token'), 'utf8')).toBe(REFRESH_TOKEN)
    expect(await readFile(join(tools, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(AGENT_TOKEN)
    expect(calls.map((call) => call.path)).toEqual([
      '/api/agent-logins/exchange',
      '/api/brokers/tastytrade/exchange',
      '/api/brokers/tastytrade/exchange',
    ])
    // The sign-in retires this computer's earlier token; the grant is collected with the new one
    // and the same verifier, and nothing else.
    const { codeVerifier } = calls[0]!.body
    expect(calls[0]!.body).toEqual({ codeVerifier, previousToken: OLD_TOKEN })
    for (const call of calls.slice(1)) {
      expect(call.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
      expect(call.body).toEqual({ codeVerifier })
    }
    const { stderr, stdout } = run.output()
    for (const secret of [REFRESH_TOKEN, AGENT_TOKEN, OLD_TOKEN, codeVerifier]) {
      expect(stdout).not.toContain(secret)
      expect(stderr).not.toContain(secret)
    }
    // One link, spicytrade's own, is printed and handed to the opener; tastytrade's follows in the browser.
    expect(stdout.match(/https?:\/\//g)).toHaveLength(1)
    // The opener is detached, so it may still be writing when the run exits.
    await expect.poll(() => readFile(join(tools, 'opened'), 'utf8').catch(() => ''))
      .toMatch(/\/connect\/agent\?.*broker=tastytrade/)
  }, 30_000)

  it('lets Ctrl-C skip the wait for tastytrade, as a choice rather than a crash', async () => {
    const tools = await fakeTools({})
    const { port } = await fakeWorker(() => PENDING)
    const run = startCli(tools, port)
    await expect.poll(() => run.output().stdout).toContain('To skip for now, press Ctrl-C.')
    cli!.kill('SIGINT')
    expect(await run.exited).toBe(1)
    expect(run.output().stderr).toMatch(/skipped for now, so tastytrade is not connected\. Connect any time with: \S+ setup/)
    expect(run.output().stderr).not.toContain('unexpectedly')
    // Skipping tastytrade leaves the computer signed in.
    expect(await readFile(join(tools, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(AGENT_TOKEN)
    await expect(readFile(join(tools, 'store', 'tastytrade_app-refresh-token'), 'utf8')).rejects.toThrow()
  }, 30_000)

  it.each([
    [{ body: { refusal: 'access_denied' }, status: 403 }, 'you declined on tastytrade, so it is not connected'],
    [{ body: { refusal: 'server_error' }, status: 403 }, 'tastytrade did not grant access (server_error). Try again with: '],
    [{ body: { error: 'No pending tastytrade connection matches this authorization' }, status: 404 }, 'the tastytrade approval expired, so it is not connected'],
  ])('reports %j in its own words and stores nothing', async (answer, message) => {
    const tools = await fakeTools({})
    const { port } = await fakeWorker(() => answer)
    const run = startCli(tools, port)
    expect(await run.exited).toBe(1)
    expect(run.output().stderr).toContain(message)
    await expect(readFile(join(tools, 'store', 'tastytrade_app-refresh-token'), 'utf8')).rejects.toThrow()
  }, 30_000)

  it('reports a tastytrade refusal of the code by status, never a body', async () => {
    const tools = await fakeTools({})
    const { port } = await fakeWorker(() => ({
      body: { error: 'tastytrade refused the grant', tastytradeStatus: 400 },
      status: 502,
    }))
    const run = startCli(tools, port)
    expect(await run.exited).toBe(1)
    expect(run.output().stderr).toContain('tastytrade did not accept the connection (HTTP 400). To try again, run: ')
    expect(run.output().stderr).not.toContain('refused the grant')
  }, 30_000)

  it('refuses to start over a personal grant, before reaching the Worker', async () => {
    const tools = await fakeTools({
      'spicytrade/mcp-token': OLD_TOKEN,
      'tastytrade/client-secret': 'personal-client-secret',
      'tastytrade/refresh-token': 'personal-refresh-token',
    })
    const { calls, port } = await fakeWorker(() => ({ body: {}, status: 500 }))
    const run = startCli(tools, port)
    expect(await run.exited).toBe(1)
    expect(run.output().stderr).toContain('tastytrade is already connected with your personal grant. To switch, run:')
    expect(run.output().stderr).not.toContain('personal-client-secret')
    expect(calls).toEqual([])
  }, 30_000)
})
