# omp-shunt

An [OMP](https://omp.sh) extension that keeps I/O-heavy work out of the main agent's context. It is a port of Spotify's [`shunt`](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt) Claude Code plugin (Apache-2.0). This version drops the Portal CLI / AiKA dependency and delegates to any model OMP is already logged in to.

## How it works

1. **Gate (`tool_call` hook).** It blocks full-file `read`s and `cat`/`head`/`tail`/`less`/`more` dumps of local text files over `SHUNT_MIN_LINES`. The block reason points the agent at `bulk_read`, or at a ranged read when it needs exact text to edit.
2. **Delegation tools.** `bulk_read` and `code_write` send files to a cheaper worker model in a single stateless completion. Only the answer comes back. With `code_write --target`, only a line count comes back. The tool descriptions carry the guidance on when to delegate and when not to (upstream kept this in skills).

The savings come from the corpus never entering the main context. If it did, the main model would pay for it again on every later turn. On top of that, the worker is cheaper per token.

### Gate rules

| Call | Allowed | Blocked |
|---|---|---|
| `read` | line ranges (`f:1-200`, `f:-60`, `f:5-16,40-80`, `f:raw:1-50`), `:img`, `:conflicts`, URLs, internal URLs, directories, binary/missing files, files ≤ threshold | bare path or bare `:raw` on a text file > threshold |
| `bash` | anything piped or redirected, non-read commands, `head`/`tail` printing ≤ threshold lines, `-c`/`-f` | `cat`/`less`/`more` totalling > threshold lines; `head`/`tail -n N` with N > threshold; `tail -n +K` leaving > threshold lines |

The gate only runs when `bulk_read` is active in the session. Restricted subagents that lack the tool are not blocked.

### Not delegated

These stay with the main agent: debugging, editing (use ranged reads), small files, and architectural decisions.

## Install

```bash
omp plugin link /path/to/shunt      # or: omp install /path/to/shunt
# one-off: omp -e /path/to/shunt
```

Then point the worker at a cheap model. `@smol` falls back to your default model when it is unset. In that case shunt shows a warning at session start: you still get the context savings, but not the per-token savings.

```yaml
# ~/.omp/agent/config.yml
modelRoles:
  smol: anthropic/claude-haiku-4-5
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SHUNT_MIN_LINES` | `350` | Line count above which the gate blocks |
| `SHUNT_MODEL` | `@smol` | Worker model selector or role alias (overridden per mode) |
| `SHUNT_TIMEOUT_SECONDS` | `180` | Timeout for one worker call |

## Modes

A mode is a named worker system prompt, with an optional model and temperature. There are two built-ins, `bulk-reader` and `code-writer`, and both use the upstream AiKA instructions. To add or override a mode, create a markdown file. Project modes shadow user modes, and user modes shadow built-ins.

```
<project>/.omp/shunt/modes/<name>.md
~/.omp/agent/shunt/modes/<name>.md
```

```markdown
---
model: anthropic/claude-haiku-4-5   # optional; else SHUNT_MODEL / @smol
temperature: 0.1                    # optional
---
You triage application logs. Answer with timestamps and error codes only…
```

Both tools take `mode` (for example `bulk_read` with `mode: "log-triage"`). An unknown name fails and lists the available modes.

## Differences from upstream

- The transport is OMP's in-process model client (`completeSimple`) instead of `portal-cli actions aika:invoke-chat`. There is no `jq`, no `ARG_MAX` payload cap, and no mode-id pinning.
- Skills plus bash scripts become typed tools, so arguments are schema-validated and there is no shell quoting.
- `code_write` takes `references: string[]`, so the source under test can travel alongside the pattern file. It unwraps only an outer fence instead of deleting every ```` ``` ```` line, and it refuses to write truncated output.
- The bash gate checks each `&&`/`;` segment and the real `head`/`tail` line counts. Upstream blocked `head big.txt`, which prints 10 lines.
- Prompt caching is off for worker calls. The question follows the files, so a follow-up would never hit the cache and would pay the cache-write premium every time.

## Limitations

- Only `read` and `bash` are gated. The `eval` tool's `read()` helper and `grep` with huge context are not.
- A ranged read of any size passes, the same as upstream's offset/limit bypass.
- The worker's context window bounds one call. Split large batches.
