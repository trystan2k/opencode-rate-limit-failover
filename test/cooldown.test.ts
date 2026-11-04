import assert from "node:assert/strict"
import { test } from "node:test"
import { CooldownTracker } from "../src/cooldown.ts"

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
