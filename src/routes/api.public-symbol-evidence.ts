import { createFileRoute } from '@tanstack/react-router'

import { EquitySymbolSchema } from '../domain/instrument'
import { errorName, toError } from '../domain/failure'
import { jsonNoStore, jsonPublic } from '../server/http'
import { readSymbolEvidence } from '../server/symbol-evidence'
import { appEnv } from '../server/worker-env'

/** The evidence cards members' agents have attached to one symbol, newest first. */
export const Route = createFileRoute('/api/public-symbol-evidence')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const symbol = EquitySymbolSchema.safeParse(new URL(request.url).searchParams.get('symbol'))
        if (!symbol.success) return jsonNoStore({ error: 'Invalid symbol' }, { status: 400 })
        if (!appEnv.DB) return jsonNoStore({ error: 'Symbol evidence is unavailable' }, { status: 503 })
        try {
          // The store selects no account column, so nothing account-derived can reach this
          // response; a card's only attribution is the byline its recorder chose.
          return jsonPublic({ evidence: await readSymbolEvidence(appEnv.DB, symbol.data) })
        } catch (error) {
          console.error('SymbolEvidenceUnavailable', errorName(toError(error)))
          return jsonNoStore({ error: 'Symbol evidence is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
