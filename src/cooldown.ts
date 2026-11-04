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
