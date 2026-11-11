import { createServerFn } from '@tanstack/react-start'

import { errorName, toError } from '../domain/failure'
import { EquitySymbolSchema } from '../domain/instrument'
import { IsoDateSchema } from '../domain/iso-date'
import { readBriefArchive, readBriefPage, readSymbolPage } from './public-pages'
import { appEnv } from './worker-env'

/*
 * The server functions the public pages' loaders call. A loader runs on the server for a
 * document request and in the browser on a client navigation, so its store read has to be a
 * server function; in the browser each of these is an anonymous GET to this Worker.
 *
 * That makes every one a public endpoint of its own. The input is re-validated here against the
 * repository's symbol and date rules whatever the loader already checked, the bindings are read
 * inside the handler, and a failed read is logged by error name and rethrown as one fixed
 * message, so no stored payload or parse detail travels to the caller in an error body.
 */

async function publicPageRead<T>(event: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    console.error(event, errorName(toError(error)))
    throw new Error('Public page is temporarily unavailable')
  }
}

export const loadSymbolPage = createServerFn({ method: 'GET' })
  .validator(EquitySymbolSchema)
  .handler(({ data }) => publicPageRead('SymbolPageUnavailable', () => readSymbolPage(appEnv, data)))

export const loadBriefPage = createServerFn({ method: 'GET' })
  .validator(IsoDateSchema)
  .handler(({ data }) => publicPageRead('BriefPageUnavailable', () => readBriefPage(appEnv, data)))

export const loadBriefArchive = createServerFn({ method: 'GET' })
  .handler(() => publicPageRead('BriefArchiveUnavailable', () => readBriefArchive(appEnv)))
