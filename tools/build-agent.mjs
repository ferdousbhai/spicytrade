#!/usr/bin/env node
import { build } from 'esbuild'

/**
 * Bundle the local agent CLI (`ops/spicytrade/`) and its dependencies into one file the site
 * serves at `/spicytrade.mjs`, which `public/install.sh` downloads. One file is what lets a member
 * install with a single `curl … | bash` -- no checkout, no package manager -- and it keeps the
 * entry's name, which `config.mjs` relies on to find itself.
 *
 * It runs before every build and dev server, writing into `public/` so Vite serves and ships it
 * like any other static file; the output is ignored by git, since the source is its record.
 * Unminified, so a member who reads what they are about to run can.
 */
const OUTFILE = 'public/spicytrade.mjs'

await build({
  bundle: true,
  entryPoints: ['ops/spicytrade/spicytrade.mjs'],
  format: 'esm',
  legalComments: 'inline',
  logLevel: 'warning',
  outfile: OUTFILE,
  platform: 'node',
  // The installer refuses an older Node, so the bundle may use anything 22 has.
  target: 'node22',
})
