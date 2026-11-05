import assert from "node:assert/strict"
import { test } from "node:test"
import { CooldownTracker, HandoffGuard } from "../src/cooldown.ts"

test("a marked model is unhealthy until the cooldown expires", () => {
  const tracker = new CooldownTracker()
  tracker.mark("s1", "a/x", undefined, 60_000, 1_000)
  // until = 1_000 + 60_000 = 61_000; healthy from the expiry instant onwards.
  assert.equal(tracker.isHealthy("s1", "a/x", 60_999), false)
  assert.equal(tracker.isHealthy("s1", "a/x", 61_000), true)
  assert.equal(tracker.isHealthy("s1", "a/x", 61_001), true)
})

test("cooldowns are per session and per model", () => {
  const tracker = new CooldownTracker()
  tracker.mark("s1", "a/x", undefined, 60_000, 0)
  assert.equal(tracker.isHealthy("s1", "b/y", 1), true)
  assert.equal(tracker.isHealthy("s2", "a/x", 1), true)
  assert.equal(tracker.isHealthy("s1", "a/x", 1), false)
})

test("retryAfterMs extends the cooldown", () => {
  const tracker = new CooldownTracker()
  tracker.mark("s1", "a/x", 300_000, 60_000, 0)
  assert.equal(tracker.isHealthy("s1", "a/x", 60_000), false)
  assert.equal(tracker.isHealthy("s1", "a/x", 300_001), true)
})

test("the cooldown has a 1s floor", () => {
  const tracker = new CooldownTracker()
  tracker.mark("s1", "a/x", undefined, 0, 0)
  assert.equal(tracker.isHealthy("s1", "a/x", 999), false)
  assert.equal(tracker.isHealthy("s1", "a/x", 1_000), true)
})

test("pickHealthy skips cooling targets and prefers the first healthy one", () => {
  const tracker = new CooldownTracker()
  tracker.mark("s1", "b/y", undefined, 60_000, 0)
  assert.equal(tracker.pickHealthy("s1", ["b/y"], 1), undefined)
  assert.equal(tracker.pickHealthy("s1", ["b/y", "c/z"], 1), "c/z")
  assert.equal(tracker.pickHealthy("s1", ["c/z", "b/y"], 1), "c/z")
})

test("clear removes all state for a session", () => {
  const tracker = new CooldownTracker()
  tracker.mark("s1", "a/x", undefined, 60_000, 0)
  tracker.clear("s1")
  assert.equal(tracker.isHealthy("s1", "a/x", 1), true)
})

test("HandoffGuard blocks an identical handoff within the backoff window", () => {
  const guard = new HandoffGuard(3)
  assert.equal(guard.blocked("s1", "a/x", "b/y", 60_000, 30 * 60_000, 0), false)
  guard.mark("s1", "a/x", "b/y", 0)
  // attempts=1 → 60s backoff.
  assert.equal(guard.blocked("s1", "a/x", "b/y", 60_000, 30 * 60_000, 59_999), true)
  assert.equal(guard.blocked("s1", "a/x", "b/y", 60_000, 30 * 60_000, 60_000), false)
})

test("HandoffGuard backs off exponentially per consecutive attempt", () => {
  const guard = new HandoffGuard(99)
  guard.mark("s1", "a/x", "b/y", 0) // attempts=1 → 60s
  guard.mark("s1", "a/x", "b/y", 0) // attempts=2 → 120s
  assert.equal(guard.blocked("s1", "a/x", "b/y", 60_000, 30 * 60_000, 100_000), true)
  assert.equal(guard.blocked("s1", "a/x", "b/y", 60_000, 30 * 60_000, 120_000), false)
})

test("HandoffGuard stops entirely once attempts are exhausted", () => {
  const guard = new HandoffGuard(3)
  guard.mark("s1", "a/x", "b/y", 0)
  guard.mark("s1", "a/x", "b/y", 0)
  guard.mark("s1", "a/x", "b/y", 0)
  // Even long after any backoff, the handoff stays blocked until cleared.
  assert.equal(guard.blocked("s1", "a/x", "b/y", 60_000, 30 * 60_000, 86_400_000), true)
  guard.clear("s1")
  assert.equal(guard.blocked("s1", "a/x", "b/y", 60_000, 30 * 60_000, 0), false)
})

test("HandoffGuard is per session and per handoff pair", () => {
  const guard = new HandoffGuard(3)
  guard.mark("s1", "a/x", "b/y", 0)
  assert.equal(guard.blocked("s2", "a/x", "b/y", 60_000, 30 * 60_000, 0), false)
  // A different pair (ping-pong direction) is not blocked by the first.
  assert.equal(guard.blocked("s1", "b/y", "a/x", 60_000, 30 * 60_000, 0), false)
  // A different pair resets the attempt count to 1.
  guard.mark("s1", "b/y", "a/x", 0)
  assert.equal(guard.blocked("s1", "b/y", "a/x", 60_000, 30 * 60_000, 59_999), true)
  assert.equal(guard.blocked("s1", "b/y", "a/x", 60_000, 30 * 60_000, 60_000), false)
})

test("HandoffGuard backoff is capped", () => {
  const guard = new HandoffGuard(99)
  guard.mark("s1", "a/x", "b/y", 0)
  guard.mark("s1", "a/x", "b/y", 0)
  guard.mark("s1", "a/x", "b/y", 0)
  guard.mark("s1", "a/x", "b/y", 0) // attempts=4 → uncapped 480s, capped to 300s
  assert.equal(guard.blocked("s1", "a/x", "b/y", 60_000, 300_000, 299_999), true)
  assert.equal(guard.blocked("s1", "a/x", "b/y", 60_000, 300_000, 300_000), false)
})
