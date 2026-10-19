# workbar

A small Claude Code mod that shows what a session is doing and what it needs from you, without spending your tokens on it.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ █████████████████░░░░░░░░░░░░░░░░░░░░░░░  43%  ~4m left · ≈15:32             │
│ ✓ Read code   ✓ Find cause   ▶ Fix the band   ○ Tests   ○ Publish            │
│ ● Explore the API (Explore) · 12 tools · 1m 40s · Read claude-code.d.ts      │
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

## Why workbar

Claude Code is good at the work. It says little about the session around the work. workbar covers those gaps and nothing more:

- How far along is it, and when will it really be done?
- What is it waiting on: an agent, a question, your approval, a login?
- Is this chat getting too big or going cold, and what should you do about it?

What it holds to:

- **Small.** One band above the prompt, one status-line entry, two commands. No dashboards, no themes.
- **Close to zero tokens.** Everything it shows comes from what Claude Code already knows. It never calls a model unless you press a button, or turn on the optional new-task check.
- **Out of the way, never a mystery.** While Claude works it shows the plan, or one line saying why there is none. Between tasks it appears when it has something to say. It steps aside for Claude Code's own dialogs.
- **Terminal and desktop app alike.**

## What it does

| Feature | What you get |
|---|---|
| Progress bar | Steps, % done, time left and a finish time, for any task of more than a few steps. Every step is named whenever the band has room; finished agents give way first. When Claude's last report is a few minutes old with work going on since, the bar says so ("report 4m old") and Claude gets a short reminder. An unfinished plan carries into your next message ("continue", an answer to Claude's question). |
| Never a silent band | While Claude works with no plan, the band says why: thinking, a quick task that needs none, no plan from Claude yet, plans turned off, or the progress tool not loaded (with the fix). |
| Honest estimates | Models estimate how long a *person* would take. workbar learns from your finished tasks how long Claude really takes (median of the last 20), leaves out time spent waiting on you (questions, plan approval, permission prompts), and blends in the real pace once steps finish. Steps already done when the plan arrives are not mistaken for instant ones, and a step that runs over extends the time left instead of sitting at "under 1m". |
| Subagents | One row per agent: its task, tools used, time, current action and its own step count. Lots of agents collapse into a summary row. |
| Usage limit, every chat | When one chat hits the usage limit, every open chat shows **Log in** within a few seconds, and a chat in the middle of a task pauses before its next request with Continue / Log in here / Stop, then carries on by itself once you have logged in anywhere. |
| Chat health | Chat size gauge, prompt-cache countdown, usage windows past 50% with a "full at this pace" time. |
| Compact or Hand off | When the chat is big or the cache has gone cold: one press compacts in place (same task) or writes a handoff, clears, and puts it in the prompt box (new task). ★ marks the one that fits. A running compaction shows with its time, the result stays in the band for a few minutes, and a compact that cannot run says why. |
| Message hold | A message into a huge or cold chat is held once with those two options; Enter again sends it anyway. |
| Loop warning | Three failed tool calls in a row: a warning that Claude may be going in circles. |
| Alerts | A pop-up when Claude needs approval, has waited 15 s on a question, or finishes a run of 2 minutes or more. |
| Chrome reconnect | When the Claude in Chrome extension drops, it shows how to reconnect and tells Claude to wait rather than give up on the browser step. |
| Status line | The one thing that matters right now, mirrored into Claude Code's status line, so it shows even with the band folded. |

`/tasks` opens a pane with everything in full: every step with its time, every agent, the session's cost and limits, and how estimates are being scaled. `/handoff` writes a handoff and starts a fresh chat with it.

## Token cost

