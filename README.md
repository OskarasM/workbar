# workbar

A Claude Code mod that shows what a session is doing and what it needs from you, without spending your tokens on it.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ █████████████████░░░░░░░░░░░░░░░░░░░░░░░  43%  ~4m left · ≈15:32             │
│ ✓ Read code   ✓ Find cause   ▶ Fix the band   ○ Tests   ○ Publish            │
│ ● Explore the API (Explore) · 12 tools · 1m 40s · Read claude-code.d.ts      │
│ ▸ 4 files  3 changed · 1 added                                               │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Between tasks the same band turns into a short health check, and offers an action when one is worth taking:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│  ACTION  chat 312k ━━━━━━━━━━  cache ✓ 41m  5h 72% full ≈16:10               │
│ ▲ Long chat: every message re-reads all 312k, and focus drops.               │
│ [ ★ Hand off ] new task   [ Compact ] same task                              │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## What it does

| Feature | What you get |
|---|---|
| Progress bar | Steps, % done, time left and a finish time, for any task of more than a few steps. |
| Honest estimates | Models estimate how long a *person* would take. workbar learns from your finished tasks how long Claude really takes (median of the last 20), leaves out time spent waiting on your answers, and switches to the real pace once steps finish. |
| Subagents | One row per agent: its task, tools used, time, current action and its own step count. Lots of agents collapse into a summary row. |
| Files changed | Files Claude wrote, edited or deleted since your last message, folded into one line until you open it. |
| Chat health | Chat size gauge, prompt-cache countdown, usage windows past 50% with a "full at this pace" time. |
| Compact or Hand off | When the chat is big or the cache has gone cold: one press compacts in place (same task) or writes a handoff, clears, and puts it in the prompt box (new task). ★ marks the one that fits. |
| Message hold | A message into a huge or cold chat is held once with those two options; Enter again sends it anyway. |
| Loop warning | Three failed tool calls in a row: a warning that Claude may be going in circles. |
| Alerts | A desktop pop-up when Claude needs approval, has waited 15 s on a question, or finishes a long run. Optional phone alerts through [ntfy](https://ntfy.sh). |
| Chrome reconnect | When the Claude in Chrome extension drops, it shows how to reconnect and tells Claude to wait rather than give up on the browser step. |
| Status line | The one thing that matters right now, mirrored into Claude Code's status line, so it shows even with the band folded. |

`/tasks` opens a pane with everything in full: every step with its time, every agent, every file, the session's cost and limits, and how estimates are being scaled. `/handoff` writes a handoff and starts a fresh chat with it.

## Token cost

workbar is built to cost close to nothing.

| Part | Cost |
|---|---|
| The `progress` tool | Its description and schema are about 150 tokens, part of the cached tool list (read at a tenth of the price after the first request). |
| Progress reports | A few dozen output tokens per report, sent alongside a tool call Claude was making anyway, so no extra round trips. Roughly 200 tokens for a typical task. |
| A message typed mid-task | About 30 tokens of context asking Claude to update the plan. |
| Everything else | Drawn locally from what Claude Code already reports. No model calls. |
| New-task check (off by default) | One small Haiku call per message in chats over 60k tokens. |
| Hand off (only when you press it) | One question over the cached transcript. |

Want zero? Turn off **Ask Claude for a progress plan**: the bar then follows Claude's own todo list when it keeps one, and nothing at all is added to your requests.

## Install

Needs a Claude Code version with mods (2.1.287 or newer). Tested on 2.1.301, Windows 11.

In a Claude Code session:

```
/plugin install workbar --marketplace OskarasM/workbar
```

From a shell:

```
claude plugin install workbar --marketplace OskarasM/workbar
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `OskarasM/workbar`, then **Add plugin**.

Update with `claude plugin marketplace update workbar` then `claude plugin update workbar`, or remove with `claude plugin uninstall workbar`.

## Settings

All in `/config` under **workbar**.

| Setting | Default | |
|---|---|---|
| Band above the prompt | `auto` | `auto` shows the band when there is something to see or do and keeps the chat size in the status line otherwise; `always` keeps the chat gauge up between tasks too; `off` uses the status line only. |
| Ask Claude for a progress plan | on | Off: zero tokens, the bar follows Claude's todo list. |
| Hold a message into an oversized or cold chat | on | |
| Spot a new task in a long chat | off | Costs a small Haiku call per message in big chats. |
| Chat size: amber at / red at | 150k / 300k | |
| Prompt cache lifetime | `auto` | 1 hour on a Claude subscription, 5 minutes on an API key, or your `promptCacheTtl` setting. |
| Desktop alerts | on | Windows uses a native toast (Windows Terminal has no notification channel Claude Code can use); macOS and Linux use your terminal's. |
| Alert when a run takes longer than | 120 s | |
| Phone alerts (ntfy URL) | empty | e.g. `https://ntfy.sh/a-long-random-topic`. Only the alert text is sent. Treat the topic like a password. |
| Activity marker folder | empty | Each session writes `busy <ms>` / `idle <ms>` to `<folder>/<session>.txt`, for your own scripts (sleep the machine when Claude is done, light a lamp...). |

## How the band stays on screen

The band shares the bottom of the terminal with the prompt and Claude Code's own dialogs. Anything taller than its room scrolls in a small window, and on the main (non-fullscreen) screen a tall bottom area breaks the redraw. So workbar fits a fixed budget: at most a third of the terminal's height and never more than 12 rows, borders included. Every line truncates rather than wraps. When the room runs short, the actions stay and the details give way: done agents first, then the open file list, then the full step list (it folds into one line naming the current step). While Claude shows a question or a plan for approval, the band steps aside completely and the status line says what is waiting.

## Known limitations

- The band is shared: only one mod draws above the prompt at a time. In `auto` mode workbar steps aside when there is nothing to show, so other mods' bands get their turn.
- Files changed by scripts (`python`, `sed -i`, build tools) are not listed; only Claude's own Write/Edit tools and plain `rm`/`del` commands are.
- Time spent on a permission prompt still counts as working time; time on questions and plan approval does not.
- The progress bar needs Claude to report a plan (or keep a todo list). Quick answers get none, on purpose.
- In organizations that manage Claude Code, a user-installed mod's `Notification` hook does not run, so approval alerts are skipped there.
- Tested on Windows 11 with Windows Terminal. macOS and Linux paths are written to work, but less tried.

## Compared with

| | workbar | [claude-hud](https://github.com/jarrodwatts/claude-hud) | [cache-tax](https://github.com/karanb192/cache-tax) |
|---|---|---|---|
| Plan progress and time left | yes | todos only | no |
| Subagent rows | yes | yes | no |
| Context and usage limits | yes, with pace | yes, very configurable | cache only |
| Acts for you (compact, hand off, hold) | yes | no | holds a cold send, keeps the cache warm |
| Alerts | desktop and phone | no | no |

They overlap. If you already use claude-hud's status line, set workbar's band to `auto` and they sit fine together. If you use cache-tax, turn off workbar's message hold so a cold send is not held twice.

## Privacy

No network calls, except the ntfy URL if you set one. No telemetry. The Haiku check runs only if you turn it on, on your own account.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

The hooks module is `hooks/register.tsx`; pure helpers (estimates, layout budget, paths) are in `hooks/lib.ts`, with tests beside them.

## License

MIT
