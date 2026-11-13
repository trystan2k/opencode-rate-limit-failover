import assert from "node:assert/strict"
import { test } from "node:test"
import {
  compileConfig,
  isRateLimit,
  modelKey,
  parseModelKey,
  resetHintMs,
  DEFAULT_CONTINUE_TEXT,
  DEFAULT_PATTERN,
} from "../src/config.ts"

test("compileConfig returns undefined when no routes are configured", () => {
  assert.equal(compileConfig({}, undefined), undefined)
  assert.equal(compileConfig(undefined, {}), undefined)
  assert.equal(compileConfig({ routes: {} }, undefined), undefined)
})

test("pairs produce bidirectional routes", () => {
  const cfg = compileConfig({ pairs: [["a/x", "b/y"]] }, undefined)
  assert.deepEqual(cfg?.routes, { "a/x": ["b/y"], "b/y": ["a/x"] })
})

test("routes are directed; targets are tried in order and deduplicated", () => {
  const cfg = compileConfig(
    { routes: { "a/x": ["b/y", "c/z"] }, pairs: [["b/y", "a/x"]] },
    undefined,
  )
  assert.deepEqual(cfg?.routes, { "a/x": ["b/y", "c/z"], "b/y": ["a/x"] })
})

test("invalid model refs and self-routes are ignored", () => {
  const cfg = compileConfig(
    {
      routes: {
        "no-slash": ["a/x"],
        "a/x": ["also-no-slash", "/leading", "trailing/", "a/x", "b/y"],
        "": ["a/x"],
      },
    },
    undefined,
  )
  assert.deepEqual(cfg?.routes, { "a/x": ["b/y"] })
})

test("options override the file per key", () => {
  const cfg = compileConfig(
    { routes: { "a/x": ["b/y"] }, afterAttempts: 3, scope: "all" },
    { routes: { "c/z": ["d/w"] }, afterAttempts: 1, scope: "subagents" },
  )
  assert.deepEqual(cfg?.routes, { "a/x": ["b/y"], "c/z": ["d/w"] })
  assert.equal(cfg?.afterAttempts, 1)
  assert.equal(cfg?.scope, "subagents")
})

test("defaults are applied", () => {
  const cfg = compileConfig({ routes: { "a/x": ["b/y"] } }, undefined)
  assert.deepEqual(cfg?.statuses, [429])
  assert.equal(cfg?.pattern?.source, DEFAULT_PATTERN)
  assert.equal(cfg?.afterAttempts, 2)
  assert.equal(cfg?.cooldownMs, 60_000)
  assert.equal(cfg?.continueText, DEFAULT_CONTINUE_TEXT)
  assert.equal(cfg?.mode, "resume")
  assert.equal(cfg?.scope, "all")
  assert.equal(cfg?.annotate, false)
  assert.equal(cfg?.notifyParent, true)
})

test("notifyParent defaults on and can be turned off from options or file", () => {
  assert.equal(compileConfig({ routes: { "a/x": ["b/y"] } }, undefined)?.notifyParent, true)
  assert.equal(compileConfig({ routes: { "a/x": ["b/y"] }, notifyParent: false }, undefined)?.notifyParent, false)
  assert.equal(compileConfig({ routes: { "a/x": ["b/y"] } }, { notifyParent: false })?.notifyParent, false)
  assert.equal(compileConfig({ routes: { "a/x": ["b/y"] }, notifyParent: false }, { notifyParent: true })?.notifyParent, true)
})

test("statuses are sanitized; an empty list falls back to 429", () => {
  const cfg = compileConfig({ routes: { "a/x": ["b/y"] }, statuses: [429, "500", 99, 600, 529] }, undefined)
  assert.deepEqual(cfg?.statuses, [429, 500, 529])
  const fallback = compileConfig({ routes: { "a/x": ["b/y"] }, statuses: ["nope"] }, undefined)
  assert.deepEqual(fallback?.statuses, [429])
})

test("afterAttempts and cooldownMs are parsed with minimums", () => {
  const cfg = compileConfig({ routes: { "a/x": ["b/y"] }, afterAttempts: "3", cooldownMs: 0 }, undefined)
  assert.equal(cfg?.afterAttempts, 3)
  assert.equal(cfg?.cooldownMs, 0)
  const floored = compileConfig({ routes: { "a/x": ["b/y"] }, afterAttempts: 0, cooldownMs: -5 }, undefined)
  assert.equal(floored?.afterAttempts, 2)
  assert.equal(floored?.cooldownMs, 60_000)
})

