<div align="center">

# workbar

**See how far along Claude Code is, when it will really be done, and what it needs from you.**

A small mod for Claude Code that adds one band above the prompt. It costs close to zero tokens.

[![checks](https://github.com/OskarasM/workbar/actions/workflows/ci.yml/badge.svg)](https://github.com/OskarasM/workbar/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/OskarasM/workbar)](https://github.com/OskarasM/workbar/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Claude Code 2.1.287+](https://img.shields.io/badge/Claude%20Code-2.1.287%2B-d97757)

</div>

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ █████████████████░░░░░░░░░░░░░░░░░░░░░░░  43%  ~4m left · ≈15:32             │
│ ✓ Read code   ✓ Find cause   ▶ Fix the band   ○ Tests   ○ Publish            │
│ ● Explore the API (Explore) · 12 tools · 1m 40s · Read claude-code.d.ts      │
╰──────────────────────────────────────────────────────────────────────────────╯
```

```
/plugin install workbar --marketplace OskarasM/workbar
```

## Why you'd want it

Claude Code does the work well, but it tells you little about the session around the work. You end up guessing:

- **"Is it nearly done, or should I go make coffee?"** workbar shows the plan, each step as it finishes, and a time left that learns how fast Claude really works on your machine, not how long a person would take.
- **"Why has it gone quiet?"** The band says what it is waiting on: an agent, a question, your approval, a login. You get a desktop alert when Claude needs you, or when a long run finishes, so you can step away.
- **"Why is this chat getting slow and expensive?"** A gauge shows how big the chat is and when the prompt cache goes cold. When it is worth acting, one button compacts the chat or hands the work to a fresh one.
- **"I hit my usage limit in one chat. What about the other five?"** Every open chat shows **Log in** within seconds. Chats in the middle of a task pause cleanly and carry on by themselves after you log in.

It does all this from what Claude Code already knows, so your bill barely notices it.

## What it looks like

**While Claude works:** a progress bar with every step named, time left and a finish time, plus one row per subagent.

**Between tasks:** a short health check that offers an action only when one is worth taking.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│  ACTION  chat 312k ━━━━━━━━━━  cache ✓ 41m  5h 72% full ≈16:10               │
│ ▲ Long chat: every message re-reads all 312k, and focus drops.               │
│ [ ★ Hand off ] new task   [ Compact ] same task                              │
╰──────────────────────────────────────────────────────────────────────────────╯
```

★ marks the action that fits. Hand off writes a summary, starts a fresh chat and puts the summary in the prompt box. Compact shrinks the chat in place.

## Features

| | What you get |
|---|---|
| **Progress bar** | Steps, % done, time left and a finish time for any task of more than a few steps. When Claude's last report is a few minutes old, the bar says so ("report 4m old") rather than pretending. An unfinished plan carries into your next message. |
| **Honest estimates** | Models guess how long a *person* would take, about 3x too long in the author's own history. workbar learns from your finished tasks how long Claude really takes (median of the last 20), leaves out time spent waiting on you, and blends in the real pace as steps finish. |
| **Never a blank band** | With no progress bar showing, the band says why: thinking, a quick task, no plan yet, or the progress tool not loaded (with the fix). |
| **Subagents** | One row per agent: its task, tools used, time and current action. Lots of agents collapse into a summary row. |
| **Chat health** | Chat size, a prompt-cache countdown, and usage windows past 50% with the time they fill at this pace. |
| **Compact or Hand off** | One press, when the chat is big or the cache has gone cold. A running compaction shows its time, and one that cannot run says why. |
| **Message hold** | A message into a huge or cold chat is held once with those two options. Press Enter again to send it anyway. |
| **Usage limit, every chat** | The chat that hits the limit tells all the others on this machine. A chat mid-task pauses with Continue / Log in here / Stop. |
| **Alerts** | A pop-up when Claude needs approval, has waited 15 s on a question, or finishes a run of 2 minutes or more. |
| **Loop warning** | Three failed tool calls in a row warn you that Claude may be going in circles. |
| **Chrome reconnect** | When the Claude in Chrome extension drops, workbar shows how to reconnect and tells Claude to wait instead of giving up on the browser step. |
| **Status line** | The one thing that matters right now, mirrored into Claude Code's status line. |

Two commands: `/workbar` opens a pane with everything in full (every step with its time, every agent, the session's cost and limits, and how estimates are scaled). `/handoff` writes a handoff and starts a fresh chat with it.

## Costs almost nothing

workbar reads what Claude Code already reports. It never calls a model on its own, unless you press a button or turn on the optional new-task check.

| Part | Cost |
|---|---|
| The `progress` tool | About 180 tokens of description and schema. They sit in the cached tool list, so after the first request they're read at a tenth of the price. |
| Progress reports | A few dozen output tokens each, sent alongside a tool call Claude was making anyway, so no extra round trips. Roughly 200 tokens for a typical task, and none for a quick answer. |
| Plan reminder | Once a message has taken more than 3 tool calls with no plan, one note of about 40 tokens asks for one. At most once per message. |
| Progress reminder | When the plan falls behind (6 tool calls and 90 s with no report), one note of about 40 tokens. At most 3 per message. |
| A message typed mid-task | About 30 tokens asking Claude to update the plan. |
| Everything else | Drawn locally. No model calls. |
| New-task check (off by default) | A free local word check first. Only a message that shares almost no words with your recent ones goes to Haiku, as a note of about 150 tokens. |
| Hand off (only when you press it) | One question over the transcript, at the cached price while the cache is warm. |

**Want zero?** Turn off **Ask Claude for a progress plan**. The bar then follows Claude's own todo list when it keeps one, and nothing at all is added to your requests.

## Install

Needs Claude Code 2.1.287 or newer (with mods). Tested on 2.1.301.

| Where | How |
|---|---|
| In a Claude Code session | `/plugin install workbar --marketplace OskarasM/workbar` |
| From a shell | `claude plugin install workbar --marketplace OskarasM/workbar` |
| Desktop app | Click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `OskarasM/workbar`, then **Add plugin**. |

To update: `claude plugin marketplace update workbar`, then `claude plugin update workbar`. To remove: `claude plugin uninstall workbar`.

## Settings

All in `/config` under **workbar**.

| Setting | Default | |
|---|---|---|
| Band above the prompt | `auto` | `auto` shows the band when there is something to see or do, and keeps the chat size in the status line otherwise. `always` also keeps the chat gauge up between tasks. `off` uses the status line only. |
| Ask Claude for a progress plan | on | Off: zero tokens, and the bar follows Claude's todo list. |
| Hold a message into an oversized or cold chat | on | |
| Spot a new task in a long chat | off | See [Costs almost nothing](#costs-almost-nothing). |
| Chat size: warn at | 150k | Amber from here, red at twice this. |
| Desktop alerts | on | Claude Code's own notifications where it has them. On Windows Terminal, a Windows toast instead. |
| Activity marker folder | empty | Each session writes `busy <ms>` / `idle <ms>` to `<folder>/<session id>.txt`, for your own scripts: sleep the machine when Claude is done, light a lamp, and so on. |

The prompt cache lifetime is detected: 1 hour on a Claude subscription, 5 minutes on an API key, or your `promptCacheTtl` setting.

## Known limitations

- Only one mod can draw above the prompt at a time. In `auto` mode workbar steps aside when it has nothing to show, so other mods get their turn.
- The progress bar needs Claude to report a plan or keep a todo list. Quick answers get none on purpose, and the band says so.
- The band shows in the terminal and the desktop app. Claude Code doesn't offer it in VS Code, on the web or on mobile; there, `/workbar` and the status line still work.
- Pausing at the usage limit saves no tokens, because the prompt cache belongs to the account. It saves a half-done step and typing "continue".
- The usage-limit flag is shared through `workbar/limit.json` in your Claude config folder, so it reaches chats on this machine only.
- Claude Code's `[-]` (or ctrl+x ctrl+a) collapses the band, and a mod can't tell. If the band seems gone, press `[-]` again.
- Where an organization manages Claude Code, a user-installed mod's `Notification` and `StopFailure` hooks don't run, so approval alerts are skipped there.
- Used daily on Windows 11 with Windows Terminal, and tested on all three operating systems in CI. The `/workbar` pane in the desktop app, and day-to-day use on macOS and Linux, have had less real-world testing. Issues are welcome.

<details>
<summary><b>How the band stays on screen</b></summary>

<br>

The band shares the bottom of the terminal with the prompt and Claude Code's own dialogs. Anything taller than its room scrolls in a small window, and on the main (non-fullscreen) screen a tall bottom area breaks the redraw. So workbar fits a fixed budget: at most a third of the terminal's height and never more than 12 rows, borders included. Every line truncates rather than wraps.

The step list comes first, every step by name, with names shortened before anything folds. When room runs short, the actions stay and the details give way: finished agents first, and last the step list, which folds into one line naming the current step and as many of the next ones as fit. While Claude shows a question or a plan for approval, the band steps aside completely and the status line says what is waiting.

</details>

## Compared with

| | workbar | [claude-hud](https://github.com/jarrodwatts/claude-hud) | [cache-tax](https://github.com/karanb192/cache-tax) |
|---|---|---|---|
| Plan progress and time left | yes | todos only | no |
| Subagent rows | yes | yes | no |
| Context and usage limits | yes, with pace | yes, very configurable | cache only |
| Acts for you (compact, hand off, hold) | yes | no | holds a cold send, keeps the cache warm |
| Alerts | yes | no | no |

They overlap. If you already use claude-hud's status line, set workbar's band to `auto` and they sit fine together. If you use cache-tax, turn off workbar's message hold so a cold send isn't held twice.

## Privacy

No network calls and no telemetry. The Haiku check runs only if you turn it on, and then on your own account.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

The hooks module is `hooks/register.tsx`. Pure helpers (estimates, layout budget, topic check, the shared usage-limit flag) are in `hooks/lib.ts`, with tests beside them. See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## License

[MIT](LICENSE)
