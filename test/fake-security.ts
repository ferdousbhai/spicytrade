import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A stand-in for macOS's `security` on PATH, file-backed like `fakeSecretTool`, speaking only the
 * commands `keyring.mjs` sends: `find-generic-password … -w`, `delete-generic-password`, and one
 * `add-generic-password` line on the stdin of `-i`. Like the real one it exits 44, with a line on
 * stderr, for an entry that is not there, and records every argv it was started with in `argv`,
 * so a test can assert that no secret was ever an argument.
 *
 * It is written from `security`'s documented behavior and has not been compared with a Mac.
 */
export async function fakeSecurity(entries: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'spice-security-'))
  const store = join(directory, 'store')
  await mkdir(store)
  for (const [path, value] of Object.entries(entries)) {
    await writeFile(join(store, path.replace('/', '_')), value)
  }
  await writeFile(join(directory, 'security'), `#!/usr/bin/env bash
store='${store}'
printf '%s\\n' "$*" >> '${join(directory, 'argv')}'
attributes() {
  service= account= password= hex=
  while (($#)); do
    case $1 in
      -s) service=$2; shift ;;
      -a) account=$2; shift ;;
      -l) shift ;;
      -w) password=\${2-}; (($# > 1)) && shift ;;
      -X) hex=$2; shift ;;
    esac
    shift
  done
}
missing() {
  echo 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2
  exit 44
}
if [[ $1 == -i ]]; then
  IFS= read -r line
  # The interactive mode splits on spaces and honours double quotes, as a shell does here.
  eval "set -- $line"
  [[ $1 == add-generic-password ]] || exit 2
  shift
  attributes "$@"
  [[ -n $hex ]] && password=$(printf '%s' "$hex" | xxd -r -p)
  printf '%s' "$password" > "$store/\${service}_$account"
elif [[ $1 == find-generic-password ]]; then
  shift
  attributes "$@"
  [[ -f "$store/\${service}_$account" ]] || missing
  cat "$store/\${service}_$account"
  echo
elif [[ $1 == delete-generic-password ]]; then
  shift
  attributes "$@"
  [[ -f "$store/\${service}_$account" ]] || missing
  rm -f "$store/\${service}_$account"
fi
`)
  await chmod(join(directory, 'security'), 0o755)
  return directory
}
