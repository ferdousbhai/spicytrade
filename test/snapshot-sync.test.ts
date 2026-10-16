import { afterEach, describe, expect, it, vi } from 'vitest'

import { SPICE_DEPLOYMENT_ID_HEADER } from '../src/domain/deployment'
import { type JsonValue } from '../src/domain/json-payload'
import { marketSnapshotFixture } from './fixtures/market'

// vitest.config.ts defines the bundle's own deployment id.
const CURRENT_DEPLOYMENT = 'test'

afterEach(() => {
  vi.resetModules()
})

function snapshotResponse(body: JsonValue, headers: Record<string, string>): Response {
  return Response.json(body, { headers: { [SPICE_DEPLOYMENT_ID_HEADER]: CURRENT_DEPLOYMENT, ...headers } })
}

function notModified(deploymentId = CURRENT_DEPLOYMENT): Response {
  return new Response(null, { status: 304, headers: { [SPICE_DEPLOYMENT_ID_HEADER]: deploymentId } })
}

/** A fresh module per test: the recorded ETag is module state and must not leak between cases. */
async function loadSync(responses: Response[]) {
  const sent: (string | null)[] = []
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get('If-None-Match'))
    const next = responses.shift()
    if (!next) throw new Error('unexpected snapshot request')
    return next
  })
  vi.stubGlobal('fetch', fetchMock)
  const collections = await import('../src/data/collections')
  return { ...collections, sent }
}

describe('snapshot sync ETag', () => {
  it('records an ETag only once the body it names is stored', async () => {
    const snapshot = marketSnapshotFixture()
    const { syncFromCloud, sent } = await loadSync([
      snapshotResponse({ unreadable: true }, { ETag: '"malformed"' }),
      snapshotResponse(snapshot, { ETag: '"superseded"' }),
      snapshotResponse(snapshot, { ETag: '"stored"' }),
      notModified(),
    ])

    // A body this bundle cannot parse was never stored, so its ETag must not buy a 304 later.
    await expect(syncFromCloud('owner')).rejects.toThrow()
    // Nor may a response that was superseded before it hydrated.
    const aborted = new AbortController()
    aborted.abort()
    await expect(syncFromCloud('owner', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(syncFromCloud('owner')).resolves.toEqual(snapshot)
    await expect(syncFromCloud('owner')).resolves.toEqual(snapshot)

    expect(sent).toEqual([null, null, null, '"stored"'])
  })
})

describe('snapshot sync deployment check', () => {
  it('tells an old bundle about a newer deployment even when the data is unchanged', async () => {
    const snapshot = marketSnapshotFixture()
    const { syncFromCloud } = await loadSync([
      snapshotResponse(snapshot, { ETag: '"stored"' }),
      notModified('next-deployment'),
      notModified(),
    ])
    await syncFromCloud('owner')

    // The ETag names the data, not the build, so a quiet market answers an old tab with 304s
    // indefinitely; the deployment header on that 304 is the only way the tab learns to reload.
    await expect(syncFromCloud('owner')).rejects.toMatchObject({
      hydrated: true,
      name: 'DeploymentMismatchError',
      receivedDeploymentId: 'next-deployment',
    })

    await expect(syncFromCloud('owner')).resolves.toEqual(snapshot)
  })

  it('stops claiming an ETag once the record it names is gone, and recovers', async () => {
    const snapshot = marketSnapshotFixture()
    const { syncFromCloud, offlineSnapshotCollection, sent } = await loadSync([
      snapshotResponse(snapshot, { ETag: '"stored"' }),
      snapshotResponse(snapshot, { ETag: '"refetched"' }),
      notModified(),
    ])
    await syncFromCloud('owner')
    // Another tab's newer bundle retiring the key, or the other audience replacing it, leaves
    // this module holding a tag for a body the browser no longer has.
    await offlineSnapshotCollection.delete('snapshot').isPersisted.promise
    await expect(syncFromCloud('owner')).resolves.toEqual(snapshot)
    expect(offlineSnapshotCollection.get('snapshot')?.audience).toBe('owner')
    // Hydrated again, the fresh tag is claimed once more.
    await expect(syncFromCloud('owner')).resolves.toEqual(snapshot)
    expect(sent).toEqual([null, null, '"refetched"'])
  })

  it('refetches without the tag when the record vanishes under an in-flight 304', async () => {
    const snapshot = marketSnapshotFixture()
    const collections = await loadSync([
      snapshotResponse(snapshot, { ETag: '"stored"' }),
    ])
    const { syncFromCloud, offlineSnapshotCollection, sent } = collections
    await syncFromCloud('owner')
    // The record is deleted between the conditional request leaving and its 304 arriving.
    const responses = [notModified(), snapshotResponse(snapshot, { ETag: '"refetched"' })]
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('If-None-Match'))
      const next = responses.shift()
      if (!next) throw new Error('unexpected snapshot request')
      if (next.status === 304) await offlineSnapshotCollection.delete('snapshot').isPersisted.promise
      return next
    }))
    await expect(syncFromCloud('owner')).resolves.toEqual(snapshot)
    expect(sent).toEqual([null, '"stored"', null])
    expect(offlineSnapshotCollection.get('snapshot')?.audience).toBe('owner')
  })

  it('asks for a body on a newer build\'s 304 that has no record to answer with', async () => {
    const snapshot = marketSnapshotFixture()
    const { syncFromCloud, offlineSnapshotCollection, sent } = await loadSync([
      snapshotResponse(snapshot, { ETag: '"stored"' }),
    ])
    await syncFromCloud('owner')
    const responses = [
      notModified('next-deployment'),
      snapshotResponse(snapshot, { ETag: '"next"', [SPICE_DEPLOYMENT_ID_HEADER]: 'next-deployment' }),
      snapshotResponse({ unreadable: true }, { [SPICE_DEPLOYMENT_ID_HEADER]: 'next-deployment' }),
    ]
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('If-None-Match'))
      const next = responses.shift()
      if (!next) throw new Error('unexpected snapshot request')
      if (next.status === 304) await offlineSnapshotCollection.delete('snapshot').isPersisted.promise
      return next
    }))
    // Nothing is on screen, but the newer build's body is readable: it is drawn, and the
    // newer build is still reported so the tab can reload underneath it.
    await expect(syncFromCloud('owner')).rejects.toMatchObject({
      hydrated: true,
      name: 'DeploymentMismatchError',
      receivedDeploymentId: 'next-deployment',
    })
    expect(sent).toEqual([null, '"stored"', null])
    expect(offlineSnapshotCollection.get('snapshot')?.audience).toBe('owner')

    // Only a body this bundle cannot read leaves the screen as it was, and says so.
    await offlineSnapshotCollection.delete('snapshot').isPersisted.promise
    await expect(syncFromCloud('owner')).rejects.toMatchObject({
      hydrated: false,
      name: 'DeploymentMismatchError',
    })
    expect(sent).toEqual([null, '"stored"', null, null])
  })

  it('never sends one audience\'s ETag once the other audience holds the record', async () => {
    const snapshot = marketSnapshotFixture()
    const { syncFromCloud, restoreOfflineSnapshot, sent } = await loadSync([
      snapshotResponse(snapshot, { ETag: '"stored"' }),
      snapshotResponse(snapshot, { ETag: '"again"' }),
    ])
    await syncFromCloud('owner')
    // Restoring the public audience deletes the owner record this tag names.
    await restoreOfflineSnapshot('public')
    await syncFromCloud('owner')
    expect(sent).toEqual([null, null])
  })
})
