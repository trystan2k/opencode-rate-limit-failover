/**
 * Pure configuration logic for the rate-limit-failover plugin.
 *
 * No OpenCode imports here — everything in this module is unit-testable with
 * plain `node:test`.
 */

export type ModelKey = string // "providerID/modelID"

import { existsSync, readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"

export interface FailoverConfig {
  /** Directed failover routes: failing model → fallback candidates, tried in order. */
  routes: Record<ModelKey, ModelKey[]>
  /** HTTP statuses treated as rate limits. */
  statuses: number[]
  /** Error-message fallback matcher for providers that signal limits differently. */
  pattern: RegExp | undefined
  /** Built-in OpenCode retries to allow on the failing model before failing over. */
  afterAttempts: number
  /** How long (ms) a model is considered unhealthy as a target after a rate limit. */
  cooldownMs: number
  /** Prompt sent to the session after switching models. */
  continueText: string
  /** "resume": veto retries, switch after the execution fails. "inplace": switch and retry immediately. */
  mode: "resume" | "inplace"
  /** "all" sessions or only subagent sessions (parentID set). */
  scope: "all" | "subagents"
  /** Add a synthetic note message to the session documenting the switch. */
  annotate: boolean
  /** When a child session is failed over, notify its parent session (default: on). */
  notifyParent: boolean
}

export type RawOptions = Record<string, unknown> | undefined

export const DEFAULT_PATTERN =
  "rate.?limit|too many requests|quota (?:exceeded|exhausted)|insufficient[ _]quota|" +
  "(?:session|usage|daily|weekly|monthly|request|message|token|credit|plan|spending)s? +limit|" +
  "hit (?:your|the|a) +limit|limit +(?:has +been +)?(?:reached|exceeded)|overloaded|resource[ _-]?exhaust"
export const DEFAULT_CONTINUE_TEXT = "Continue where you left off."
export const CONFIG_ENV = "RATE_LIMIT_FAILOVER_CONFIG"

// ─── Model refs ──────────────────────────────────────────────────────────────

export function modelKey(model: { providerID: string; id: string }): ModelKey {
  return `${model.providerID}/${model.id}`
}

export function parseModelKey(key: ModelKey): { providerID: string; id: string } {
  const i = key.indexOf("/")
  return i < 0 ? { providerID: key, id: "" } : { providerID: key.slice(0, i), id: key.slice(i + 1) }
}

export function isModelRef(value: unknown): value is string {
  if (typeof value !== "string") return false
  const i = value.indexOf("/")
  return i > 0 && i < value.length - 1
}

// ─── Compilation ─────────────────────────────────────────────────────────────

function toInt(value: unknown, fallback: number, min: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback
}

function collectPairs(routes: Record<ModelKey, ModelKey[]>, pairs: unknown): void {
  if (!Array.isArray(pairs)) return
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    addRoute(routes, pair[0], pair[1])
    addRoute(routes, pair[1], pair[0])
  }
}

function collectRoutes(routes: Record<ModelKey, ModelKey[]>, source: unknown): void {
  if (!source || typeof source !== "object") return
  for (const [from, targets] of Object.entries(source as Record<string, unknown>)) {
    if (!Array.isArray(targets)) continue
    for (const to of targets) addRoute(routes, from, to)
  }
}

function addRoute(routes: Record<ModelKey, ModelKey[]>, from: unknown, to: unknown): void {
  if (!isModelRef(from) || !isModelRef(to)) return
  const f = from.trim()
  const t = to.trim()
  if (f === t) return
  const list = (routes[f] ??= [])
  if (!list.includes(t)) list.push(t)
}

/**
 * Compile the config file contents plus plugin `options` (options win per key)
 * into a {@link FailoverConfig}. Returns `undefined` when no routes are
 * configured, meaning the plugin should stay idle.
 */
export function compileConfig(raw: unknown, options: RawOptions): FailoverConfig | undefined {
  const routes: Record<ModelKey, ModelKey[]> = {}
  collectRoutes(routes, (raw as { routes?: unknown } | null)?.routes)
  collectPairs(routes, (raw as { pairs?: unknown } | null)?.pairs)
  collectRoutes(routes, options?.routes)
  collectPairs(routes, options?.pairs)
  if (Object.keys(routes).length === 0) return undefined

  const statusesRaw = options?.statuses ?? (raw as { statuses?: unknown } | null)?.statuses
  const statuses = (Array.isArray(statusesRaw) ? statusesRaw : [])
    .map((s) => toInt(s, 0, 1))
    .filter((s) => s >= 100 && s <= 599)
  if (statuses.length === 0) statuses.push(429)

  const patternSource = options?.pattern ?? (raw as { pattern?: unknown } | null)?.pattern ?? DEFAULT_PATTERN
  let pattern: RegExp | undefined
  if (typeof patternSource === "string" && patternSource.length > 0) {
    try {
      pattern = new RegExp(patternSource, "i")
    } catch {
      pattern = undefined
    }
  }

  const continueRaw = options?.continueText ?? (raw as { continueText?: unknown } | null)?.continueText
  const mode = options?.mode === "inplace" || (raw as { mode?: unknown } | null)?.mode === "inplace" ? "inplace" : "resume"
  const scope =
    options?.scope === "subagents" || (raw as { scope?: unknown } | null)?.scope === "subagents" ? "subagents" : "all"
  const annotate = options?.annotate === true || (raw as { annotate?: unknown } | null)?.annotate === true
  const notifyParentRaw = options?.notifyParent ?? (raw as { notifyParent?: unknown } | null)?.notifyParent
  const notifyParent = notifyParentRaw === undefined ? true : notifyParentRaw === true

  return {
    routes,
    statuses,
    pattern,
    afterAttempts: toInt(options?.afterAttempts ?? (raw as { afterAttempts?: unknown } | null)?.afterAttempts, 2, 1),
    cooldownMs: toInt(options?.cooldownMs ?? (raw as { cooldownMs?: unknown } | null)?.cooldownMs, 60_000, 0),
    continueText: typeof continueRaw === "string" && continueRaw ? continueRaw : DEFAULT_CONTINUE_TEXT,
    mode,
    scope,
    annotate,
    notifyParent,
  }
}

