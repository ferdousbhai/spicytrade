import { useEffect, useRef } from 'react'

import { PUBLIC_RESPONSE_MAX_AGE_SECONDS } from '../domain/deployment'

// Re-read cheap calendar/check endpoints on the public-response cadence. Research remains
// deduplicated by the server's receipt; its daily cost policy must not become a browser cache.
export const CATALYST_BROWSER_REVALIDATE_MS = PUBLIC_RESPONSE_MAX_AGE_SECONDS * 1_000

export function useCatalystRevalidation(revalidate: () => void): void {
  const latest = useRef(revalidate)
  useEffect(() => { latest.current = revalidate })
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'hidden') latest.current()
    }
    const timer = setInterval(check, CATALYST_BROWSER_REVALIDATE_MS)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])
}
