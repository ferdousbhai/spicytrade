import { internalInstrumentCatalogChunkFromTastytrade } from '../../src/server/tastytrade'
import { summarizeOwnerMarketSync } from '../shared/market-sync'
import { type OpsEnv, serveOpsRequest } from '../shared/worker-auth'

const CATALOG_PATHS = ['/preview', '/apply', '/sync']

export default {
  fetch(request: Request, env: OpsEnv): Promise<Response> {
    return serveOpsRequest(request, env, CATALOG_PATHS, 'InstrumentCatalog:operation-failed', async (path) => {
      if (path === '/sync') {
        return Response.json({ mode: 'sync', sync: await summarizeOwnerMarketSync(env) })
      }
      const offsetValue = new URL(request.url).searchParams.get('offset') ?? '0'
      const offset = Number(offsetValue)
      if (!/^\d+$/.test(offsetValue) || !Number.isSafeInteger(offset)) {
        throw new Error('InstrumentCatalog:invalid-offset')
      }
      const result = await internalInstrumentCatalogChunkFromTastytrade(env, offset, path !== '/preview')
      return Response.json({
        mode: path.slice(1),
        result,
      })
    })
  },
}
