import { execFile } from 'node:child_process'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { fakeSecretTool } from './fake-secret-tool.ts'

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
