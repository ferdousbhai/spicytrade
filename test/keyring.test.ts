import { execFile } from 'node:child_process'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { fakeSecretTool } from './fake-secret-tool.ts'
import { fakeSecurity } from './fake-security.ts'

const execute = promisify(execFile)
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('keyring write probes', () => {
  it('isolates simultaneous checks and removes their disposable entries', async () => {
    const directory = await fakeSecretTool({})
    directories.push(directory)
    const tool = join(directory, 'secret-tool')
    const script = await readFile(tool, 'utf8')
    await writeFile(tool, script.replace('cat > "$store/$4_$6"', 'echo "$6" >> "$store/../probes"\n  cat > "$store/$4_$6"'))
    const module = pathToFileURL(resolve('ops/spicytrade/keyring.mjs')).href
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
      import { keyringWritable } from ${JSON.stringify(module)}
      const out = { write() {} }
      console.log(JSON.stringify(await Promise.all([keyringWritable(out), keyringWritable(out)])))
    `], { env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` } })
    expect(JSON.parse(stdout)).toEqual([true, true])
    const keys = (await readFile(join(directory, 'probes'), 'utf8')).trim().split('\n')
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
    expect(await readdir(join(directory, 'store'))).toEqual([])
  })

  it('cleans up a probe even when reading back the stored value fails', async () => {
    const directory = await fakeSecretTool({})
    directories.push(directory)
    const tool = join(directory, 'secret-tool')
    await writeFile(tool, (await readFile(tool, 'utf8')).replace('cat "$store/$3_$5"', "echo 'locked collection' >&2; exit 1"))
    const module = pathToFileURL(resolve('ops/spicytrade/keyring.mjs')).href
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
      import { keyringWritable } from ${JSON.stringify(module)}
      try { await keyringWritable({ write() {} }) } catch (error) { console.log(error.reason) }
    `], { env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` } })
    expect(stdout.trim()).toBe('locked')
    expect(await readdir(join(directory, 'store'))).toEqual([])
  })
})

describe('keyring on macOS', () => {
  /** Runs `body` against `keyring.mjs` as a Mac would load it: the platform is set before the import. */
  async function onMac(directory: string, body: string): Promise<string> {
    const module = pathToFileURL(resolve('ops/spicytrade/keyring.mjs')).href
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const keyring = await import(${JSON.stringify(module)})
      ${body}
    `], { env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` } })
    return stdout.trim()
  }

  it('stores, reads back and clears through security without a secret in any argument', async () => {
    const directory = await fakeSecurity({})
    directories.push(directory)
    const token = 'eyJhbGciOi.J9-_tok~en+/='
    const stdout = await onMac(directory, `
      const stored = await keyring.keyringStore('tastytrade', 'app-refresh-token', 'tastytrade refresh token (spicytrade app)', ${JSON.stringify(token)})
      const read = await keyring.keyringSecret('tastytrade', 'app-refresh-token')
      const cleared = await keyring.keyringClear('tastytrade', 'app-refresh-token')
      const after = await keyring.keyringSecret('tastytrade', 'app-refresh-token')
      const clearedAgain = await keyring.keyringClear('tastytrade', 'app-refresh-token')
      console.log(JSON.stringify({ stored, read, cleared, after: after ?? null, clearedAgain }))
    `)
    expect(JSON.parse(stdout)).toEqual({ stored: true, read: token, cleared: true, after: null, clearedAgain: true })
    expect(await readFile(join(directory, 'argv'), 'utf8')).not.toContain(token)
    expect(await readdir(join(directory, 'store'))).toEqual([])
  })

  it('stores a value with spaces and quotes as hex', async () => {
    const directory = await fakeSecurity({})
    directories.push(directory)
    const value = 'two words "quoted" \\ $HOME'
    const stdout = await onMac(directory, `
      console.log(JSON.stringify(await keyring.keyringStore('tastytrade', 'client-secret', 'label', ${JSON.stringify(value)})))
    `)
    expect(JSON.parse(stdout)).toBe(true)
    expect(await readFile(join(directory, 'store', 'tastytrade_client-secret'), 'utf8')).toBe(value)
  })

  it('passes the write check and leaves nothing behind', async () => {
    const directory = await fakeSecurity({})
    directories.push(directory)
    expect(await onMac(directory, 'console.log(await keyring.keyringWritable({ write() {} }))')).toBe('true')
    expect(await readdir(join(directory, 'store'))).toEqual([])
  })

  it('reports a locked keychain as locked, never as an empty one', async () => {
    const directory = await fakeSecurity({ 'spicytrade/mcp-token': 'token' })
    directories.push(directory)
    await writeFile(join(directory, 'security'), "#!/usr/bin/env bash\necho 'security: SecKeychainSearchCopyNext: User interaction is not allowed.' >&2\nexit 36\n")
    const stdout = await onMac(directory, `
      try { await keyring.agentToken() } catch (error) { console.log(error.reason + '|' + error.message) }
    `)
    expect(stdout).toContain('locked|')
  })

  it('refuses a platform with no helper before touching anything', async () => {
    const module = pathToFileURL(resolve('ops/spicytrade/keyring.mjs')).href
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const keyring = await import(${JSON.stringify(module)})
      try { keyring.requireSupportedPlatform() } catch (error) { console.log(error.message) }
    `])
    expect(stdout).toContain('Linux and macOS, not on Windows.')
  })
})