test("invalid pattern is ignored without throwing", () => {
  const cfg = compileConfig({ routes: { "a/x": ["b/y"] }, pattern: "(" }, undefined)
  assert.equal(cfg?.pattern, undefined)
  const empty = compileConfig({ routes: { "a/x": ["b/y"] }, pattern: "" }, undefined)
  assert.equal(empty?.pattern, undefined)
})

test("mode and scope only accept their known values", () => {
  const weird = compileConfig({ routes: { "a/x": ["b/y"] }, mode: "yolo", scope: "everything" }, undefined)
  assert.equal(weird?.mode, "resume")
  assert.equal(weird?.scope, "all")
  const inplace = compileConfig({ routes: { "a/x": ["b/y"] }, mode: "inplace", scope: "subagents" }, undefined)
  assert.equal(inplace?.mode, "inplace")
  assert.equal(inplace?.scope, "subagents")
})

test("isRateLimit matches status, then message pattern, then rejects", () => {
  const cfg = compileConfig({ routes: { "a/x": ["b/y"] } }, undefined)!
  assert.equal(isRateLimit({ status: 429, message: "slow down" }, cfg), true)
  assert.equal(isRateLimit({ status: 500, message: "You hit your rate limit" }, cfg), true)
  assert.equal(isRateLimit({ status: 500, message: "quota exceeded for model" }, cfg), true)
  assert.equal(isRateLimit({ status: 500, message: "connection reset" }, cfg), false)
  assert.equal(isRateLimit(undefined, cfg), false)
  assert.equal(isRateLimit({ status: 429 }, cfg), true)
})

test("isRateLimit matches plan/usage limit wording without an HTTP status", () => {
  const cfg = compileConfig({ routes: { "a/x": ["b/y"] } }, undefined)!
  // Observed in the wild (PAF-14 kickoff, 2026-11-05): claude-agent/sonnet plan limit.
  assert.equal(
    isRateLimit(
      {
        type: "provider.unknown",
        message: "You've hit your session limit · resets 3:40pm (Europe/Madrid) Resets at 2026-11-05T14:40:00.000Z.",
      },
      cfg,
    ),
    true,
  )
  assert.equal(isRateLimit({ type: "provider.unknown", message: "usage limit reached for this model" }, cfg), true)
  assert.equal(isRateLimit({ message: "insufficient_quota: check your billing details" }, cfg), true)
  assert.equal(isRateLimit({ message: "RESOURCE_EXHAUSTED" }, cfg), true)
  assert.equal(isRateLimit({ message: "you have hit your limit for today" }, cfg), true)
  assert.equal(isRateLimit({ message: "context length exceeded" }, cfg), false)
  assert.equal(isRateLimit({ message: "invalid api key" }, cfg), false)
  assert.equal(isRateLimit({ message: "connection reset by peer" }, cfg), false)
})

test("resetHintMs parses absolute reset timestamps", () => {
  const now = Date.parse("2026-11-05T11:43:00.000Z")
  const hint = resetHintMs(
    "You've hit your session limit · resets 3:40pm (Europe/Madrid) Resets at 2026-11-05T14:40:00.000Z.",
    now,
  )
  assert.equal(hint, Date.parse("2026-11-05T14:40:00.000Z") - now) // 2h57m
  // A reset time that has already passed is a "healthy now" hint.
  assert.equal(resetHintMs("Resets at 2026-11-04T00:00:00.000Z", now), 0)
})

test("resetHintMs parses relative delays or returns undefined", () => {
  const now = Date.now()
  assert.equal(resetHintMs("Please retry in 30 seconds", now), 30_000)
  assert.equal(resetHintMs("try again in 23 minutes", now), 23 * 60_000)
  assert.equal(resetHintMs("resets in 2 hours", now), 2 * 3_600_000)
  assert.equal(resetHintMs("resets after 1 day", now), 86_400_000)
  assert.equal(resetHintMs("connection reset by peer", now), undefined)
  assert.equal(resetHintMs(undefined, now), undefined)
})

test("modelKey and parseModelKey round trip", () => {
  assert.equal(modelKey({ providerID: "openai", id: "gpt-6-luna" }), "openai/gpt-6-luna")
  assert.deepEqual(parseModelKey("openai/gpt-6-luna"), { providerID: "openai", id: "gpt-6-luna" })
  // Slashes beyond the first belong to the model id.
  assert.deepEqual(parseModelKey("prov/mo/del"), { providerID: "prov", id: "mo/del" })
})
