function unsupported(): never {
  throw new Error('UnsupportedBrowserRunCall')
}

// Every Browser Run call these fakes do not answer throws, so a new call path fails loudly.
const UNSUPPORTED_CALLS = {
  acquire: unsupported,
  closeSession: unsupported,
  connectSession: unsupported,
  fetch: unsupported,
  getLiveView: unsupported,
  getSession: unsupported,
  history: unsupported,
  launch: unsupported,
  limits: unsupported,
  listSessions: unsupported,
  script: unsupported,
}

/**
 * A Browser Run binding whose only working call is the markdown quick action `record_catalysts`
 * and `record_evidence` make to re-read a cited page (src/server/research-page-retention.ts).
 * Every other call throws, so a code path reaching for
 * more than that fails loudly instead of reading a silent stub.
 */
export function markdownBrowser(markdown: string): BrowserRun {
  return {
    ...UNSUPPORTED_CALLS,
    // A getter, so it cannot ride in the spread above without being called.
    get devtools(): never {
      return unsupported()
    },
    quickAction: async () => Response.json({ result: markdown, success: true }),
  }
}

/** The same binding for the path where a cited page will not open at all. */
export function unreadableBrowser(): BrowserRun {
  return {
    ...UNSUPPORTED_CALLS,
    // A getter, so it cannot ride in the spread above without being called.
    get devtools(): never {
      return unsupported()
    },
    quickAction: async () => new Response('', { status: 502 }),
  }
}

/**
 * The same binding serving a different page per address, for a producer that reads several. An
 * address it does not hold does not open, and every address asked for is recorded in `reads`.
 */
export function pagesBrowser(pages: Readonly<Record<string, string>>): BrowserRun & { reads: string[] } {
  const reads: string[] = []
  // SAFETY: `quickAction` is BrowserRun's overloaded method; this one implementation answers the
  // markdown overload the retention module calls, and every other method throws.
  return {
    ...UNSUPPORTED_CALLS,
    // A getter, so it cannot ride in the spread above without being called.
    get devtools(): never {
      return unsupported()
    },
    quickAction: async (_action: string, options: { url?: string }) => {
      const url = options.url ?? ''
      reads.push(url)
      const markdown = pages[url]
      return markdown === undefined
        ? new Response('', { status: 502 })
        : Response.json({ result: markdown, success: true })
    },
    reads,
  } as BrowserRun & { reads: string[] }
}
