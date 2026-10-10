import { z } from 'zod'

// One account is deliberately serialized to at most two broker requests per second. A named
// budget, the owner's choice: tastytrade publishes no per-account rate, so this stays conservatively
// clear of whatever it enforces, while a placement's few sequential round trips still finish in
// seconds. The mutation lease is a crash-recovery backstop; normal callers renew/release it explicitly.
const PERMIT_INTERVAL_MS = 500
const NEXT_PERMIT_KEY = 'next-permit-at'
const MUTATION_LEASE_KEY = 'active-mutation-lease'
// This outlives normal broker request timeouts but eventually releases an evicted caller's lock.
const MUTATION_LEASE_MS = 2 * 60_000
// A waiting mutation re-checks the lease at the permit interval: it could not start a request
// any sooner than the next permit anyway, so polling faster would only spend Durable Object reads.
const MUTATION_LEASE_POLL_MS = PERMIT_INTERVAL_MS

const StoredMutationLeaseSchema = z.object({
  expiresAt: z.number().finite().positive(),
  token: z.string().min(1),
})

type StoredMutationLease = z.infer<typeof StoredMutationLeaseSchema>
export type BrokerGateStoredValue = StoredMutationLease | number

export type BrokerGateStorage = {
  delete(key: string): Promise<boolean>
  get(key: string): Promise<BrokerGateStoredValue | undefined>
  put(key: string, value: BrokerGateStoredValue): Promise<void>
}

export type BrokerGateContext = {
  storage: BrokerGateStorage
  waitUntil(task: Promise<unknown>): void
}

export type BrokerGateScheduler = {
  wait(delay: number): Promise<void>
}

/**
 * Durable broker coordination kept separate from the platform wrapper for direct tests.
 * Mutation leases are persisted because an object may be evicted between the acquire
 * and release RPCs that surround a broker read-modify-write sequence.
 */
export class BrokerGateCore {
  private nextPermitAt = 0
  private mutationTail: Promise<void> = Promise.resolve()
  private activeMutation?: { release: () => void; timeout: ReturnType<typeof setTimeout>; token: string }

  constructor(
    private readonly ctx: BrokerGateContext,
    private readonly permits: BrokerGateScheduler,
    private readonly now: () => number = Date.now,
  ) {}

  async initialize(): Promise<void> {
    const stored = await this.ctx.storage.get(NEXT_PERMIT_KEY)
    this.nextPermitAt = stored === undefined ? 0 : z.number().finite().nonnegative().parse(stored)
  }

  async acquire(): Promise<void> {
    const now = this.now()
    const permitAt = Math.max(now, this.nextPermitAt)
    this.nextPermitAt = permitAt + PERMIT_INTERVAL_MS
    await this.ctx.storage.put(NEXT_PERMIT_KEY, this.nextPermitAt)
    const delay = permitAt - now
    if (delay > 0) await this.permits.wait(delay)
  }

  private async waitForStoredMutationLease(): Promise<void> {
    for (;;) {
      const stored = await this.ctx.storage.get(MUTATION_LEASE_KEY)
      if (stored === undefined) return
      const lease = StoredMutationLeaseSchema.parse(stored)
      const delay = lease.expiresAt - this.now()
      if (delay <= 0) return
      await this.permits.wait(Math.min(delay, MUTATION_LEASE_POLL_MS))
    }
  }

  async acquireMutation(): Promise<string> {
    const previous = this.mutationTail
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.mutationTail = previous.then(() => current)
    try {
      await previous
      await this.waitForStoredMutationLease()
      const token = crypto.randomUUID()
      await this.ctx.storage.put(MUTATION_LEASE_KEY, {
        expiresAt: this.now() + MUTATION_LEASE_MS,
        token,
      } satisfies StoredMutationLease)
      const timeout = this.expiryTimer(token, MUTATION_LEASE_MS)
      this.activeMutation = { release, timeout, token }
      return token
    } catch (error) {
      release()
      throw error
    }
  }

  /**
   * Answers whether `token` still held the lease (and now holds it longer). A lost lease is a
   * result, not a throw: an error crossing Durable Object RPC loses its class, and the caller
   * owns the caller-visible wording (`BrokerMutationLeaseExpiredError` in `tastytrade.ts`).
   */
  async renewMutation(token: string): Promise<boolean> {
    const value = await this.ctx.storage.get(MUTATION_LEASE_KEY)
    const stored = StoredMutationLeaseSchema.safeParse(value).data
    if (!stored || stored.token !== token || stored.expiresAt <= this.now()) return false
    await this.ctx.storage.put(MUTATION_LEASE_KEY, {
      expiresAt: this.now() + MUTATION_LEASE_MS,
      token,
    } satisfies StoredMutationLease)
    if (this.activeMutation?.token === token) {
      clearTimeout(this.activeMutation.timeout)
      this.activeMutation.timeout = this.expiryTimer(token, MUTATION_LEASE_MS)
    }
    return true
  }

  async releaseMutation(token: string): Promise<void> {
    const value = await this.ctx.storage.get(MUTATION_LEASE_KEY)
    const stored = StoredMutationLeaseSchema.safeParse(value).data
    if (value !== undefined && (!stored || stored.token !== token)) return
    if (stored) await this.ctx.storage.delete(MUTATION_LEASE_KEY)
    if (this.activeMutation?.token !== token) return
    clearTimeout(this.activeMutation.timeout)
    const { release } = this.activeMutation
    this.activeMutation = undefined
    release()
  }

  private async expireMutation(token: string): Promise<void> {
    const value = await this.ctx.storage.get(MUTATION_LEASE_KEY)
    const stored = StoredMutationLeaseSchema.safeParse(value).data
    if (!stored || stored.token !== token) return
    const remaining = stored.expiresAt - this.now()
    if (remaining > 0) {
      // A renewal can persist before the old timer callback observes it. Honor the
      // durable expiry instead of letting that stale callback release the live lease.
      if (this.activeMutation?.token === token) {
        this.activeMutation.timeout = this.expiryTimer(token, remaining)
      }
      return
    }
    await this.releaseMutation(token)
  }

  private expiryTimer(token: string, delay: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.ctx.waitUntil(this.expireMutation(token))
    }, delay)
  }
}
