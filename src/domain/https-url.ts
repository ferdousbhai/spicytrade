import { z } from 'zod'

/**
 * The https rule stored catalyst rows were written under, kept for reading them. What a producer
 * may cite from here on is `CitedSourceUrlSchema`.
 */
export const HttpsSourceUrlSchema = z.string().url()
  .refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS source URL')

/**
 * The envelope a cited source arrives in, wherever it is cited: a page address and the page's
 * own title. Every surface that admits a citation -- a recorded catalyst, an evidence card, a
 * brief's reading list -- holds it to these, so a page one may cite is a page the others may
 * cite. The address bound is a rendering and storage envelope, not a URL-spec limit; the title
 * is held to one line at the card's measure.
 */
export const MAX_CITED_SOURCE_URL_LENGTH = 2_000
export const MAX_CITED_SOURCE_TITLE_LENGTH = 180

/**
 * Whether a parsed address is one a citation may name: https on its default port, no
 * credentials, and a host name rather than a literal address. A published source is never a
 * literal address, and that shape is what turns a reading tool into a probe of somewhere it was
 * never meant to reach; credentials in the authority are how a link names one host and reaches
 * another. The one acceptance rule for a cited page, whether it is keyed for a re-read, stored
 * as a citation, or rendered as a link from model text.
 */
export function isCitablePageUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false
  if (url.port !== '' && url.port !== '443') return false
  return !/^\[|^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)
}

/** `isCitablePageUrl` for a string that may not parse at all. */
export function isCitablePageAddress(value: string): boolean {
  try {
    return isCitablePageUrl(new URL(value))
  } catch {
    return false
  }
}

/** The host a reader is shown for a cited page, without a leading `www.`. */
export function sourceHost(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '')
}

/** A cited page address as every surface admits it: citable, and inside the envelope. */
export const CitedSourceUrlSchema = HttpsSourceUrlSchema.pipe(z.string().max(MAX_CITED_SOURCE_URL_LENGTH))
  .refine(isCitablePageAddress, 'Cite a page by host name over default-port https, without credentials')
