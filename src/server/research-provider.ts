import { CallerVisibleError } from './caller-visible-error'

type ResearchProviderErrorCode = 'invalid-response' | 'unavailable'

type ResearchProviderName = 'yahoo'

/** Research providers are contextual only; failures stay coded and never carry provider bodies or credentials. */
export class ResearchProviderError extends CallerVisibleError {
  constructor(code: ResearchProviderErrorCode, provider: ResearchProviderName) {
    super(`ResearchProvider:${provider}:${code}`)
    this.name = 'ResearchProviderError'
  }
}
