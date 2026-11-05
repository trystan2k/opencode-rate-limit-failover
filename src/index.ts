/**
 * rate-limit-failover — OpenCode server plugin
 *
 * When a session's model hits a rate limit, this plugin transparently switches
 * the session to a fallback model and resumes it, so neither the user nor an
 * orchestrator agent has to react to the failure.
 *
 * Flow:
 *   model X 429 → OpenCode classifies failure → `retry` hook fires
 *     → mapped model? record failure; after `afterAttempts` built-in retries,
 *       veto further retries on X and remember a {X → Y} handoff
 *   → execution fails → `session.execution.failed` event
 *     → switchModel(Y) → prompt("Continue where you left off.")
 *   → session continues on Y with its full history intact
 *
 * Ping-pong guard: failures are remembered per session with a cooldown, so an
 * X↔Y pair where both models are rate-limited degrades to OpenCode's normal
 * retry/backoff + error surfacing instead of looping forever.
 *
 * Plan/usage limits that arrive without an HTTP status ("You've hit your
 * session limit · resets 3:40pm") are caught by the message pattern, and a
 * reset time found in the message is parsed into the cooldown hint. When a
 * routed model fails with an error that matches neither, a one-line diagnostic
 * names the gap so a new provider wording is easy to spot and add.
 *
 * Config: see `configCandidates()` in ./config.ts and the README. The file is
 * re-read with mtime caching, so edits apply on the next failure without
 * reloading OpenCode. Plugin `options` (opencode.json) override the file per
 * key.
 */

import { Plugin } from "@opencode/plugin"
import { createConfigLoader, compileConfig, isRateLimit, modelKey, parseModelKey, resetHintMs, type ModelKey } from "./config.ts"
import { CooldownTracker } from "./cooldown.ts"

const LOG = "[rate-limit-failover]"

const EVENT_RETRY_MIN_MS = 50
const EVENT_RETRY_MAX_MS = 5000

/** Shape of the `retry` hook event (see docs/build/plugins/server#retry-policy). */
interface RetryEvent {
  sessionID: string
  agent: string
  model: { providerID: string; id: string; variant?: string }
  error: { type: string; message: string; status?: number; retryAfterMs?: number }
  attempt: number
  decision: { retry: false } | { retry: true; delay: number }
}

interface Handoff {
  from: ModelKey
  to: ModelKey
}

/** Minimal structural view of the plugin context (runtime provides the rest). */
interface PluginContext {
  options?: Record<string, unknown>
  session: {
    get(input: { sessionID: string }): Promise<any>
    hook(
      name: "retry",
      callback: (event: RetryEvent) => Promise<void> | void,
    ): Promise<{ dispose(): Promise<void> }>
    switchModel(input: { sessionID: string; model: { providerID: string; id: string } }): Promise<void>
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
    synthetic(input: { sessionID: string; text: string }): Promise<unknown>
  }
  event: {
    subscribe(options?: { types?: string[]; signal?: AbortSignal }): AsyncIterable<any>
  }
}

function delayUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