// ─── Failure classification ──────────────────────────────────────────────────

export function isRateLimit(error: unknown, cfg: FailoverConfig): boolean {
  const e = error as { status?: unknown; message?: unknown } | undefined
  if (typeof e?.status === "number" && cfg.statuses.includes(e.status)) return true
  if (cfg.pattern && typeof e?.message === "string" && cfg.pattern.test(e.message)) return true
  return false
}

// ─── Reset-time hints ────────────────────────────────────────────────────────

/** Absolute reset timestamp, e.g. "Resets at 2026-11-05T14:40:00.000Z". */
const ISO_RESET_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?\b/

/** Relative delay, e.g. "resets in 2 hours", "try again in 23 minutes". */
const RELATIVE_RESET_RE =
  /\b(?:resets? +(?:in|after)|re-?try[^.]{0,20}?in|try +again[^.]{0,20}?in) +(\d+) +(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i

const RESET_UNITS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
}

/**
 * Parse a "when can we retry" hint out of an error message: an absolute reset
 * timestamp ("You've hit your session limit … Resets at 2026-11-05T14:40:00.000Z")
 * or a relative delay ("try again in 23 minutes"). Returns the ms to wait,
 * `0` when a parsed reset time has already passed, or `undefined` when the
 * message carries no usable hint. Providers that don't send `retryAfterMs`
 * still get an accurate cooldown this way.
 */
export function resetHintMs(message: string | undefined, now = Date.now()): number | undefined {
  if (!message) return undefined
  const iso = ISO_RESET_RE.exec(message)
  if (iso) {
    const resetAt = Date.parse(iso[0])
    if (Number.isFinite(resetAt)) return Math.max(resetAt - now, 0)
  }
  const rel = RELATIVE_RESET_RE.exec(message)
  if (rel?.[1] && rel[2]) {
    const amount = Number.parseInt(rel[1], 10)
    const unit = RESET_UNITS[rel[2].toLowerCase()]
    if (Number.isFinite(amount) && unit) return amount * unit
  }
  return undefined
}

// ─── Config file loading ─────────────────────────────────────────────────────

export interface ConfigSource {
  /** Absolute path the configuration was read from, if any. */
  path: string | undefined
  /** Parsed JSON contents, or `{}` when absent/unparseable. */
  raw: unknown
  /** Parse error from the latest read, if any. */
  error: unknown
}

export interface ConfigLoader {
  /** Candidate paths in priority order (highest first). */
  candidates(): string[]
  /** Locate and parse the config file, re-reading when its mtime changes. */
  read(): ConfigSource
}

export function configCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = env[CONFIG_ENV]
  const besideEntry = fileURLToPathSafe(new URL("./config.json", import.meta.url))
  const repoRoot = fileURLToPathSafe(new URL("../config.json", import.meta.url))
  const userDir = `${env.HOME ?? ""}/.config/opencode/rate-limit-failover.json`
  return [fromEnv, besideEntry, repoRoot, userDir].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  )
}

function fileURLToPathSafe(url: URL): string {
  try {
    return fileURLToPath(url)
  } catch {
    return ""
  }
}

/**
 * Mtime-cached config file loader. `read()` stats the first existing candidate
 * and only re-parses when the file changed, so the plugin can call it on every
 * failure without cost, and config edits apply without reloading OpenCode.
 */
export function createConfigLoader(env: NodeJS.ProcessEnv = process.env): ConfigLoader {
  const candidates = configCandidates(env)
  let mtimeMs = -1
  let source: ConfigSource = { path: undefined, raw: {}, error: undefined }

  return {
    candidates: () => candidates,
    read(): ConfigSource {
      const path = candidates.find((p) => existsSyncSafe(p))
      if (!path) {
        if (source.path !== undefined || mtimeMs !== -2) {
          mtimeMs = -2
          source = { path: undefined, raw: {}, error: undefined }
        }
        return source
      }
      const mtime = statSyncSafe(path)
      if (mtime === mtimeMs) return source
      mtimeMs = mtime
      try {
        source = { path, raw: JSON.parse(readSync(path)), error: undefined }
      } catch (cause) {
        source = { path, raw: {}, error: cause }
      }
      return source
    },
  }
}

function existsSyncSafe(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function statSyncSafe(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

function readSync(path: string): string {
  return readFileSync(path, "utf8")
}