| Part | Cost |
|---|---|
| The `progress` tool | Its description and schema are about 150 tokens, part of the cached tool list (read at a tenth of the price after the first request). |
| Progress reports | A few dozen output tokens per report, sent alongside a tool call Claude was making anyway, so no extra round trips. Roughly 200 tokens for a typical task. |
| Plan reminder | Claude often skips the plan on medium-sized work. Once a message has taken more than 3 tool calls with no plan, one note of about 35 tokens asks for one, at most once per message. Quick answers never get it. |
| Progress reminder | When the plan falls behind (6 tool calls and 90 s with no report), one note of about 30 tokens reminds Claude to report finished steps; at most 3 per message. |
| A message typed mid-task | About 30 tokens of context asking Claude to update the plan. |
| Everything else | Drawn locally from what Claude Code already reports. No model calls. |
| New-task check (off by default) | A free local word check first; only a message that shares almost no words with your recent ones goes to Haiku, as a note of about 150 tokens (never the chat). At list prices that is roughly a thousandth of one normal message in a 100k chat. |
| Hand off (only when you press it) | One question over the transcript. With the cache warm it is read at the cached price, about a tenth of normal; with the cache cold it costs what any message into that chat would. Press it while the cache countdown is still running. |

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
| Spot a new task in a long chat | off | See Token cost. |
| Chat size: warn at | 150k | Amber from here, red at twice this. |
| Desktop alerts | on | Claude Code's own notifications (the desktop app, terminals that have them). On Windows Terminal, which has none Claude Code can use, a Windows toast instead. |
| Activity marker folder | empty | Each session writes `busy <ms>` / `idle <ms>` to `<folder>/<session id>.txt`, and `idle` when it ends, for your own scripts (sleep the machine when Claude is done, light a lamp...). |

The prompt cache lifetime is detected: 1 hour on a Claude subscription, 5 minutes on an API key, or your `promptCacheTtl` setting.

## How the band stays on screen

The band shares the bottom of the terminal with the prompt and Claude Code's own dialogs. Anything taller than its room scrolls in a small window, and on the main (non-fullscreen) screen a tall bottom area breaks the redraw. So workbar fits a fixed budget: at most a third of the terminal's height and never more than 12 rows, borders included. Every line truncates rather than wraps. The step list comes first: every step by name, with names shortened before anything folds. When the room still runs short, the actions stay and the details give way: done agents first, and last the step list, which folds into one line naming the current step and as many of the next ones as fit. While Claude shows a question or a plan for approval, the band steps aside completely and the status line says what is waiting.

## Known limitations

- The band is shared: only one mod draws above the prompt at a time. In `auto` mode workbar steps aside when there is nothing to show, so other mods' bands get their turn.
- Pausing at the usage limit saves no tokens: the prompt cache belongs to the account, so after switching accounts each chat's next request re-sends its context once, paused or not. What the pause saves is a half-done step and typing "continue".
- The usage-limit flag is shared through a small file, `workbar/limit.json` in your Claude config folder, so it reaches the chats on this machine only.
- The progress bar needs Claude to report a plan (or keep a todo or task list). Quick answers get none, on purpose, and the band says so.
- The band is drawn in the terminal and the desktop app only; Claude Code does not offer it in VS Code, on the web or on mobile. There, `/tasks` and the status line still work.
- Claude Code's `[-]` (or ctrl+x ctrl+a) collapses the band, and a mod cannot tell. If the band seems gone, press `[-]` again.
- In organizations that manage Claude Code, a user-installed mod's `Notification` and `StopFailure` hooks do not run, so approval alerts are skipped there (the usage-limit Log in button still follows Claude Code's notice).
- The band is tested on the terminal and desktop surfaces in Claude Code's test kit, and used daily on Windows 11 with Windows Terminal. The `/tasks` pane in the desktop app, and macOS and Linux, are less tried.

## Compared with

| | workbar | [claude-hud](https://github.com/jarrodwatts/claude-hud) | [cache-tax](https://github.com/karanb192/cache-tax) |
|---|---|---|---|
| Plan progress and time left | yes | todos only | no |
| Subagent rows | yes | yes | no |
| Context and usage limits | yes, with pace | yes, very configurable | cache only |
| Acts for you (compact, hand off, hold) | yes | no | holds a cold send, keeps the cache warm |
| Alerts | yes | no | no |

They overlap. If you already use claude-hud's status line, set workbar's band to `auto` and they sit fine together. If you use cache-tax, turn off workbar's message hold so a cold send is not held twice.

## Privacy

No network calls and no telemetry. The Haiku check runs only if you turn it on, on your own account.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

The hooks module is `hooks/register.tsx`; pure helpers (estimates, layout budget, topic check, the shared usage-limit flag) are in `hooks/lib.ts`, with tests beside them.

## License

MIT
