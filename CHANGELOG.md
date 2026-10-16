# Changelog

## 0.3.0 (2026-10-16)

Smaller, cheaper, and ready for the desktop app.

- Settings trimmed from 11 to 7. Phone alerts (ntfy), the cache-lifetime setting and the alert-time setting are gone; amber and red are one "warn at" size (red at twice it). The cache lifetime is detected.
- The new-task check runs a free local word check first and calls Haiku only for a message that shares almost no words with your recent ones, with a ~150-token note at low effort. Still off by default.
- Alerts use Claude Code's own notifications first; the Windows toast only stands in where Claude Code can only ring the bell. No double pop-ups in the desktop app.
- Time on permission prompts no longer counts towards estimates, like questions and plan approval already did.
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