async function setupPlugin(ctx: PluginContext): Promise<() => Promise<void>> {
  const options = (ctx as any).options
  const loader = createConfigLoader()

  let idleLogged = false

  /** Re-read the config file (mtime-cached) and compile it. `undefined` = idle. */
  const currentConfig = (): ReturnType<typeof compileConfig> => {
    const source = loader.read()
    if (source.error) {
      console.error(`${LOG} could not parse ${source.path}:`, source.error)
    }
    const cfg = compileConfig(source.raw, options)
    if (!cfg) {
      if (!idleLogged) {
        idleLogged = true
        log(
          source.path
            ? `no routes configured in ${source.path} (set "routes" or "pairs"); plugin is idle`
            : `no config file found (looked at ${loader.candidates().join(", ")}); plugin is idle`,
        )
      }
      return undefined
    }
    idleLogged = false
    return cfg
  }

  const cooldown = new CooldownTracker()
  /** resume mode: vetoes waiting for the execution to fail */
  const pending = new Map<string, Handoff>()
  /** in-place mode: switches awaiting proof they took effect */
  const inplaceArmed = new Map<string, Handoff>()
  /** sessions already told about an unclassified failure on a routed model */
  const unmatchedLogged = new Set<string>()

  async function scopeOk(sessionID: string, cfg: NonNullable<ReturnType<typeof compileConfig>>): Promise<boolean> {
    if (cfg.scope === "all") return true
    try {
      const info = await ctx.session.get({ sessionID })
      return !!info?.parentID
    } catch {
      return false
    }
  }

  const registrations: Array<{ dispose(): Promise<void> }> = []
  const abort = new AbortController()

  const cleanup = async () => {
    abort.abort()
    await Promise.all(registrations.map((r) => r.dispose().catch(() => {})))
    await listening
  }

  let listening: Promise<void> = Promise.resolve()

  try {
    // ── Retry hook: classify mapped-model failures and decide failover ──
    registrations.push(
      await ctx.session.hook("retry", async (event) => {
        try {
          const cfg = currentConfig()
          if (!cfg) return

          const fromKey = modelKey(event.model)
          const targets = cfg.routes[fromKey]
          if (!targets?.length) return
          if (!isRateLimit(event.error, cfg)) return
          if (!(await scopeOk(event.sessionID, cfg))) return

          const hint = event.error?.retryAfterMs ?? resetHintMs(event.error?.message)
          cooldown.mark(event.sessionID, fromKey, hint, cfg.cooldownMs)

          // In-place mode: the next attempt still ran on the old model, so the
          // switch did not apply. Veto retries and hand off to the resume path.
          const armed = inplaceArmed.get(event.sessionID)
          if (armed) {
            inplaceArmed.delete(event.sessionID)
            if (armed.from === fromKey) {
              event.decision = { retry: false }
              pending.set(event.sessionID, armed)
              log(
                `${event.sessionID}: in-place switch to ${armed.to} did not apply; ` +
                  `failing over via resume when execution fails`,
              )
              return
            }
          }

          // Let OpenCode's own retry/backoff work before taking over.
          if (event.attempt < cfg.afterAttempts) return

          const target = cooldown.pickHealthy(event.sessionID, targets)
          if (!target) {
            log(
              `${event.sessionID}: rate limit on ${fromKey} but every target is within cooldown; ` +
                `leaving retry/backoff to OpenCode`,
            )
            return
          }

          if (cfg.mode === "inplace") {
            try {
              await ctx.session.switchModel({ sessionID: event.sessionID, model: parseModelKey(target) })
              inplaceArmed.set(event.sessionID, { from: fromKey, to: target })
              event.decision = { retry: true, delay: 0 }
              log(
                `${event.sessionID}: rate limit on ${fromKey} (attempt ${event.attempt}); ` +
                  `switched session model to ${target} in-place`,
              )
              return
            } catch (cause) {
              console.error(`${LOG} ${event.sessionID}: in-place switch to ${target} failed; using resume mode`, cause)
            }
          }

          event.decision = { retry: false }
          pending.set(event.sessionID, { from: fromKey, to: target })
          log(
            `${event.sessionID}: rate limit on ${fromKey} after ${event.attempt} attempt(s); ` +
              `will resume on ${target} once this execution fails`,
          )
        } catch (cause) {
          console.error(`${LOG} retry hook error`, cause)
        }
      }),
    )

    // ── Event listener: perform the failover once an execution settles ──
    listening = (async () => {
      let retryMs = EVENT_RETRY_MIN_MS
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({
            types: [
              "session.execution.failed",
              "session.execution.succeeded",
              "session.execution.interrupted",
              "session.deleted",
            ],
            signal: abort.signal,
          })) {
            if (abort.signal.aborted) break
            retryMs = EVENT_RETRY_MIN_MS
            await handleEvent(event).catch((cause) => console.error(`${LOG} event handler error`, cause))
          }
        } catch {
          // Stream dropped (e.g. server restart); reconnect with backoff below.
        }
        if (abort.signal.aborted) break
        await delayUnlessAborted(retryMs, abort.signal)
        retryMs = Math.min(retryMs * 2, EVENT_RETRY_MAX_MS)
      }
    })()
  } catch (cause) {
    await cleanup()
    throw cause
  }

  async function handleEvent(event: any): Promise<void> {
    const sessionID: string | undefined = event?.data?.sessionID
    if (!sessionID) return

    if (event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted") {
      // Drop in-flight handoff/armed state; cooldowns are kept on purpose.
      pending.delete(sessionID)
      inplaceArmed.delete(sessionID)
      unmatchedLogged.delete(sessionID)
      return
    }
    if (event.type === "session.deleted") {
      cooldown.clear(sessionID)
      pending.delete(sessionID)
      inplaceArmed.delete(sessionID)
      unmatchedLogged.delete(sessionID)
      return
    }

    // session.execution.failed
    const cfg = currentConfig()
    inplaceArmed.delete(sessionID)
    let handoff = pending.get(sessionID)
    pending.delete(sessionID)
    if (!cfg) return

    const error = event.data?.error
    if (!isRateLimit(error, cfg)) {
      // If the failed model has a route, this is a detection gap worth naming:
      // a limit wording the classifier missed silently skips the failover.
      await warnUnmatched(sessionID, error, cfg)
      return
    }

    if (!handoff) {
      // Built-in retries were exhausted (or the failure bypassed our veto).
      // Derive a target from the session's current model so mapped models
      // always fail over, even without a handoff.
      if (!(await scopeOk(sessionID, cfg))) return
      let info: any
      try {
        info = await ctx.session.get({ sessionID })
      } catch {
        return
      }
      const current = info?.model ? modelKey(info.model) : undefined
      const targets = current ? cfg.routes[current] : undefined
      if (!current || !targets?.length) return
      cooldown.mark(sessionID, current, error?.retryAfterMs ?? resetHintMs(error?.message), cfg.cooldownMs)
      const target = cooldown.pickHealthy(sessionID, targets)
      if (!target) {
        log(`${sessionID}: rate limit on ${current} but every target is within cooldown; surfacing the error`)
        return
      }
      handoff = { from: current, to: target }
    }

    try {
      await ctx.session.switchModel({ sessionID, model: parseModelKey(handoff.to) })
    } catch (cause) {
      console.error(`${LOG} ${sessionID}: could not switch model to ${handoff.to}`, cause)
      return
    }
    if (cfg.annotate) {
      await ctx.session
        .synthetic({
          sessionID,
          text: `${LOG}: ${handoff.from} hit a rate limit; this session switched to ${handoff.to}.`,
        })
        .catch(() => {})
    }
    try {
      await ctx.session.prompt({ sessionID, text: cfg.continueText })
      log(`${sessionID}: switched ${handoff.from} → ${handoff.to} and resumed with a continue prompt`)
    } catch (cause) {
      console.error(`${LOG} ${sessionID}: failed to send the continue prompt`, cause)
    }
  }

  /**
   * One-line diagnostic when a model that has a configured route fails with an
   * error that the classifier did not recognize as a rate limit. Logged at
   * most once per session (reset on success/deletion) so noisy non-limit
   * failures don't spam the log.
   */
  async function warnUnmatched(
    sessionID: string,
    error: unknown,
    cfg: NonNullable<ReturnType<typeof compileConfig>>,
  ): Promise<void> {
    if (unmatchedLogged.has(sessionID)) return
    unmatchedLogged.add(sessionID)
    let current: ModelKey | undefined
    try {
      const info = await ctx.session.get({ sessionID })
      current = info?.model ? modelKey(info.model) : undefined
    } catch {
      unmatchedLogged.delete(sessionID)
      return
    }
    const targets = current ? cfg.routes[current] : undefined
    if (!current || !targets?.length) {
      unmatchedLogged.delete(sessionID) // not routed; nothing to report
      return
    }
    const e = (error ?? {}) as { type?: unknown; status?: unknown; message?: unknown }
    const message = typeof e.message === "string" ? e.message.slice(0, 200) : String(e.message)
    log(
      `${sessionID}: ${current} failed but the error was not classified as a rate limit, so the ` +
        `route to ${targets.join(", ")} was not used — consider extending "pattern" ` +
        `(type=${JSON.stringify(e.type ?? null)}, status=${JSON.stringify(e.status ?? null)}, message=${JSON.stringify(message)})`,
    )
  }

  function log(...parts: unknown[]): void {
    console.log(LOG, ...parts)
  }

  return cleanup
}

export default Plugin.define({
  id: "rate-limit-failover",
  setup(ctx) {
    return setupPlugin(ctx as unknown as PluginContext)
  },
})
