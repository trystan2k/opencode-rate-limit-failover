# opencode-rate-limit-failover

OpenCode server plugin that transparently fails a session over to a fallback
model when its current model hits a rate limit, then resumes it — without the
user or an orchestrator agent having to react.

```
model X 429 ──► OpenCode classifies failure ──► retry hook
                  │  mapped? record failure (cooldown)
                  │  attempt < afterAttempts ─► let built-in backoff retry X
                  └  attempt ≥ afterAttempts ─► veto retries, park handoff {X→Y}
execution fails ─► session.execution.failed event
                  │  switchModel(Y)
                  └  prompt("Continue where you left off.")
session continues on Y with its full history ─► if Y also 429s, same flow;
cooldown prevents X↔Y ping-pong (error surfaces when no healthy target)
```

Works for all sessions — primary and subagent children alike. The event
listener reconnects with exponential backoff if the server restarts.

## Install

Load the plugin directory from any `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/opencode-rate-limit-failover"
  ]
}
```

Relative paths resolve from the config file containing the entry. To disable
without uninstalling, prefix the plugin id: `"plugins": ["-rate-limit-failover"]`.

## Configure

Two ways to configure, combinable:

- **Option A — everything in `opencode.json`**, via plugin `options`
- **Option B — a JSON config file** (hot-reloaded on mtime), with `options`
  overriding it per key

### Option A — everything in `opencode.json`

Use the object form in `plugins` with the plugin's local path (or published
npm/Git ref) as `package`. Complete example with every supported option:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      // Local checkout while developing. Once published, use
      // "github:trystan2k/opencode-rate-limit-failover" or the npm name.
      // A bare name that is not published would be fetched from npm instead.
      "package": "/absolute/path/to/opencode-rate-limit-failover",
      "options": {
        // Directed routes: failing model → fallback candidates, tried in order.
        "routes": {
          "openai/gpt-6-luna": ["anthropic/claude-opus-4-6"],
          "anthropic/claude-opus-4-6": ["openai/gpt-6-luna"],
          "openai/gpt-5.1": ["anthropic/claude-opus-4-6", "google/gemini-3-pro"]
        },

        // Bidirectional shorthand — equivalent to writing both directions:
        // "pairs": [["openai/gpt-6-luna", "anthropic/claude-opus-4-6"]],

        // HTTP statuses treated as rate limits. Default: [429].
        "statuses": [429],

        // Error-message fallback matcher for providers that signal rate or
        // plan/usage limits with other statuses or with no status at all.
        "pattern": "rate.?limit|too many requests|quota (?:exceeded|exhausted)|insufficient[ _]quota|(?:session|usage|daily|weekly|monthly|request|message|token|credit|plan|spending)s? +limit|hit (?:your|the|a) +limit|limit +(?:has +been +)?(?:reached|exceeded)|overloaded|resource[ _-]?exhaust",

        // Built-in OpenCode retries to allow on the failing model before
        // failing over. Default: 2.
        "afterAttempts": 2,

        // How long (ms) a model is considered unhealthy for a session after
        // it rate-limits; also honors the provider's retry-after hint, or a
        // reset time / delay parsed from the error message (e.g. "Resets at
        // 2026-11-05T14:40:00.000Z", "try again in 23 minutes").
        // This is the ping-pong guard for X↔Y pairs. Default: 60000.
        "cooldownMs": 60000,

        // Prompt sent to the session after switching models.
        "continueText": "Continue where you left off.",

        // "resume" (default): veto retries → execution fails → switch model → continue.
        // "inplace" (experimental): switch model and retry immediately inside
        //   the execution; if the runner ignores the new model, the next
        //   retry hook firing detects it and self-corrects to resume mode.
        "mode": "resume",

        // "all" (default) or "subagents" (only sessions with a parentID).
        "scope": "all",

        // When true, add a synthetic note message to the session
        // documenting the switch.
        "annotate": false
      }
    }
  ]
}
```

Minimal version — routes/pairs are the only required key, everything else
falls back to the defaults shown above:

```jsonc title="opencode.jsonc"
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-rate-limit-failover",
      "options": {
        "pairs": [["openai/gpt-6-luna", "anthropic/claude-opus-4-6"]]
      }
    }
  ]
}
```

Notes:

- Saving `opencode.json(c)` reloads the plugin, so option edits apply without
  restarting OpenCode.
- `routes`/`pairs` from options are **additive** with the config file's routes
  (union, deduped); every other option **replaces** the file's value for that
  key.
- With this form you can leave the repo's `config.json` untouched
  (`routes: {}`) and keep your personal mapping out of the repo.

### Option B — config file

The plugin reads a JSON config file, re-read with mtime caching on every
failure — **edits apply without restarting OpenCode**. Lookup order:

1. `RATE_LIMIT_FAILOVER_CONFIG` environment variable (absolute path)
2. `config.json` in the plugin directory (repo root)
3. `~/.config/opencode/rate-limit-failover.json`

Same schema as the `options` object above:

```jsonc title="config.json"
{
  "routes": {
    "openai/gpt-6-luna": ["anthropic/claude-opus-4-6"]
  },
  "statuses": [429],
  "pattern": "rate.?limit|too many requests|quota (?:exceeded|exhausted)|insufficient[ _]quota|(?:session|usage|daily|weekly|monthly|request|message|token|credit|plan|spending)s? +limit|hit (?:your|the|a) +limit|limit +(?:has +been +)?(?:reached|exceeded)|overloaded|resource[ _-]?exhaust",
  "afterAttempts": 2,
  "cooldownMs": 60000,
  "continueText": "Continue where you left off.",
  "mode": "resume",
  "scope": "all",
  "annotate": false
}
```

Options from `opencode.json` still override this file per key when both are
used.

## Caveats

- **Foreground subagents**: in `resume` mode the child execution fails for a
  moment before the plugin resumes it, so a foreground `subagent` tool call may
  return an error to the parent while the child continues on the fallback
  model. Run subagents in `background` mode, or try `"mode": "inplace"`, if
  this matters for your orchestrator.
- **Partial responses**: everything *completed* before the rate limit persists
  (messages, tool results, file edits). A response that was streaming when the
  failure hit is retried as a fresh step from the last complete state.
- **Context window**: pick fallbacks with comparable context, or expect
  compaction when a long session moves to a smaller model.
- **Health note**: a model in cooldown is skipped only as a *target*; OpenCode's
  own retries still run on the failing model for the first `afterAttempts` attempts.
- **Limit wording**: plan/usage limits often arrive without an HTTP status and
  are detected by the `pattern` regex instead (defaults cover "You've hit your
  session limit", "usage limit reached", "quota exhausted", …). A provider with
  a wording the pattern misses is logged with a one-line diagnostic — the
  session's route is named along with the unmatched error — so the gap is easy
  to spot and extend. When the message carries a reset time or delay
  ("Resets at …", "try again in 23 minutes"), it is parsed into the cooldown
  so the failing model isn't retried as a target before the window ends.

## Development

```sh
npm install
npm run check   # tsc --noEmit
npm test        # node --test
```

Logs use the `[rate-limit-failover]` prefix in the server log:

```sh
tail -f ~/.local/share/opencode/log/opencode.log | grep rate-limit-failover
```
