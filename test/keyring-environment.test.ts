import { beforeEach, describe, expect, it, vi } from 'vitest'

import { keyringEnvironment as resolveEnvironment } from '../ops/spicytrade/keyring-environment.mjs'

const inspect = vi.fn()
const keyringEnvironment = (env: NodeJS.ProcessEnv) => resolveEnvironment(env, inspect)

const uid = process.geteuid!()
const directory = { uid, mode: 0o40700, isDirectory: () => true }
const socket = { uid, isSocket: () => true }

beforeEach(() => {
  inspect.mockReset()
  inspect.mockResolvedValueOnce(directory).mockResolvedValueOnce(socket)
})

describe('keyring session bus discovery', () => {
  it('finds the current user bus with a stripped agent environment without mutating it', async () => {
    const env = { PATH: '/usr/bin' }
    const result = await keyringEnvironment(env)
    expect(result).toEqual({ ...env, LC_ALL: 'C', XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=%2Frun%2Fuser%2F${uid}%2Fbus` })
    expect(env).toEqual({ PATH: '/usr/bin' })
    expect(inspect).toHaveBeenNthCalledWith(1, `/run/user/${uid}`)
  })

  it.each(['unix:path=/custom/bus', ''])('preserves an explicitly configured bus address: %s', async (address) => {
    expect(await keyringEnvironment({ DBUS_SESSION_BUS_ADDRESS: address })).toEqual({ LC_ALL: 'C', DBUS_SESSION_BUS_ADDRESS: address })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('uses the provided runtime directory and escapes D-Bus address delimiters', async () => {
    const result = await keyringEnvironment({ XDG_RUNTIME_DIR: '/session/a,b;c' })
    expect(result.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=%2Fsession%2Fa%2Cb%3Bc%2Fbus')
    expect(inspect).toHaveBeenNthCalledWith(1, '/session/a,b;c')
  })

  it.each(['', 'relative'])('does not replace an invalid explicit runtime directory: %s', async (runtime) => {
    expect(await keyringEnvironment({ XDG_RUNTIME_DIR: runtime })).toEqual({ LC_ALL: 'C', XDG_RUNTIME_DIR: runtime })
    expect(inspect).not.toHaveBeenCalled()
  })

  it.each([
    { ...directory, uid: uid + 1 },
    { ...directory, mode: 0o40755 },
    { ...directory, isDirectory: () => false },
  ])('refuses a foreign, shared or symlink runtime directory', async (entry) => {
    inspect.mockReset().mockResolvedValueOnce(entry)
    expect(await keyringEnvironment({})).toEqual({ LC_ALL: 'C' })
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ...socket, uid: uid + 1 },
    { ...socket, isSocket: () => false },
  ])('refuses a foreign socket or a non-socket', async (entry) => {
    inspect.mockReset().mockResolvedValueOnce(directory).mockResolvedValueOnce(entry)
    expect(await keyringEnvironment({})).toEqual({ LC_ALL: 'C' })
  })

  it('leaves an unavailable session absent so keyring access still fails visibly', async () => {
    inspect.mockReset().mockRejectedValueOnce(new Error('no session'))
    expect(await keyringEnvironment({})).toEqual({ LC_ALL: 'C' })
  })
})
