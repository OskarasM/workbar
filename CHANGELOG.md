# Changelog

## 0.5.0 (2026-10-19)

A bar that keeps up, honest time left again, and one usage limit for every chat.

- Fix: time left ran short since 0.4.0. Plans that arrive a few tool calls in (as the 0.4.0 reminder makes common) came with steps already done, and those counted as finished in no time, so the pace looked several times faster than it was. They now count as done before the plan, for the time left and for calibration. Calibration starts afresh (`calib2`), as the old samples carry that error.
- A new estimate counts from when it is given, not from the start of the plan, and the estimate weighs as one finished step against the real pace (was half), since early steps are often the quick ones.
- A step that runs over now extends the time left instead of counting down to "under 1m" and staying there.
- The bar keeps up: when Claude has made 6 tool calls over 90 s since its last report, one ~30-token note reminds it to report finished steps (at most 3 per message), and the band marks an old report ("report 4m old"). The tool's instructions now say the last step needs no report, and a run that ends one step short counts as finished instead of carrying into your next message.
- Usage limit, every chat: the chat that hits the limit tells the others through a small file in your Claude config folder. Every open chat shows Log in within 5 s; a chat mid-task pauses before its next request with Continue, Log in here or Stop, and carries on by itself after a login. A login in any chat, or Continue, clears it for all. Pausing saves no tokens (the prompt cache belongs to the account); it saves a half-done step and typing "continue".
- Fix: Claude Code's "Context limit reached" no longer reads as a usage limit.
- Fix: the activity marker is named after the session, so a reload of the mod no longer leaves a file stuck on "busy" (which kept PowerSwitch-style sleep scripts waiting), and a session writes "idle" when it ends.
- `/clear` now resets all of workbar's per-chat state.
- Removed: the files-changed row and its tracking. Claude Code already shows each edit, and it saves a file check on every edit.

## 0.4.0 (2026-10-16)

The band never goes quiet without saying why, and compaction is told plainly.

- While Claude works the band always shows: the plan, or one line saying why there is none (thinking, a quick task that needs none, no plan from Claude yet, plans turned off, or the progress tool not loaded, with the fix). The status line says the same. A new chat in `always` mode shows the band from the start.
- Plan reminder: Claude skipped the plan on almost every task of 4-10 tool calls (1 in 38 over two days). A message that runs past 3 tool calls with no plan now gets one ~35-token note asking for one, at most once per message. Quick answers are untouched.
- Every step is named: the full step list now comes before finished agents, step names shorten before the list folds, and the one-line fallback names the current step and as many of the next ones as fit, instead of a row of marks.
- An unfinished plan carries into your next message ("continue", an answer to Claude's question), with the time between messages left out of its estimate. A different plan replaces it; one Claude leaves untouched is dropped after that message.
- Claude's newer task list (TaskCreate, TaskUpdate) drives the bar too, like its todo list.
- Fix: after a compaction the band kept the old chat size, held the next message as "chat is 360k" and offered Compact again, which then failed with "Not enough messages to compact". The compaction's result is now the size until the next reply.
- A running compaction (the button, `/compact` or automatic) shows in the band and status line with its time, its result stays in the band for a few minutes, and a compaction that is skipped or fails says why in plain words. Compact is not offered while one runs, or right after one with nothing new to compact.
- README: which Claude Code apps draw the band, and how a collapsed band comes back.

## 0.3.0 (2026-10-16)

Smaller, cheaper, and ready for the desktop app.

- Settings trimmed from 11 to 7. Phone alerts (ntfy), the cache-lifetime setting and the alert-time setting are gone; amber and red are one "warn at" size (red at twice it). The cache lifetime is detected.
- The new-task check runs a free local word check first and calls Haiku only for a message that shares almost no words with your recent ones, with a ~150-token note at low effort. Still off by default.
- Alerts use Claude Code's own notifications first; the Windows toast only stands in where Claude Code can only ring the bell. No double pop-ups in the desktop app.
- Time on permission prompts no longer counts towards estimates, like questions and plan approval already did.
- Fix: **Log in** now appears when you hit a usage limit. It used to wait for a usage window to read 100%, which a turn ending on a grace allowance never showed; it now follows Claude Code's own "Usage limit reached" notice (and a usage-limit API error), and clears once you log in or the next turn starts.
- The band is tested on the desktop surface as well as the terminal.
- README: why workbar exists and what it holds to.

## 0.2.0 (2026-10-16)

First public release.

- The band always fits on screen: a fixed row budget (a third of the terminal, 12 rows at most), one line per row, and the least important rows give way first. Fixes the band scrolling or breaking the terminal's redraw with several subagents or in plan mode.
- The band steps aside while Claude shows a question or a plan for approval.
- Many subagents collapse into a summary row.
- Estimates: calibration can now scale Claude's estimates down to 0.15x (was 0.5x), time waiting on your answers no longer counts, and the real pace of finished steps takes over sooner. The tool asks Claude for its own working time, not a person's.
- Lower token cost: the progress instructions live only in the tool description (no extra system-prompt section), and the mid-task note is shorter. The new-task check is off by default.
- Progress from Claude's own todo list when it reports no plan; a zero-token mode that relies on it.
- Loop warning after three failed tool calls in a row.
- Usage windows show when they would run out at the current pace.
- Settings in `/config`: band mode, thresholds, cache lifetime, alerts, phone alerts through ntfy, activity marker folder.
- Works beyond Windows: paths, home folder and alerts follow the platform.
- `/tasks` shows agents, files, session cost and limits, and how estimates are scaled.

## 0.1.0

Private version: progress bar, chat health, Compact and Hand off, message hold, subagent rows, files changed, Windows alerts, Chrome reconnect help.
