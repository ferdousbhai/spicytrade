import { spawnSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { LEGACY_UNIT_NAMES } from './config.mjs'

/**
 * The background proxy that agents reached over `127.0.0.1:8787` before they launched
 * `spicytrade mcp` themselves. It ran as a systemd user unit; `setup` removes any that is left,
 * and `doctor` flags one, since a stale proxy would keep serving entries `setup` has not moved.
 */

function unitPath(name) {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', name)
}

function systemctl(...args) {
  return spawnSync('systemctl', ['--user', ...args], { stdio: 'ignore' }).status === 0
}

/** The retired units still on this machine. */
export async function legacyUnits() {
  const present = await Promise.all(LEGACY_UNIT_NAMES.map((name) => readFile(unitPath(name)).then(() => true, () => false)))
  return LEGACY_UNIT_NAMES.filter((_, index) => present[index])
}

/** Stop, disable and delete each retired unit; resolves with the names removed. */
export async function removeLegacyUnits() {
  const units = await legacyUnits()
  for (const name of units) {
    // Either may fail on a unit systemd has already forgotten; the file going is what matters.
    systemctl('stop', name)
    systemctl('disable', name)
    await rm(unitPath(name))
  }
  if (units.length) systemctl('daemon-reload')
  return units
}
