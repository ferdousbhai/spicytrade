import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/**
 * Agent hosts may omit the desktop environment even while the user's session bus is running.
 * Discover only that user's existing bus; never start a second bus or override an explicit
 * address/runtime directory. Ownership and private directory permissions prevent discovery
 * from routing credentials through another user's socket. Failure leaves discovery absent,
 * so secret-tool reports the real failure rather than treating the keyring as empty.
 */
export async function keyringEnvironment(env = process.env, inspect = lstat) {
  const result = { ...env, LC_ALL: 'C' }
  if (process.platform !== 'linux' || env.DBUS_SESSION_BUS_ADDRESS !== undefined) return result
  const uid = process.geteuid()
  // /run/user/<uid> is the Linux systemd user runtime location, not a portable XDG default.
  const runtime = env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`
  if (!isAbsolute(runtime)) return result
  const socket = join(runtime, 'bus')
  try {
    const directory = await inspect(runtime)
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700) return result
    const bus = await inspect(socket)
    if (!bus.isSocket() || bus.uid !== uid) return result
  } catch {
    return result
  }
  // D-Bus addresses use percent-escaped bytes, including commas and semicolons in paths.
  const address = encodeURIComponent(socket).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)
  return { ...result, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${address}` }
}
