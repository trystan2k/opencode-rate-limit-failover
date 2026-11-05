/**
 * Per-session cooldown memory.
 *
 * After a model rate-limits for a session it is considered unhealthy as a
 * failover target for a while. This is the guard that turns X↔Y route pairs
 * from an infinite ping-pong into a graceful stop (the error surfaces once
 * every candidate is in cooldown).
 */

export class CooldownTracker {
  private until = new Map<string, Map<string, number>>()

  /**
   * Record a failure of `key` for `sessionID`. The model is considered
   * unhealthy until `now + max(cooldownMs, retryAfterMs)`.
   */
  mark(sessionID: string, key: string, retryAfterMs: number | undefined, cooldownMs: number, now = Date.now()): void {
    let entries = this.until.get(sessionID)
    if (!entries) {
      entries = new Map()
      this.until.set(sessionID, entries)
    }
    const hint = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? retryAfterMs : 0
    entries.set(key, now + Math.max(cooldownMs, hint, 1_000))
    // Prune expired entries so per-session maps stay small.
    for (const [k, expiry] of entries) if (expiry <= now) entries.delete(k)
  }

  isHealthy(sessionID: string, key: string, now = Date.now()): boolean {
    const expiry = this.until.get(sessionID)?.get(key)
    return expiry === undefined || expiry <= now
  }

  /** First candidate that is not in cooldown for the session. */
  pickHealthy(sessionID: string, candidates: readonly string[], now = Date.now()): string | undefined {
    return candidates.find((candidate) => this.isHealthy(sessionID, candidate, now))
  }

  clear(sessionID: string): void {
    this.until.delete(sessionID)
  }
}

export interface HandoffRecord {
  from: string
  to: string
  /** When the handoff was committed. */
  at: number
  /** Consecutive attempts of this exact handoff without an intervening success. */
  attempts: number
}

/**
 * Loop guard for repeated failover attempts on the same session.
 *
 * A handoff can silently fail to take effect — e.g. the session's agent pins
 * its model in frontmatter, so `switchModel` updates the session but every
 * execution still runs (and fails) on the pinned model. Without a guard each
 * recurrence triggers another identical switch + resume, in a tight loop. The
 * guard spaces consecutive identical handoffs out exponentially and blocks
 * them entirely after `maxAttempts`; state resets when an execution succeeds
 * (or the session is deleted/interrupted).
 */
export class HandoffGuard {
  private readonly maxAttempts: number
  private last = new Map<string, HandoffRecord>()

  constructor(maxAttempts: number) {
    this.maxAttempts = maxAttempts
  }

  /**
   * True when the same `from → to` handoff was attempted for `sessionID`
   * recently enough that retrying now would just repeat a known-ineffective
   * switch: within `maxAttempts` consecutive attempts and inside the
   * exponential backoff window `baseBackoffMs * 2^(attempts-1)` (capped at
   * `capMs`). Once `maxAttempts` is reached, the handoff stays blocked until
   * `clear()`.
   */
  blocked(
    sessionID: string,
    from: string,
    to: string,
    baseBackoffMs: number,
    capMs: number,
    now = Date.now(),
  ): boolean {
    const last = this.last.get(sessionID)
    if (!last || last.from !== from || last.to !== to) return false
    if (last.attempts >= this.maxAttempts) return true
    const backoff = Math.min(baseBackoffMs * 2 ** (last.attempts - 1), capMs)
    return now < last.at + backoff
  }

  /** Record a committed handoff attempt, bumping the consecutive-attempt count. */
  mark(sessionID: string, from: string, to: string, now = Date.now()): void {
    const last = this.last.get(sessionID)
    const attempts = last && last.from === from && last.to === to ? last.attempts + 1 : 1
    this.last.set(sessionID, { from, to, at: now, attempts })
  }

  /** True when this exact handoff already used up all its attempts. */
  exhausted(sessionID: string, from: string, to: string): boolean {
    const last = this.last.get(sessionID)
    return !!last && last.from === from && last.to === to && last.attempts >= this.maxAttempts
  }

  clear(sessionID: string): void {
    this.last.delete(sessionID)
  }
}
