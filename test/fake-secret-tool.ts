import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A `secret-tool` stand-in on PATH: a directory holding one file per `service/key` under
 * `store/`, plus the script itself, so a test exercises the real keyring code path
 * (`lookup`/`store` over argv and stdin) rather than a stub that never touches a CLI at all.
 *
 * `lookup` exits 1 with no stdout for an absent entry, matching secret-tool's own behavior for
 * "not stored" -- never a stored value and never a false positive. `store` reads the value from
 * stdin, exactly as `keyringStore` sends it, and lands it in the same `store/` directory a
 * caller can read back to assert what was persisted. `clear` removes an entry, as the credential
 * script does with a token spicytrade refused.
 *
 * Keyed by `service/key` rather than key alone, because the service is what separates spicytrade's
 * own token from a broker's credentials, and a stand-in that collapsed them could not notice
 * them being confused.
 */
export async function fakeSecretTool(entries: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'spice-secret-tool-'))
  const store = join(directory, 'store')
  await mkdir(store)
  for (const [path, value] of Object.entries(entries)) {
    await writeFile(join(store, path.replace('/', '_')), value)
  }
  await writeFile(join(directory, 'secret-tool'), `#!/usr/bin/env bash
store='${store}'
if [[ $1 == lookup ]]; then
  [[ -f "$store/$3_$5" ]] || exit 1
  cat "$store/$3_$5"
elif [[ $1 == store ]]; then
  cat > "$store/$4_$6"
elif [[ $1 == clear ]]; then
  rm -f "$store/$3_$5"
fi
`)
  await chmod(join(directory, 'secret-tool'), 0o755)
  return directory
}
