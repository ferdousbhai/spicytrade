import { readFile } from 'node:fs/promises'

const [tokenPath, baseUrl, endpoint] = process.argv.slice(2)
if (!tokenPath || !baseUrl || !endpoint) throw new Error('Usage: call-worker.mjs TOKEN URL ENDPOINT')
const token = (await readFile(tokenPath, 'utf8')).trim()
// Give a newly deployed temporary workers.dev route 30 seconds to propagate.
const DEPLOYMENT_READY_ATTEMPTS = 30
const DEPLOYMENT_RETRY_DELAY_MS = 1_000
// A provider-backed ops call has its own 20-second upstream bound. This larger
// envelope leaves room for D1 work while ensuring one hung request cannot hold a
// secret-bearing temporary deployment open indefinitely.
const TEMPORARY_WORKER_REQUEST_TIMEOUT_MS = 60_000

for (let attempt = 0; attempt < DEPLOYMENT_READY_ATTEMPTS; attempt += 1) {
  const headers = new Headers({ Authorization: `Bearer ${token}` })
  const response = await fetch(`${baseUrl}/${endpoint}`, {
    headers,
    method: 'POST',
    signal: AbortSignal.timeout(TEMPORARY_WORKER_REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  // The shared ops gate answers an unauthorized or unknown request with the same
  // 404 a freshly deployed Worker returns before its route propagates, so the
  // only safe reading here is "not ready yet": retry, and fail with the last
  // response once the attempts run out.
  if (response.status === 404 && attempt + 1 < DEPLOYMENT_READY_ATTEMPTS) {
    await new Promise((resolve) => setTimeout(resolve, DEPLOYMENT_RETRY_DELAY_MS))
    continue
  }
  if (!response.ok) throw new Error(text)
  process.stdout.write(`${JSON.stringify(JSON.parse(text), null, 2)}\n`)
  process.exit(0)
}

throw new Error('Temporary Worker did not become ready')
