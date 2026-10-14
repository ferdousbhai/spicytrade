#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

/**
 * Apply pending D1 migrations, but only from a Workers Builds production build.
 *
 * This runs at the END of `npm run build` rather than in the deploy step, which is where it
 * belongs and where this repository's rule used to put it. The deploy command is configured in
 * the Cloudflare dashboard as a bare `npx cf deploy --prebuilt` and cannot be changed through the
 * API with the credentials available here, so the build command — which is
 * `npm run workers-builds:build` (ending in `npm run build`), and therefore ours to define — is
 * the only lever the repository actually has. On 2026-09-04 a push shipped code whose three new
 * tables did not exist because nothing applied them at all; a slightly worse-placed apply beats
 * no apply.
 *
 * Workers Builds installs the lockfile dependencies before that command; the script reuses
 * that install rather than running npm ci a second time.
 *
 * Ordering is the thing that makes it defensible. Because this is the last step of the build,
 * everything that can fail on the way to a deployable artifact — the bundle, the typecheck — has
 * already succeeded. The only failure that can still strand the schema ahead of the code is
 * `cf deploy` itself, which is exactly the exposure the deploy-step version would have had.
 *
 * Two guards keep it from being a footgun:
 *   - `WORKERS_CI` is injected only by Workers Builds, so a developer running `npm run build`
 *     locally on a feature branch never touches the production database. `npm run deploy` still
 *     applies migrations explicitly for a deliberate deploy from a workstation.
 *   - The branch check means enabling preview builds later cannot point a preview at production
 *     schema. Previews are off today; this is here so turning them on stays safe.
 */
const PRODUCTION_BRANCH = 'main'

if (!process.env.WORKERS_CI) {
  process.stdout.write('Migrations: skipped (not a Workers Builds build).\n')
  process.exit(0)
}

const branch = process.env.WORKERS_CI_BRANCH
if (branch !== PRODUCTION_BRANCH) {
  process.stdout.write(`Migrations: skipped (branch ${branch ?? 'unknown'} is not ${PRODUCTION_BRANCH}).\n`)
  process.exit(0)
}

process.stdout.write('Migrations: applying to the production database.\n')
// cf takes the database id rather than the binding name, and applies to the remote database
// unless told `--local`. The id is the `DB` binding's in cloudflare.config.ts.
const result = spawnSync(
  'npx',
  ['cf', 'd1', 'migrations', 'apply', 'e45e35cc-bd01-4e29-8940-b5d2ef5e840c', '--dir', 'migrations'],
  { stdio: 'inherit' },
)

// Fail the build rather than the deploy. A build that stops here leaves the schema and the live
// code exactly as they were, which is the safe direction: nothing has been deployed yet.
if (result.status !== 0) {
  process.stderr.write('Migrations: apply failed; failing the build before anything deploys.\n')
  process.exit(result.status ?? 1)
}
