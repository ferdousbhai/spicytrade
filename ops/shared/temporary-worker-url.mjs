import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export function extractTemporaryWorkerUrl(output, workerName) {
  const workerLabel = workerName.toLowerCase()
  const candidates = output.match(/https:\/\/[^\s"'<>,]+/g) ?? []
  for (const candidate of candidates.toReversed()) {
    try {
      const url = new URL(candidate)
      if (url.hostname.startsWith(`${workerLabel}.`)
        && url.hostname.endsWith('.workers.dev')) {
        return url.origin
      }
    } catch {
      // The log holds deploy prose and JSON; a candidate may carry trailing punctuation.
    }
  }
  throw new Error(`Cloudflare did not report the workers.dev URL for ${workerName}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [logPath, workerName] = process.argv.slice(2)
  if (!logPath || !workerName) {
    throw new Error('Usage: temporary-worker-url.mjs LOG WORKER_NAME')
  }
  process.stdout.write(`${extractTemporaryWorkerUrl(await readFile(logPath, 'utf8'), workerName)}\n`)
}
