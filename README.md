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

The plugin reads a JSON config file, re-read with mtime caching on every
failure — **edits apply without restarting OpenCode**. Lookup order:

1. `RATE_LIMIT_FAILOVER_CONFIG` environment variable (absolute path)
2. `config.json` in the plugin directory (repo root)
3. `~/.config/opencode/rate-limit-failover.json`

Plugin `options` (object form in `plugins`) override the file per key.

```jsonc
{
  // Directed routes: failing model → fallback candidates, tried in order.
  "routes": {
    "openai/gpt-6-luna": ["anthropic/claude-opus-4-6"],
    "anthropic/claude-opus-4-6": ["openai/gpt-6-luna"]
  },

  // Bidirectional shorthand — equivalent to the two routes above:
  // "pairs": [["openai/gpt-6-luna", "anthropic/claude-opus-4-6"]]

  // HTTP statuses treated as rate limits.
  "statuses": [429],

  // Error-message fallback matcher for providers that signal rate limits
  // with other statuses.
  "pattern": "rate.?limit|too many requests|quota exceeded|overloaded",

  // Built-in OpenCode retries to allow on the failing model before failing over.
  "afterAttempts": 2,

  // How long (ms) a model is considered unhealthy for a session after it
  // rate-limits (also honors the provider's retry-after hint). This is the
  // ping-pong guard for X↔Y pairs.
  "cooldownMs": 60000,

  // Prompt sent to the session after switching models.
  "continueText": "Continue where you left off.",

  // "resume" (default): veto retries → execution fails → switch model → continue.
  // "inplace" (experimental): switch model and retry immediately inside the
  //   execution; if the runner ignores the new model, the next retry hook
  //   firing detects it and self-corrects to resume mode.
  "mode": "resume",

  // "all" (default) or "subagents" (only sessions with a parentID).
  "scope": "all",

  // When true, add a synthetic note message to the session documenting the switch.
  "annotate": false
}
```

```jsonc title="options form"
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-rate-limit-failover",
      "options": { "afterAttempts": 1, "scope": "subagents" }
    }
  ]
}
```

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
