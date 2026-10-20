import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AgentRun, ChromeIssue, Health, Hold, Live, Notice, Plan, Stuck } from '../types'
import {
  activeMinutes,
  advancePlan,
  bandBudget,
  calibrationFrom,
  calibrationSample,
  clip,
  compactSkipText,
  fitRows,
  fmtDur,
  fmtK,
  fmtMin,
  freshTokens,
  hhmm,
  isSharedLimitOn,
  limitLabel,
  limitUntil,
  looksUnrelated,
  minutesLeft,
  nextPaceBases,
  paceFullAt,
  parseSharedLimit,
  plural,
  sharesStep,
  wrappedRows,
} from './lib'
import type { SharedLimit } from './lib'

// ---- options (Claude Code's /config, under workbar) ----
type Opts = {
  band: 'auto' | 'always' | 'off'
  progressTool: boolean
  holdMessages: boolean
  topicCheck: boolean
  amberTokens: number // "warn at": amber from here, red at twice this
  redTokens: number
  notify: boolean
  activityDir: string
}
function readOpts(raw: unknown): Opts {
  const o = (raw ?? {}) as Record<string, unknown>
  const warn = typeof o.warnTokens === 'number' && Number.isFinite(o.warnTokens) && o.warnTokens >= 10_000 ? o.warnTokens : 150_000
  return {
    band: o.band === 'always' || o.band === 'off' ? o.band : 'auto',
    progressTool: o.progressTool !== false,
    holdMessages: o.holdMessages !== false,
    topicCheck: o.topicCheck === true,
    amberTokens: warn,
    redTokens: warn * 2,
    notify: o.notify !== false,
    activityDir: typeof o.activityDir === 'string' ? o.activityDir.trim() : '',
  }
}
let opts = readOpts(undefined)

const COLD_HOLD_TOKENS = 100_000 // with the cache expired, hold messages above this size
const TOPIC_CHECK_TOKENS = 60_000
const NOTIFY_AFTER_S = 120 // alert when a run takes longer than this
const ASK_ALERT_MS = 15_000 // alert when a question from Claude waits this long
const STUCK_AFTER = 3 // failed tool calls in a row

// One description, read by Claude with the tool list; nothing goes into CLAUDE.md or the system prompt.
const PROGRESS_TOOL = 'mcp__workbar__progress'
const PROGRESS_DESCRIPTION =
  "Live progress bar for the user. For a task needing more than ~3 tool calls, call it first with `steps` (3-10 short labels for the whole task; count any already finished in `done`) and `estimate_minutes`: your own wall-clock minutes from now to finish, not the hours a person would take. Each time a step finishes, put `done` (steps finished) in the same response as your next tool call, never alone; the last step needs no call. If the plan changes, resend the full `steps`, `done` and a new estimate. Skip it for quick answers."
const MIDRUN_NOTE = 'If this changes the work, resend mcp__workbar__progress with the full updated `steps` and estimate alongside your next tool call.'
// Claude often skips the tool on work of 4-10 tool calls. One reminder per message, only once a task has
// proved longer than a quick answer, so short replies cost nothing.
const QUICK_TOOLS = 3 // up to this many tool calls with no plan reads as a quick task
const NUDGE_NOTE =
  'This task is taking several steps: send mcp__workbar__progress (`steps`, `estimate_minutes`) alongside your next tool call so the user can see progress.'
const NUDGE_CARRIED_NOTE =
  "The progress bar still shows your plan from the user's last message: alongside your next tool call send mcp__workbar__progress with `done`, or new `steps` and `estimate_minutes` if this is different work."
// A plan left behind the work: after this many tool calls and this long with no report, one short note
// (about 30 tokens) reminds Claude to send `done`, at most a few times per message.
const STALE_TOOLS = 6
const STALE_MS = 90_000
const STALE_NUDGES = 3
const staleNote = (p: Plan) =>
  `The progress bar shows step ${p.done + 1}/${p.steps.length} "${p.steps[p.done] ?? ''}". If steps have finished since, send mcp__workbar__progress with \`done\` alongside your next tool call.`
// A report older than this, with tool calls since, is marked in the band so a lagging bar is not taken at its word.
const REPORT_OLD_MS = 3 * 60_000
const NOTICE_MS = 3 * 60_000 // how long a notice stays in the band
const TASKS_PANE = 'workbar-tasks'
const CHROME_PREFIX = 'mcp__claude-in-chrome__'
const CHROME_DOWN = /not connected|receiving end does not exist|not detected|no browser (is )?connected/i
const CHROME_NOTE =
  'The user has been shown how to reconnect the Chrome extension (/chrome, then Reconnect extension). Do not switch approach or drop the browser step: say in one line what you need the browser for, then wait for the user to say it is reconnected, and retry.'

const EMPTY_LIVE: Live = {
  isWorking: false,
  startedAt: 0,
  tools: 0,
  lastAction: '',
  plan: null,
  waitingSince: 0,
  lastRun: null,
  carryPlan: false,
  endedAt: 0,
  nudged: false,
}
const EMPTY_HEALTH: Health = {
  tokens: 0,
  prompts: 0,
  lastResponseAt: 0,
  firstPrompt: '',
  recentPrompts: [],
  allowedUntilTokens: 0,
  isHandingOff: false,
  isCompacting: false,
  limits: [],
  paceBases: [],
  costUsd: 0,
  limitNoticeAt: 0,
  compactStartedAt: 0,
  compactedAt: 0,
  compactedFrom: 0,
  compactedTo: 0,
  promptsAtCompact: 0,
}

const live = atom({ plugin: 'workbar', key: 'live' } as const, EMPTY_LIVE)
const health = atom({ plugin: 'workbar', key: 'health' } as const, EMPTY_HEALTH)
const hold = atom({ plugin: 'workbar', key: 'hold' } as const, null as Hold)
const tick = atom({ plugin: 'workbar', key: 'tick' } as const, 0)
const chrome = atom({ plugin: 'workbar', key: 'chrome' } as const, null as ChromeIssue)
const stuck = atom({ plugin: 'workbar', key: 'stuck' } as const, null as Stuck)
const agents = atom({ plugin: 'workbar', key: 'agents' } as const, [] as AgentRun[])
const asking = atom({ plugin: 'workbar', key: 'asking' } as const, null as string | null)
const notice = atom({ plugin: 'workbar', key: 'notice' } as const, null as Notice)

async function say($: EngineInterface, text: string, tone: 'info' | 'warning' = 'info') {
  const at = await $.clock.now()
  await update($, notice, () => ({ text, tone, until: at + NOTICE_MS }))
}

// Whether Claude is offered the progress tool in this chat (null: not known yet), from the last prompt built.
let progressOffered: boolean | null = null

// Why there is no progress bar while Claude works: a full line for the band, a short one for the status line.
function noPlanReason(l: Live): { long: string; short: string } {
  if (!opts.progressTool) return { long: 'No progress bar: plans are off in /config (workbar), and Claude keeps no todo list here', short: 'no plan (plans off)' }
  if (progressOffered === false) return { long: 'No progress bar: the progress tool is not loaded in this chat. Run /reload-plugins', short: 'no plan: /reload-plugins' }
  if (l.tools === 0) return { long: 'Thinking. A progress bar appears if this takes several steps', short: 'thinking' }
  if (l.tools <= QUICK_TOOLS) return { long: 'Quick task: no progress bar needed', short: `quick task · ${plural(l.tools, 'tool')}` }
  return { long: l.nudged ? 'No plan from Claude yet: asked it for one' : 'No plan from Claude yet', short: `no plan yet · ${plural(l.tools, 'tool')}` }
}

// Claude's task list (TaskCreate / TaskUpdate), kept by id, for the bar when it reports no plan.
const tasks = new Map<string, { content: string; status: string }>()

// Facts about this machine and session, read once at session start.
let isWindows = false
let settingsTtl: '5m' | '1h' | '' = ''
let hasActivityDir = false
let sharedDir = '' // where every chat on this machine reads and writes the usage-limit flag
let errStreak = { tool: '', count: 0 }

// ---- activity markers for your own scripts ----
// Named after the session, which outlives a reload of this module, so a reload never leaves a "busy" file behind.
async function markActivity($: EngineInterface, state: 'busy' | 'idle', sessionId?: string) {
  if (!hasActivityDir) return
  try {
    const id = (sessionId ?? (await $.session.id())).replace(/[^\w.-]/g, '_')
    await $.fs.write(`${opts.activityDir.replace(/[\\/]+$/, '')}/${id}.txt`, `${state} ${await $.clock.now()}`)
  } catch {
    // a script reading these falls back to its own timeout
  }
}

// ---- alerts: Claude Code's own notification first (the desktop app, terminals with a channel) ----
// Windows Terminal has none ($.ui.notify only rings the bell there), so on Windows a bell-only or
// failed notification becomes a Windows toast. Title and text travel in the environment, not the script.
const TOAST_PS = `$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode($env:WB_TITLE)) > $null
$n.Item(1).AppendChild($t.CreateTextNode($env:WB_TEXT)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))`
let lastAlertAt = 0

async function alert($: EngineInterface, text: string) {
  if (!opts.notify) return
  const at = await $.clock.now()
  if (at - lastAlertAt < 5000) return // one alert for one moment
  lastAlertAt = at
  try {
    const r = await $.ui.notify(text, { title: 'Claude Code' }).catch(() => ({ isSent: false as const, reason: 'error' }))
    const shown = r.isSent && r.channel !== 'terminal_bell'
    if (shown || !isWindows || (!r.isSent && r.reason === 'disabled')) return
    void $.process
      .run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', TOAST_PS], {
        env: { WB_TITLE: 'Claude Code', WB_TEXT: text },
        timeoutMs: 15000,
      })
      .catch(() => undefined)
  } catch {
    // a missed alert is not worth failing anything for
  }
}

// Claude asking you something: the dialog stays open exactly as long as the tool call does.
const QUESTION_TOOLS: Record<string, string> = { AskUserQuestion: 'Claude has a question for you', ExitPlanMode: 'Claude has a plan for you to approve' }

const HANDOFF_PROMPT = `Write a handoff prompt that I will paste as the first message of a brand-new Claude Code chat in this same project, so a fresh session continues with no loss of quality.
Output only the prompt itself, no preamble or closing remarks. Cover, concisely:
1. Goal and what "done" means.
2. Current state: what is finished and verified, what is in progress (exact file paths, functions, commands).
3. Decisions made and approaches rejected, each with a one-line reason.
4. Open problems, errors seen, and anything still unverified.
5. The next steps, in order.
6. Files to read first (paths only; if the project has docs/STATE.md, list it first).
Point to files rather than pasting their contents. Stay under 350 words unless more is truly needed.`

// Each finished plan's actual/estimated. Before 0.5.0 a plan sent a few tool calls in counted its
// already-finished steps as instant, so those samples ran short; they stay behind under the old key.
const CALIB_KEY = 'calib2'
async function calibration($: EngineInterface): Promise<number> {
  return calibrationFrom((await $.store.get(CALIB_KEY)) as number[] | undefined)
}

// 1 hour on a Claude subscription (it reports usage windows), 5 minutes otherwise, unless promptCacheTtl says.
const cacheTtlMs = (h: Health) => {
  const ttl = settingsTtl || (h.limits.length > 0 ? '1h' : '5m')
  return (ttl === '1h' ? 60 : 5) * 60_000
}

type Level = 'ok' | 'amber' | 'red' | 'cold'

function level(h: Health, now: number): Level {
  const isCold = h.lastResponseAt > 0 && now - h.lastResponseAt > cacheTtlMs(h)
  if (isCold && h.tokens >= Math.min(COLD_HOLD_TOKENS, opts.amberTokens)) return 'cold'
  if (h.tokens >= opts.redTokens) return 'red'
  if (h.tokens >= opts.amberTokens) return 'amber'
  return 'ok'
}

// A usage limit reached: Claude Code says so itself; the band only adds a way to switch account. Its notice
// is the reliable sign (a turn can end normally on a grace allowance with the window under 100%).
// Never a bare "limit reached": Claude Code's "Context limit reached" is about this chat alone.
const LIMIT_TEXT = /usage limit reached|(?:5-hour|session|weekly|opus|sonnet) limit reached|(?:hit|reached) your (?:usage |weekly |session )?limit|out of (?:extra )?usage/i
const isLimitHit = (h: Health, now: number) =>
  (h.limitNoticeAt ?? 0) > 0 || h.limits.some(x => x.pct >= 100 && (!x.resetsAt || !(Date.parse(x.resetsAt) <= now)))

// The limit is the account's, so every chat on this machine shares one flag file: the chat that hits
// it writes it, the others read it on their 5 s tick and show Log in too, and a chat that starts a
// request meanwhile pauses and asks first. A login anywhere, or any chat's next reply, clears it.
let sharedLimit: SharedLimit | null = null // the flag as last read or written
let lastOkAt = 0 // when this chat's last request that got a reply was sent
const limitPath = () => `${sharedDir}/limit.json`

async function readSharedLimit($: EngineInterface): Promise<SharedLimit | null> {
  if (!sharedDir) return null
  try {
    sharedLimit = parseSharedLimit(String(await $.fs.read(limitPath())))
  } catch {
    sharedLimit = null // no file: no chat has hit a limit
  }
  return sharedLimit
}
async function writeSharedLimit($: EngineInterface, s: SharedLimit) {
  sharedLimit = s
  if (!sharedDir) return
  try {
    await $.fs.write(limitPath(), JSON.stringify(s))
  } catch {
    // the other chats find out from their own next request instead
  }
}

// scope 'all': this chat learnt it first-hand (a notice, a login), so every chat hears. 'here': only this chat's view.
async function markLimit($: EngineInterface, hit: boolean, scope: 'all' | 'here' = 'all') {
  const at = await $.clock.now()
  await update($, health, h => ({ ...h, limitNoticeAt: hit ? at : 0, limitFromOther: false, limits: hit ? h.limits : h.limits.filter(x => x.pct < 100) }))
  if (scope === 'all') {
    const prev = await readSharedLimit($)
    if (hit) {
      await writeSharedLimit($, { hitAt: at, until: limitUntil((await read($, health)).limits, at), clearedAt: prev?.clearedAt ?? 0 })
      if (!isSharedLimitOn(prev, at, lastOkAt)) void alert($, 'Usage limit reached. Log in from any chat; the others wait for it.')
    } else if (prev && prev.hitAt > prev.clearedAt) {
      await writeSharedLimit($, { ...prev, clearedAt: at })
    }
  }
  await syncStatus($)
}

// On the tick: take up another chat's limit, or drop this one's once a login anywhere has cleared it.
async function syncSharedLimit($: EngineInterface) {
  if (!sharedDir) return
  const s = await readSharedLimit($)
  const now = await $.clock.now()
  const h = await read($, health)
  if (s && isSharedLimitOn(s, now, lastOkAt)) {
    if (h.limitNoticeAt) return
    await update($, health, x => ({ ...x, limitNoticeAt: s.hitAt, limitFromOther: true }))
    await syncStatus($)
  } else if (h.limitNoticeAt && s && s.clearedAt >= h.limitNoticeAt) {
    await update($, health, x => ({ ...x, limitNoticeAt: 0, limitFromOther: false, limits: x.limits.filter(l => l.pct < 100) }))
    await syncStatus($)
  }
}

// A request about to go out while the account is at its limit: ask before sending it, so the chat
// waits for the login and then carries on by itself. One question at a time, however many requests wait.
const ASK_CONTINUE = 'Continue'
const ASK_LOGIN = 'Log in here'
const ASK_STOP = 'Stop'
let pausing: Promise<'go' | 'stop'> | null = null
let mainTurnId = '' // the main loop's running turn, which Stop ends

// The dialog is an AskUserQuestion call, so the tool.call hook below shows it in the status line, keeps
// its time out of the estimate and alerts after a while, as for Claude's own questions.
const PAUSED = 'Paused at the usage limit: log in, then Continue'
async function askToContinue($: EngineInterface): Promise<'go' | 'stop'> {
  let pick: string
  try {
    pick = await $.ui.ask(
      'The usage limit is reached, so this chat is paused before its next request. Log in (Log in in another chat, or here), then Continue. Continue?',
      { header: 'Usage limit', options: [ASK_CONTINUE, ASK_LOGIN, ASK_STOP] },
    )
  } catch {
    pick = ASK_CONTINUE // dismissed, or nobody to ask: send it, and Claude Code says if it fails
  }
  if (pick === ASK_STOP) return 'stop'
  if (pick === ASK_LOGIN) {
    $.clock.after(200, () => void $.command.run({ command: 'login' }).catch(() => undefined))
    return 'stop'
  }
  await markLimit($, false) // you say it is sorted: the other chats go on too
  return 'go'
}

// Unfinished plan or a same-task message: Compact. Finished plan or a new-task message: Hand off.
function recommendsHandoff(l: Live, held: Hold): boolean {
  if (held) return held.isNewTask
  const r = l.lastRun
  return !!r && r.steps > 0 && r.done >= r.steps
}

function timeLeft(p: Plan, now: number, calib: number, waitingSince: number): string {
  if (p.done >= p.steps.length) return 'finishing up'
  const mins = minutesLeft(p, now, calib, waitingSince)
  return mins === null ? '' : `~${fmtMin(mins)} left`
}

// "report 4m old" once Claude's last progress report is old and work has gone on since: the bar may lag.
function reportAge(l: Live, now: number): string {
  const p = l.plan
  if (!p || p.source !== 'progress' || p.carried || !l.reportedAt || p.done >= p.steps.length) return ''
  const age = now - l.reportedAt
  return age >= REPORT_OLD_MS && l.tools > (l.staleFrom ?? 0) ? `report ${Math.floor(age / 60000)}m old` : ''
}

// Claude Code's own status line slot for this mod: the one thing that matters, even with the band folded.
let lastStatus: string | undefined = '\u0000'
async function syncStatus($: EngineInterface) {
  try {
    const l = await read($, live)
    const h = await read($, health)
    const ags = await read($, agents)
    const held = await read($, hold)
    const ask = await read($, asking)
    const st = await read($, stuck)
    const now = await $.clock.now()
    const running = ags.filter(a => a.status === 'running').length
    const agentsTxt = running ? ` · ${plural(running, 'agent')}` : ''
    let text: string | undefined
    if (ask) text = `◆ ${ask}`
    else if (h.compactStartedAt) text = `◐ compacting · ${fmtDur(now - h.compactStartedAt)}`
    else if (!l.isWorking && isLimitHit(h, now)) text = '★ Log in to continue'
    else if (l.isWorking && st) text = `▲ ${st.count} failed ${st.tool} calls in a row${agentsTxt}`
    else if (l.isWorking && h.limitNoticeAt) text = `▲ usage limit: pauses before its next request${agentsTxt}`
    else if (l.isWorking && l.plan && l.plan.steps.length > 0) {
      const p = l.plan
      const left = timeLeft(p, now, await calibration($), l.waitingSince)
      const age = reportAge(l, now)
      text = `▶ ${p.done}/${p.steps.length}${left ? ` · ${left}` : ''}${age ? ` · ${age}` : ''}${agentsTxt}`
    } else if (running > 0) text = `● ${plural(running, 'agent')} running`
    else if (l.isWorking) text = `○ ${noPlanReason(l).short}`
    else if (held) text = `‖ message held · ${held.isNewTask ? 'Hand off' : 'Compact'} ★`
    else if (!l.isWorking && h.tokens > 0) {
      const lv = level(h, now)
      if (lv === 'red' || lv === 'cold') text = `★ ${recommendsHandoff(l, held) ? 'Hand off' : 'Compact'} · chat ${fmtK(h.tokens)}`
      else if (opts.band !== 'always') {
        const left = cacheTtlMs(h) - (now - h.lastResponseAt)
        text = `chat ${fmtK(h.tokens)}${lv === 'amber' ? ' (big)' : ''} · cache ${left > 0 ? `${Math.ceil(left / 60000)}m` : 'cold'}`
      }
    }
    if (text !== lastStatus) {
      lastStatus = text
      $.ui.status(text)
    }
  } catch {
    // the status line is a mirror; the band still shows everything
  }
}

// A chat-size reading, unless it is the pre-compaction size Claude Code still reports until the next reply.
function withReading(h: Health, reading: number): Health {
  const r = freshTokens(reading, h.tokens, h.compactedFrom ?? 0)
  return r.isStale ? h : { ...h, tokens: r.tokens, compactedFrom: 0 }
}

async function refreshTokens($: EngineInterface) {
  try {
    const usage = await $.session.usage()
    const tokens = usage.context.tokens ?? 0
    const at = await $.clock.now()
    const limits = usage.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt ?? '' }))
    await update($, health, h => ({
      ...withReading(h, tokens),
      lastResponseAt: at,
      limits,
      paceBases: nextPaceBases(h.paceBases ?? [], limits, at),
      costUsd: usage.cost?.usd ?? h.costUsd ?? 0,
    }))
  } catch {
    // usage is best effort; the band keeps its last reading
  }
}

// Is a new message a different task? A free local check first: a message that shares words with the
// recent requests is the same work, and most are. Only one that shares almost none goes to Haiku, as a
// note of about 150 tokens (never the chat), at low effort with a tiny reply.
async function isNewTopic($: EngineInterface, h: Health, text: string): Promise<boolean> {
  if (!looksUnrelated(text, [h.firstPrompt, ...h.recentPrompts])) return false
  const prompt = `Requests so far in one coding chat:\n- ${clip(h.firstPrompt, 200)}\n${h.recentPrompts.map(p => `- ${clip(p, 150)}`).join('\n')}\nNew request: ${clip(text, 300)}\nSame piece of work, or a new task better started fresh? Reply SAME or NEW.`
  const r = await $.model.complete({ model: 'haiku', prompt, maxTokens: 16, effort: 'low', timeoutMs: 4000 })
  return r.isAnswered === true && /\bNEW\b/i.test(r.text)
}

const COMPACT_FOCUS =
  'Keep the goal, decisions with their reasons, exact file paths and commands, the current state, anything unverified, errors seen, and the next steps. Drop exploration that led nowhere.'

const LEVEL_RANK: Record<Level, number> = { ok: 0, amber: 1, cold: 2, red: 2 }
let lastAdvised: Level = 'ok'

// Same task, big chat: compact in place (keeps this session: approvals, background tasks, browser tabs).
// Compacted since your last message: there is nothing new to summarise yet.
const justCompacted = (h: Health) => (h.compactedAt ?? 0) > 0 && h.prompts === (h.promptsAtCompact ?? -1)
const compactedLine = (h: Health) =>
  `Compacted at ${hhmm(new Date(h.compactedAt ?? 0))}${(h.compactedTo ?? 0) > 0 ? `: now ${fmtK(h.compactedTo ?? 0)}` : ''}`

async function compactNow($: EngineInterface, thenSend?: string) {
  const h = await read($, health)
  if (h.compactStartedAt) {
    await say($, `Already compacting (${fmtDur((await $.clock.now()) - h.compactStartedAt)} so far). The size updates when it finishes.`, 'warning')
    return
  }
  if (h.isCompacting || h.isHandingOff) return
  if (justCompacted(h) && !thenSend) {
    await say($, `Nothing new to compact. ${compactedLine(h)}, and no message has been sent since.`, 'warning')
    return
  }
  const at = await $.clock.now()
  await update($, health, x => ({ ...x, isCompacting: true, compactStartedAt: x.compactStartedAt || at }))
  await syncStatus($)
  $.ui.toast('Compacting this chat…')
  $.clock.after(50, async () => {
    try {
      const r = await $.session.compact({ instructions: COMPACT_FOCUS })
      if ('skip' in r && r.skip) return // the session.compact hook has said why
      await update($, hold, () => null)
      if (thenSend) await $.prompt.submit({ text: thenSend, asUser: true })
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      await say($, /not enough|too few/i.test(why) ? compactSkipText(why, justCompacted(await read($, health))) : `Compact failed: ${clip(why, 100)}. Try /compact, or Hand off.`, 'warning')
    } finally {
      await update($, health, x => ({ ...x, isCompacting: false, compactStartedAt: 0 }))
      await syncStatus($)
    }
  })
}

async function handOff($: EngineInterface, nextTask?: string) {
  const h = await read($, health)
  if (h.isHandingOff) return
  await update($, health, x => ({ ...x, isHandingOff: true }))
  $.ui.toast('Writing the handoff from this chat…')
  try {
    const prompt = nextTask
      ? `${HANDOFF_PROMPT}\n\nEnd with a section "Next task" that hands over this request, which the user wants done in the new chat:\n"""${nextTask}"""`
      : HANDOFF_PROMPT
    const r = await $.model.fork({ prompt })
    if (!r.isAnswered || !('text' in r) || !r.text.trim()) {
      $.ui.toast(`Handoff failed (${'reason' in r ? r.reason : 'no text'}). Nothing was cleared.`)
      return
    }
    const text = r.text.trim()
    await $.ui.copy({ text })
    await update($, hold, () => null)
    $.clock.after(50, async () => {
      try {
        await $.command.run({ command: 'clear' })
        await $.prompt.fill({ text })
        $.ui.toast('Fresh chat ready: the handoff is in the prompt box and on the clipboard. Check it, then press Enter.')
      } catch {
        $.ui.toast('The handoff is on your clipboard. Run /clear and paste it.')
      }
    })
  } finally {
    await update($, health, x => ({ ...x, isHandingOff: false }))
  }
}

// Time spent waiting on you (a question, plan approval, a permission prompt) is not Claude's working
// time: it is kept out of the estimates and out of calibration.
let permissionWaiting = false
async function beginWait($: EngineInterface, at: number) {
  await update($, live, l => (l.waitingSince ? l : { ...l, waitingSince: at }))
}
async function endWait($: EngineInterface) {
  permissionWaiting = false
  const at = await $.clock.now()
  await update($, live, l => {
    if (!l.waitingSince) return l
    const waited = Math.max(0, at - l.waitingSince)
    const plan = l.plan && l.plan.startedAt <= l.waitingSince ? { ...l.plan, waitMs: l.plan.waitMs + waited } : l.plan
    return { ...l, waitingSince: 0, plan }
  })
}

// Claude's own todo list (TodoWrite) as a plan, for when it keeps one instead of reporting progress.
function planFromTodos(prev: Plan | null, todos: { content: string; status: string }[], at: number): Plan | null {
  if (todos.length === 0) return null
  const order = { completed: 0, in_progress: 1, pending: 2 } as Record<string, number>
  const sorted = [...todos].sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2))
  const steps = sorted.map(t => clip(String(t.content), 80)).slice(0, 20)
  const done = Math.min(steps.length, sorted.filter(t => t.status === 'completed').length)
  return advancePlan(prev && prev.source === 'todos' ? prev : null, steps, 0, done, at, 'todos')
}

// Claude's task list as a plan. A new list after a finished one starts over.
function planFromTasks(prev: Plan | null, at: number): Plan | null {
  return planFromTodos(prev, [...tasks.values()], at)
}
function trackTask(tool: string, args: Record<string, unknown>, result: unknown): boolean {
  if (tool === 'TaskCreate') {
    const id = (result as { task?: { id?: unknown } } | undefined)?.task?.id
    if (typeof id !== 'string' && typeof id !== 'number') return false
    if ([...tasks.values()].every(t => t.status === 'completed')) tasks.clear()
    tasks.set(String(id), { content: String(args.subject ?? ''), status: 'pending' })
    return true
  }
  if (tool === 'TaskUpdate') {
    const id = String(args.taskId ?? '')
    const t = tasks.get(id)
    if (!t) return false
    if (args.status === 'deleted') tasks.delete(id)
    else tasks.set(id, { content: typeof args.subject === 'string' ? args.subject : t.content, status: typeof args.status === 'string' ? args.status : t.status })
    return true
  }
  return false
}

export const register: Register = (on, options) => {
  opts = readOpts(options)

  on('session.start', async ($, e, next) => {
    // Each setup step on its own: one that fails is reported and never takes the others down with it.
    const failed: string[] = []
    const step = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (err) {
        failed.push(`${name} (${err instanceof Error ? err.message : String(err)})`)
      }
    }
    await step('machine', async () => {
      isWindows = (await $.env.get('OS')) === 'Windows_NT' || /^[a-zA-Z]:[\\/]/.test(e.cwd)
      const home = ((isWindows ? await $.env.get('USERPROFILE') : undefined) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
      const config = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? '').replace(/\\/g, '/') || (home ? `${home}/.claude` : '')
      sharedDir = config ? `${config.replace(/\/+$/, '')}/workbar` : ''
      const ttl = ((await $.settings.read()) as Record<string, unknown>).promptCacheTtl
      settingsTtl = ttl === '1h' || ttl === '5m' ? ttl : ''
    })
    if (opts.progressTool) {
      await step('progress tool', () =>
        $.tool.register({
          name: 'progress',
          description: PROGRESS_DESCRIPTION,
          inputSchema: {
            type: 'object',
            properties: {
              steps: { type: 'array', items: { type: 'string' } },
              estimate_minutes: { type: 'number' },
              done: { type: 'integer' },
            },
          },
          isDeferred: false,
        }),
      )
    }
    await step('/handoff', () =>
      $.command.register({ name: 'handoff', description: 'Write a handoff from this chat, start a fresh chat and put the handoff in the prompt box' }),
    )
    await step('/workbar', () => $.command.register({ name: 'workbar', description: 'Workbar: the task plan, agents and session health' }))
    if (opts.activityDir) {
      await step('activity folder', async () => {
        hasActivityDir = await $.fs
          .stat(opts.activityDir)
          .then(st => st.kind === 'dir')
          .catch(() => false)
      })
    }
    await step('refresh timer', async () => {
      $.clock.every(5000, async () => {
        await update($, tick, n => (n + 1) % 1_000_000)
        await syncSharedLimit($).catch(() => undefined)
        await syncStatus($)
      })
    })
    if (failed.length > 0) $.ui.log(`workbar: could not set up ${failed.join('; ')}`)
    return next(e)
  })

  // The progress bar only exists when Claude can report a plan; the band says so when the tool is missing.
  // Only the main conversation's prompt counts (a subagent's has no Agent tool).
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.tools.includes('Agent')) progressOffered = e.tools.includes(PROGRESS_TOOL)
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await markActivity($, 'idle', e.sessionId)
    if (e.reason === 'clear') {
      await update($, health, () => EMPTY_HEALTH)
      await update($, live, () => EMPTY_LIVE)
      await update($, hold, () => null)
      await update($, agents, () => [])
      await update($, asking, () => null)
      await update($, stuck, () => null)
      await update($, notice, () => null)
      await update($, chrome, () => null)
      tasks.clear()
      lastAdvised = 'ok'
      errStreak = { tool: '', count: 0 }
      permissionWaiting = false
      lastOkAt = 0
    }
    return next(e)
  })

  on('command.run', { command: 'workbar' }, async $ => {
    await $.ui.open({ id: TASKS_PANE, title: 'Workbar' })
    return { text: 'Opened.' }
  })

  // The pane: everything in full, where height is no problem (it scrolls on its own).
  on('ui.render', { component: 'Pane', requestId: TASKS_PANE }, async ($, e) => {
    await read($, tick)
    const l = await read($, live)
    const h = await read($, health)
    const ags = await read($, agents)
    const now = await $.clock.now()
    const calib = await calibration($)
    const ratios = ((await $.store.get(CALIB_KEY)) as number[] | undefined) ?? []
    const { Box, Text } = $.ui.resolve(e)
    const out: RenderChildren[] = []
    const head = (key: string, text: string) => (
      <Text key={key} bold>
        {out.length > 0 ? '\n' : ''}
        {text}
      </Text>
    )

    const p = l.plan
    if (!p || p.steps.length === 0) {
      out.push(
        <Text key="noplan" dimColor>
          {l.isWorking ? `${noPlanReason(l).long}.` : 'No plan for the last task. One shows when Claude works through several steps.'}
        </Text>,
      )
    } else {
      const left = timeLeft(p, now, calib, l.waitingSince)
      out.push(
        head(
          'plan-h',
          `Plan ${p.done}/${p.steps.length}  ·  ${fmtMin(activeMinutes(p, now, l.waitingSince))} of work${left ? `  ·  ${left}` : ''}${reportAge(l, now) ? `  ·  ${reportAge(l, now)}` : ''}${p.source === 'todos' ? '  ·  from Claude’s todo list' : ''}`,
        ),
      )
      p.steps.forEach((s, i) => {
        const began = i === 0 ? p.startedAt : p.doneAt[i - 1] ?? p.startedAt
        out.push(
          i < p.done ? (
            <Text key={`s${i}`} dimColor wrap="truncate-end">
              ✓ {s}  {i < (p.baseDone ?? 0) ? 'before the plan' : fmtDur((p.doneAt[i] ?? now) - began)}
            </Text>
          ) : i === p.done && l.isWorking ? (
            <Text key={`s${i}`} bold wrap="truncate-end">
              ▶ {s}  <Text dimColor>{fmtDur(now - began)} so far</Text>
            </Text>
          ) : (
            <Text key={`s${i}`} wrap="truncate-end">
              ○ {s}
            </Text>
          ),
        )
      })
      if (p.firstEstimateMin > 0) {
        out.push(
          <Text key="est" dimColor wrap="truncate-end">
            Claude’s estimate {fmtMin(p.firstEstimateMin)}, shown as {fmtMin(p.firstEstimateMin * calib)} (×{calib.toFixed(2)}
            {ratios.length >= 3 ? `, median of your last ${ratios.length} plans` : ', default until 3 plans finish'})
          </Text>,
        )
      }
    }

    if (ags.length > 0) {
      out.push(head('ag-h', `Agents  ·  ${ags.filter(a => a.status === 'running').length} running`))
      for (const a of ags) {
        const t = a.status === 'running' ? now - a.startedAt : a.endedAt - a.startedAt
        out.push(
          <Text key={`ag-${a.id}`} wrap="truncate-end">
            <Text color={a.status === 'running' ? 'claude' : a.status === 'done' ? 'success' : 'error'}>
              {a.status === 'running' ? '● ' : a.status === 'done' ? '✓ ' : '✗ '}
            </Text>
            {a.label}
            <Text dimColor>
              {' '}
              ({a.type}) · {plural(a.tools, 'tool')} · {fmtDur(t)}
              {a.lastAction ? ` · ${a.lastAction}` : ''}
            </Text>
          </Text>,
        )
      }
    }

    if (h.tokens > 0) {
      out.push(head('h-h', 'Session'))
      const cacheLeft = cacheTtlMs(h) - (now - h.lastResponseAt)
      out.push(
        <Text key="h-chat" wrap="truncate-end">
          chat {fmtK(h.tokens)} tokens  ·  cache {cacheLeft > 0 ? `warm for ${Math.ceil(cacheLeft / 60000)}m` : 'expired'} (
          {cacheTtlMs(h) / 60000}m lifetime){h.costUsd > 0 ? `  ·  $${h.costUsd.toFixed(2)} so far (list price)` : ''}
        </Text>,
      )
      for (const x of h.limits) {
        const full = paceFullAt(h.paceBases.find(b => b.kind === x.kind), x.pct, x.resetsAt, now)
        const reset = x.resetsAt ? new Date(x.resetsAt) : null
        out.push(
          <Text key={`lim-${x.kind}`} wrap="truncate-end">
            {limitLabel(x.kind)} limit {Math.round(x.pct)}%
            {reset && !isNaN(reset.getTime()) ? `  ·  resets ${hhmm(reset)}` : ''}
            {full ? <Text color="warning">  ·  at this pace full ≈{hhmm(new Date(full))}</Text> : ''}
          </Text>,
        )
      }
    }
    return <Box flexDirection="column">{out}</Box>
  })

  // Keep the usage windows current between turns too, including the moment a limit is hit.
  on('session.measure', async ($, e, next) => {
    const reading = e.context.tokens
    if (e.changed.includes('context') && typeof reading === 'number' && reading > 0) await update($, health, h => withReading(h, reading))
    if (e.changed.includes('rateLimits')) {
      const at = await $.clock.now()
      const limits = e.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt ?? '' }))
      await update($, health, h => ({ ...h, limits, paceBases: nextPaceBases(h.paceBases ?? [], limits, at) }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Any compaction of the main chat (the band's button, /compact, auto): shown while it runs, and its
  // result is the chat size until the next reply (Claude Code's own figure lags until then).
  on('session.compact', async ($, e, next) => {
    const isMain = e.trigger !== 'precompute' && e.agentId === undefined
    if (isMain) {
      const start = await $.clock.now()
      await update($, health, x => ({ ...x, compactStartedAt: x.compactStartedAt || start }))
      await syncStatus($)
    }
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } finally {
      if (isMain) await update($, health, x => ({ ...x, compactStartedAt: 0 }))
    }
    if (!isMain) return r
    try {
      const h = await read($, health)
      if ('skip' in r && r.skip) {
        await say($, compactSkipText(r.skip, justCompacted(h)), 'warning')
      } else {
        const at = await $.clock.now()
        const after = 'tokensAfter' in r && typeof r.tokensAfter === 'number' ? r.tokensAfter : 0
        const before = 'tokensBefore' in r && typeof r.tokensBefore === 'number' && r.tokensBefore > 0 ? r.tokensBefore : h.tokens
        await update($, health, x => ({
          ...x,
          tokens: after,
          allowedUntilTokens: 0,
          lastResponseAt: at,
          compactedAt: at,
          compactedFrom: before,
          compactedTo: after,
          promptsAtCompact: x.prompts,
        }))
        await update($, hold, () => null)
        lastAdvised = 'ok'
        const text = `Compacted ${before > 0 ? fmtK(before) : 'the chat'} → ${after ? fmtK(after) : 'small'}`
        await say($, `${text}. Compact again once the chat has grown.`)
        if (opts.band === 'off') $.ui.toast(text)
      }
      await syncStatus($)
    } catch {
      // the compaction itself is done; only the band's account of it is missing
    }
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'handoff' }, async $ => {
    void handOff($)
    return { text: 'Writing a handoff, then starting a fresh chat with it in the prompt box.' }
  })

  // Hold a message before it goes into a chat that is too big, cold, or about something else.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) {
      if (e.command.name === 'login') {
        const limited = (await read($, health)).limitNoticeAt > 0 || isSharedLimitOn(await readSharedLimit($), await $.clock.now(), lastOkAt)
        if (limited) await markLimit($, false) // a login here counts for every chat
      }
      return next(e)
    }
    if (e.isMeta) return next(e)
    if (e.turnId) {
      // Typed while a run is going: ask Claude to fold it into the visible plan.
      const l = await read($, live)
      return l.plan?.source === 'progress' ? next({ ...e, context: [...(e.context ?? []), MIDRUN_NOTE] }) : next(e)
    }
    const text = e.text
    const h = await read($, health)
    const held = await read($, hold)
    const now = await $.clock.now()

    // Second Enter on the same text sends it here anyway.
    const isRepeat = held !== null && held.text.trim() === text.trim()
    let reason = ''
    let isNewTask = false
    const agentsBusy = (await read($, agents)).some(a => a.status === 'running')
    const isFresh = justCompacted(h) || (h.compactStartedAt ?? 0) > 0 // nothing to gain from compacting again
    if (opts.holdMessages && !isRepeat && !agentsBusy && !isFresh && !isLimitHit(h, now) && h.tokens > h.allowedUntilTokens) {
      const lv = level(h, now)
      if (lv === 'cold') {
        reason = `cache expired, this would re-send all ${fmtK(h.tokens)} at full price`
      } else if (lv === 'red') {
        reason = `chat is ${fmtK(h.tokens)}, every message re-reads all of it`
      } else if (opts.topicCheck && h.tokens >= TOPIC_CHECK_TOKENS && text.length >= 60 && h.firstPrompt) {
        try {
          if (await isNewTopic($, h, text)) {
            reason = 'looks like a new task'
            isNewTask = true
          }
        } catch {
          // a failed check never blocks a message
        }
      }
    }

    if (reason) {
      await update($, hold, () => ({ text, reason, isNewTask }))
      void $.clock.after(30, () => {
        void $.prompt.fill({ text }).catch(() => undefined)
      })
      return { drop: `Held: ${reason}. ${isNewTask ? 'New task: Hand off.' : 'Same task: Compact and send.'} Or press Enter again to send it here anyway.` }
    }

    if (isRepeat) {
      await update($, health, x => ({ ...x, allowedUntilTokens: x.tokens + 100_000 }))
    }
    await update($, hold, () => null)
    const result = await next(e)
    if (!result.drop) {
      await update($, agents, list => (list.some(a => a.status !== 'running') ? list.filter(a => a.status === 'running') : list))
      await update($, notice, () => null)
      await update($, health, x => ({
        ...x,
        prompts: x.prompts + 1,
        firstPrompt: x.firstPrompt || text,
        recentPrompts: [...x.recentPrompts, text].slice(-2),
      }))
    }
    return result
  }).catch(($, e, next) => next(e))

  // Claude Code's own notice that the usage limit is reached (the transcript row, never read by the model).
  on('session.append', async ($, e, next) => {
    const r = await next(e)
    if (e.message.type === 'system' && e.agentId === undefined) {
      const content: unknown = e.message.content
      const text =
        typeof content === 'string'
          ? content
          : (Array.isArray(content) ? content : [])
              .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
              .join(' ')
      if (LIMIT_TEXT.test(text)) await markLimit($, true)
    }
    return r
  }).catch(($, e, next) => next(e))

  // The same when an API error ends the turn over a usage limit or billing.
  on('classic.StopFailure', async ($, e, next) => {
    const r = await next(e)
    if (e.error === 'billing_error' || (e.error === 'rate_limit' && LIMIT_TEXT.test(e.error_details ?? ''))) await markLimit($, true)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      mainTurnId = e.turnId
      // Logged in, or the limit reset: this chat tries again. If another chat's flag still stands, the
      // request pauses and asks; if this one fails again, the notice brings Log in back.
      if ((await read($, health)).limitNoticeAt) await markLimit($, false, 'here')
      errStreak = { tool: '', count: 0 }
      await update($, stuck, () => null)
      // An unfinished plan carries into this message ("continue", an answer to Claude's question), with
      // the time between the two messages left out of its working time. It goes if Claude does not update it.
      await update($, live, l => {
        const p = l.carryPlan && l.plan ? l.plan : null
        const gap = p && l.endedAt && l.endedAt >= p.startedAt ? Math.max(0, at - l.endedAt) : 0
        const plan = p ? { ...p, carried: true, waitMs: p.waitMs + gap } : null
        return { ...l, isWorking: true, startedAt: at, tools: 0, lastAction: '', plan, waitingSince: 0, carryPlan: false, nudged: false, reportedAt: 0, staleFrom: 0, staleNudges: 0 }
      })
      await markActivity($, 'busy')
      await syncStatus($)
    }
    return next(e)
  })

  // Every model request, main or subagent: paused while the account is at its usage limit (one
  // question for all of them), and a reply that arrives is the sign this chat is through it.
  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    if (isSharedLimitOn(await readSharedLimit($), sentAt, lastOkAt)) {
      pausing ??= askToContinue($).finally(() => {
        pausing = null
      })
      if ((await pausing) === 'stop') {
        await $.turn.abort({ turnId: mainTurnId || e.turnId }).catch(() => undefined)
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
      }
    }
    const r = yield* next(e)
    if (r.stopReason !== null && sentAt > lastOkAt) {
      lastOkAt = sentAt
      // Through the limit: tell the other chats, which may still show Log in or wait on a question.
      if (sharedLimit && sharedLimit.hitAt > sharedLimit.clearedAt && sharedLimit.hitAt < sentAt) await markLimit($, false)
    }
    return r
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const args = e as unknown as { steps?: unknown; estimate_minutes?: unknown; done?: unknown; agentId?: string }
    if (args.agentId !== undefined) {
      const id = args.agentId
      await update($, agents, list =>
        list.map(a => {
          if (a.id !== id) return a
          const steps = Array.isArray(args.steps) ? args.steps.length : a.plan?.steps ?? 0
          const done = typeof args.done === 'number' ? Math.max(0, Math.min(steps, Math.floor(args.done))) : a.plan?.done ?? 0
          return steps > 0 ? { ...a, plan: { steps, done } } : a
        }),
      )
      return { result: 'ok' }
    }
    const at = await $.clock.now()
    await update($, live, l => {
      const newSteps = Array.isArray(args.steps) ? args.steps.map(s => clip(String(s), 80)).filter(Boolean).slice(0, 20) : null
      // A plan carried from your last message continues only if this one is the same work.
      const isNewWork = !!l.plan?.carried && !!newSteps && !sharesStep(l.plan.steps, newSteps)
      const prev = l.plan?.source === 'progress' && !isNewWork ? l.plan : null
      const steps = newSteps ?? prev?.steps ?? []
      const est = typeof args.estimate_minutes === 'number' && args.estimate_minutes > 0 ? args.estimate_minutes : 0
      const done = typeof args.done === 'number' ? Math.max(0, Math.min(steps.length, Math.floor(args.done))) : prev?.done ?? 0
      // A plan that switches from the todo list keeps its start, so elapsed time stays honest.
      const base =
        prev ??
        (l.plan && !isNewWork ? { ...l.plan, done: 0, doneAt: [], doneActive: [], firstEstimateMin: 0, estimateMin: 0, baseDone: 0, estActive: 0, estDone: 0 } : null)
      return { ...l, plan: advancePlan(base, steps, est, done, at, 'progress'), reportedAt: at, staleFrom: l.tools }
    })
    await syncStatus($)
    return { result: 'ok' }
  }).catch(() => ({ result: 'ok' }))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const any = e as unknown as Record<string, unknown>
    const agentId = (e as { agentId?: string }).agentId
    // Workbar's own pause at the usage limit asks through AskUserQuestion too; it is not Claude's work.
    const isPause = pausing !== null && tool === 'AskUserQuestion'
    if (tool !== PROGRESS_TOOL && !isPause) {
      const target = String(any.file_path ?? any.path ?? any.command ?? any.pattern ?? any.url ?? '')
      const name = tool.replace(/^mcp__([^_]+)__/, '$1:')
      const file = target.split(/[\\/]/).pop() ?? ''
      const action = clip(`${name} ${any.file_path || any.path ? file : target}`, 60)
      if (agentId === undefined) await update($, live, l => ({ ...l, tools: l.tools + 1, lastAction: action }))
      else await update($, agents, list => list.map(a => (a.id === agentId ? { ...a, tools: a.tools + 1, lastAction: action } : a)))
    }
    // A tool call starting means any permission prompt before it has been answered.
    if (permissionWaiting) await endWait($)
    const question = isPause ? PAUSED : agentId === undefined ? QUESTION_TOOLS[tool] : undefined
    if (question) {
      await update($, asking, () => question)
      await beginWait($, await $.clock.now())
      await syncStatus($)
      $.clock.after(ASK_ALERT_MS, async () => {
        if ((await read($, asking)) === question) await alert($, question)
      })
    }
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      if (question || permissionWaiting) await endWait($)
      if (question) {
        await update($, asking, () => null)
        await syncStatus($)
      }
    }

    if (agentId === undefined && tool !== PROGRESS_TOOL && !isPause) {
      // Claude's own todo list stands in for a plan when it has not reported one.
      if (tool === 'TodoWrite' && !ran.isError && Array.isArray(any.todos)) {
        const at = await $.clock.now()
        await update($, live, l =>
          l.plan?.source === 'progress' && !l.plan.carried ? l : { ...l, plan: planFromTodos(l.plan?.source === 'todos' ? l.plan : null, any.todos as { content: string; status: string }[], at) },
        )
        await syncStatus($)
      }
      // Or its task list, the newer kind.
      if ((tool === 'TaskCreate' || tool === 'TaskUpdate') && !ran.isError && ran.deny === undefined && trackTask(tool, any, ran.result)) {
        const at = await $.clock.now()
        await update($, live, l =>
          l.plan?.source === 'progress' && !l.plan.carried ? l : { ...l, plan: planFromTasks(l.plan?.source === 'todos' ? l.plan : null, at) },
        )
        await syncStatus($)
      }
      // Several failures in a row: worth a look before more go the same way. A refusal by you is not one.
      if (ran.isError && ran.deny === undefined) {
        errStreak = errStreak.tool === tool ? { tool, count: errStreak.count + 1 } : { tool, count: 1 }
        if (errStreak.count >= STUCK_AFTER) {
          await update($, stuck, () => ({ tool: tool.replace(/^mcp__([^_]+)__/, '$1:'), count: errStreak.count }))
          await syncStatus($)
        }
      } else if (!ran.isError && errStreak.count > 0) {
        errStreak = { tool: '', count: 0 }
        if (await read($, stuck)) {
          await update($, stuck, () => null)
          await syncStatus($)
        }
      }
    }

    if (ran.deny !== undefined) return ran
    let out = ran
    // A task past a quick answer with no plan on screen: ask Claude for one, once per message.
    if (agentId === undefined && tool !== PROGRESS_TOOL && !question && opts.progressTool && progressOffered !== false) {
      const l = await read($, live)
      const p = l.plan
      const now = await $.clock.now()
      if (l.isWorking && !l.nudged && l.tools > QUICK_TOOLS && (!p || p.carried)) {
        await update($, live, x => ({ ...x, nudged: true }))
        out = { ...ran, context: [...(ran.context ?? []), p ? NUDGE_CARRIED_NOTE : NUDGE_NOTE] }
      } else if (
        // A plan the work has run ahead of: remind Claude to report the steps it has finished.
        l.isWorking &&
        p?.source === 'progress' &&
        !p.carried &&
        p.done < p.steps.length &&
        (l.staleNudges ?? 0) < STALE_NUDGES &&
        l.tools - (l.staleFrom ?? 0) >= STALE_TOOLS &&
        now - (l.reportedAt ?? now) >= STALE_MS
      ) {
        await update($, live, x => ({ ...x, staleFrom: x.tools, staleNudges: (x.staleNudges ?? 0) + 1 }))
        out = { ...ran, context: [...(ran.context ?? []), staleNote(p)] }
      }
    }

    // Browser extension dropped: show how to reconnect, and keep Claude from giving up on the browser step.
    if (!tool.startsWith(CHROME_PREFIX)) return out
    const text = typeof ran.text === 'string' ? ran.text : ''
    if (ran.isError && CHROME_DOWN.test(text)) {
      const was = await read($, chrome)
      await update($, chrome, () => ({ message: clip(text, 160) }))
      if (!was) {
        $.ui.toast('Chrome extension not connected: run /chrome and pick Reconnect extension.')
        void alert($, 'Chrome extension disconnected. In Claude Code run /chrome, then Reconnect extension.')
      }
      return { ...out, context: [...(out.context ?? []), CHROME_NOTE] }
    }
    if (!ran.isError) await update($, chrome, () => null)
    return out
  }).catch(($, e, next) => next(e))

  // Claude Code's own "needs you" moments (a permission dialog, an MCP form).
  on('classic.Notification', async ($, e, next) => {
    const r = await next(e)
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog') {
      if ((await read($, live)).isWorking) {
        permissionWaiting = true
        await beginWait($, await $.clock.now())
      }
      void alert($, e.message || 'Claude needs your approval')
    }
    return r
  }).catch(($, e, next) => next(e))

  // Subagents: one row each in the band, from start to finish, so it is clear what the chat is waiting on.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = 'agentId' in r ? r.agentId : undefined
    if (id) {
      try {
        const at = await $.clock.now()
        const run: AgentRun = {
          id,
          label: clip(e.description || e.name || e.subagentType, 48),
          type: e.fork ? 'fork' : e.subagentType,
          startedAt: at,
          endedAt: 0,
          tools: 0,
          lastAction: '',
          status: 'running',
          plan: null,
        }
        await update($, agents, list => [...list.filter(a => a.id !== id), run].slice(-24))
        await syncStatus($)
      } catch {
        // tracking is best effort; the spawn already happened
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const at = await $.clock.now()
    if (e.agentId !== undefined) {
      const id = e.agentId
      await update($, agents, list => list.map((a): AgentRun => (a.id === id ? { ...a, status: e.isAborted ? 'stopped' : 'done', endedAt: at } : a)))
      await syncStatus($)
      return next(e)
    }
    await endWait($)
    const l = await read($, live)
    const seconds = Math.round((at - l.startedAt) / 1000)
    // Claude is told the last step needs no report, so a run that ends one step short has finished it.
    const isLastOpen = !!l.plan && !e.isAborted && l.plan.source === 'progress' && !l.plan.carried && l.plan.done === l.plan.steps.length - 1
    const plan = l.plan && isLastOpen ? advancePlan(l.plan, l.plan.steps, 0, l.plan.steps.length, at, 'progress') : l.plan
    let sampled = plan?.sampled ?? false
    if (plan && !e.isAborted && plan.source === 'progress' && !plan.sampled && !plan.carried) {
      const sample = calibrationSample(plan, activeMinutes(plan, at, 0))
      if (sample !== null) {
        const ratios = ((await $.store.get(CALIB_KEY)) as number[] | undefined) ?? []
        await $.store.set(CALIB_KEY, [...ratios, sample].slice(-20))
        sampled = true
      }
    }
    // Unfinished and updated in this message: your next message continues it.
    const carry = !!plan && plan.done < plan.steps.length && !plan.carried
    await update($, live, x => ({
      ...x,
      isWorking: false,
      waitingSince: 0,
      plan: plan ? { ...plan, sampled } : plan,
      carryPlan: carry,
      endedAt: at,
      lastRun: { seconds, estimateMin: plan?.firstEstimateMin || null, steps: plan?.steps.length ?? 0, done: plan?.done ?? 0, tools: x.tools },
    }))
    await refreshTokens($)
    await markActivity($, 'idle')
    const hNow = await read($, health)
    const lvNow = level(hNow, at)
    if (LEVEL_RANK[lvNow] > LEVEL_RANK[lastAdvised]) {
      $.ui.toast(
        lvNow === 'amber'
          ? `This chat is ${fmtK(hNow.tokens)}. Finish this task here; for the next one press Compact (same task) or Hand off (new task).`
          : `This chat is ${fmtK(hNow.tokens)}. Before your next message: Compact if it continues this task, Hand off if it is a new one.`,
      )
    }
    lastAdvised = lvNow
    await syncStatus($)
    if (seconds >= NOTIFY_AFTER_S && !e.isAborted) await alert($, `Finished in ${fmtDur(seconds * 1000)}`)
    return next(e)
  })

  // The band: one framed panel that always fits its row budget. Frame colour and badge give the state
  // from across the room; ★ marks the recommended action. Claude Code's own [-] beside it folds it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || opts.band === 'off') return next(e)
    await read($, tick)
    // A question or plan dialog needs the room more; the status line says Claude is asking.
    if (await read($, asking)) return next(e)
    const l = await read($, live)
    const hs = await read($, health)
    const held = await read($, hold)
    const cx = await read($, chrome)
    const st = await read($, stuck)
    const ags = await read($, agents)
    const nt = await read($, notice)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)

    const running = ags.filter(a => a.status === 'running')
    const lv: Level = hs.tokens > 0 ? level(hs, now) : 'ok'
    const compacting = (hs.compactStartedAt ?? 0) > 0
    const note = nt && now < nt.until ? nt : null
    // While subagents run, the chat is not free: compacting or handing off now would lose their results.
    const isFree = !l.isWorking && running.length === 0
    // At the limit Compact and Hand off would fail too: offer only Log in.
    const limitHit = !l.isWorking && isLimitHit(hs, now)
    const chatAlert = lv !== 'ok' && isFree && !limitHit && !compacting
    const isRed = lv === 'red' || lv === 'cold'
    const plan = l.isWorking && l.plan && l.plan.steps.length > 0 ? l.plan : null

    // While Claude works the band always shows: the plan, or one line saying why there is none.
    if (!l.isWorking) {
      const worthIt = held || cx || limitHit || chatAlert || ags.length > 0 || compacting || note
      if (!worthIt && opts.band !== 'always') return next(e)
    }

    const cols = Math.max(20, e.props.bodyColumns ?? 80)
    const inner = Math.max(16, cols - 4) // inside the border and padding
    const narrow = inner < 60
    const room = bandBudget(e.props.maxRows, e.viewport?.rows, e.viewport?.isFullscreen) - 2 // less the border

    const state = l.isWorking
      ? { label: '', color: st ? 'warning' : 'claude' }
      : running.length > 0 || compacting
        ? { label: 'WAITING', color: 'claude' }
        : held || cx || limitHit || (chatAlert && isRed)
          ? { label: 'ACTION', color: cx || isRed || limitHit ? 'error' : 'warning' }
          : { label: 'READY', color: 'success' }

    // Each row is one line (texts truncate, never wrap) unless its row count is stated.
    type Row = { prio: number; rows: number; el: RenderChildren }
    const rows: Row[] = []
    const add = (prio: number, el: RenderChildren, n = 1) => rows.push({ prio, rows: n, el })

    // ---- chat size gauge, cache, usage windows that matter, last run ----
    const lvColor = lv === 'ok' ? 'success' : lv === 'amber' ? 'warning' : 'error'
    const gaugeW = narrow ? 6 : 10
    const gaugeFill = Math.min(gaugeW, Math.max(1, Math.round((hs.tokens / opts.redTokens) * gaugeW)))
    const cacheLeft = hs.lastResponseAt > 0 ? cacheTtlMs(hs) - (now - hs.lastResponseAt) : 0
    const cache = l.isWorking || hs.lastResponseAt === 0 ? '' : cacheLeft > 0 ? `cache ✓ ${Math.ceil(cacheLeft / 60000)}m` : 'cache ✗'
    const limits = hs.limits
      .filter(x => x.pct >= 50 && x.pct < 100)
      .map(x => {
        const full = paceFullAt(hs.paceBases.find(b => b.kind === x.kind), x.pct, x.resetsAt, now)
        const at = x.resetsAt ? new Date(x.resetsAt) : null
        const when = full ? ` full ≈${hhmm(new Date(full))}` : at && !isNaN(at.getTime()) && x.pct >= 80 ? ` → ${hhmm(at)}` : ''
        return { text: `${limitLabel(x.kind)} ${Math.round(x.pct)}%${when}`, hot: x.pct >= 80 || !!full }
      })
    const lr = l.lastRun
    const recap =
      !l.isWorking && lr && lr.seconds >= 60 && !narrow
        ? `  last ${fmtDur(lr.seconds * 1000)} · ${plural(lr.tools, 'tool')}${lr.steps === 0 && lr.tools > QUICK_TOOLS ? ' · no plan' : ''}`
        : ''
    const chatBits =
      hs.tokens > 0 ? (
        <Text key="chat" wrap="truncate-end">
          <Text dimColor>chat </Text>
          <Text color={lvColor} bold>
            {fmtK(hs.tokens)}{' '}
          </Text>
          <Text color={lvColor}>{'━'.repeat(gaugeFill)}</Text>
          <Text dimColor>{'─'.repeat(gaugeW - gaugeFill)}</Text>
          <Text dimColor>{cache ? `  ${cache}` : ''}</Text>
          {limits.map((x, i) => (
            <Text key={`lim${i}`} color={x.hot ? 'warning' : undefined} dimColor={!x.hot}>
              {'  '}
              {x.text}
            </Text>
          ))}
          <Text dimColor>{recap}</Text>
        </Text>
      ) : (
        <Text key="chat" dimColor wrap="truncate-end">
          {hs.compactedAt
            ? `${compactedLine(hs)} · the size shows after the next reply`
            : narrow
              ? 'New chat'
              : 'New chat · a progress bar shows when Claude works through several steps'}
        </Text>
      )
    const badge = (
      <Text backgroundColor={state.color} color="inverseText" bold>
        {' '}
        {state.label}{' '}
      </Text>
    )

    // ---- while Claude works: the plan's bar, % and time left ----
    let stepsCompactAt = -1
    if (plan) {
      const n = plan.steps.length
      const pct = plan.done / n
      const left = timeLeft(plan, now, await calibration($), l.waitingSince)
      const mins = minutesLeft(plan, now, await calibration($), l.waitingSince)
      const eta = mins && mins > 0 && !narrow ? ` · ≈${hhmm(new Date(now + mins * 60000))}` : ''
      const age = narrow ? '' : reportAge(l, now)
      const tail = `${left ? `  ${left}${eta}` : ''}${age ? ` · ${age}` : ''}`
      const barW = Math.max(6, Math.min(40, inner - 6 - tail.length))
      const filled = Math.round(pct * barW)
      add(
        6,
        <Text key="bar" wrap="truncate-end">
          <Text color="claude">{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(barW - filled)}</Text>
          <Text bold> {String(Math.round(pct * 100)).padStart(3, ' ')}%</Text>
          <Text dimColor>{tail}</Text>
          <Text dimColor>{plan.carried && !narrow ? '  · plan from your last message' : ''}</Text>
        </Text>,
      )
      // At least one line of steps by name: the finished ones counted, then the current one and as
      // many of the rest as the width allows. Replaced by the full list below whenever it fits.
      const cur = Math.min(plan.done, n - 1)
      stepsCompactAt = rows.length
      add(
        5,
        plan.done >= n ? (
          <Text key="steps" color="success" wrap="truncate-end">
            ✓ All {n} steps done <Text dimColor>· finishing up</Text>
          </Text>
        ) : (
          <Text key="steps" wrap="truncate-end">
            {plan.done > 0 ? <Text color="success">✓ {plan.done} done   </Text> : ''}
            <Text color="claude" bold>
              ▶ {plan.steps[cur] ?? ''}
            </Text>
            {plan.steps.slice(cur + 1).map((s, i) => (
              <Text key={`n${i}`} dimColor>
                {'   '}○ {s}
              </Text>
            ))}
          </Text>
        ),
      )
    } else if (l.isWorking) {
      // ---- working with no plan: say why there is no bar ----
      add(
        6,
        <Text key="noplan" wrap="truncate-end">
          <Text color="claude">○ </Text>
          {noPlanReason(l).long}
          <Text dimColor>
            {l.tools > 0 ? `  ·  ${plural(l.tools, 'tool')}` : ''}
            {l.lastAction && !narrow ? `  ·  ${l.lastAction}` : ''}
          </Text>
        </Text>,
      )
    } else {
      // ---- between turns: badge, then the chat, or the agents still running ----
      add(
        6,
        <Box key="head" flexDirection="row">
          {badge}
          <Text> </Text>
          {running.length > 0 ? (
            <Text wrap="truncate-end" bold>
              {plural(running.length, 'agent')} still running
              <Text dimColor bold={false}>
                {narrow ? '' : ' · Claude picks up when they finish'}
                {hs.tokens > 0 ? `  ·  chat ${fmtK(hs.tokens)}` : ''}
              </Text>
            </Text>
          ) : (
            chatBits
          )}
        </Box>,
      )
    }

    if (st && l.isWorking) {
      add(
        7,
        <Text key="stuck" color="warning" wrap="truncate-end">
          ▲ {st.count} failed {st.tool} calls in a row. <Text dimColor>Claude may be going in circles: Esc stops it so you can steer.</Text>
        </Text>,
      )
    }

    if (compacting) {
      add(
        8,
        <Text key="compacting" wrap="truncate-end">
          <Text color="claude">◐ </Text>
          Compacting the chat · {fmtDur(now - (hs.compactStartedAt ?? now))} so far
          <Text dimColor>{narrow ? '' : '. The size updates when it finishes.'}</Text>
        </Text>,
      )
    }
    if (note && !compacting) {
      add(
        7,
        <Text key="notice" wrap="truncate-end" color={note.tone === 'warning' ? 'warning' : undefined} dimColor={note.tone === 'info'}>
          {note.tone === 'warning' ? '▲ ' : '✓ '}
          {note.text}
        </Text>,
      )
    }

    // ---- what needs you; ★ marks the recommended action ----
    const choice = (key: string, label: string, hint: string, hotkey: string, isRec: boolean, onPress: () => unknown) => (
      <Box key={`ch-${key}`} flexDirection="row">
        <Button key={key} hotkey={hotkey} variant={isRec ? 'primary' : undefined} label={isRec ? `★ ${label}` : label} onPress={onPress} />
        {narrow ? '' : <Text dimColor> {hint}</Text>}
      </Box>
    )
    const choices = (items: RenderChildren[]) => (
      <Box key="choices" flexDirection="row" columnGap={narrow ? 1 : 3}>
        {items}
      </Box>
    )
    const taskOpen = lr ? lr.steps > 0 && lr.done < lr.steps : false
    const recommendHandoff = recommendsHandoff(l, held) && !taskOpen

    if (limitHit && hs.limitFromOther) {
      add(
        8,
        <Text key="limit-msg" color="error" wrap="truncate-end">
          ▲ Usage limit reached in another chat. <Text dimColor>A login in any chat counts for all of them.</Text>
        </Text>,
      )
    }
    if (l.isWorking && hs.limitNoticeAt) {
      add(
        8,
        <Text key="limit-msg" color="error" wrap="truncate-end">
          ▲ Usage limit reached. <Text dimColor>This chat pauses before its next request and asks you to log in.</Text>
        </Text>,
      )
    }
    if (limitHit) {
      add(
        10,
        choices([
          choice('login', 'Log in', 'switch account', 'l', true, async () => {
            await markLimit($, false)
            await $.command.run({ command: 'login' }).catch(() => undefined)
          }),
        ]),
      )
    }

    if (cx) {
      add(
        8,
        <Text key="cx-msg" color="error" wrap="truncate-end">
          ▲ Chrome extension disconnected. <Text dimColor>Switched accounts? Sign the extension in to the same one (/status shows it).</Text>
        </Text>,
      )
      if (!l.isWorking) add(9, choices([choice('chrome', 'Reconnect', '/chrome', 'r', true, () => void $.command.run({ command: 'chrome' }).catch(() => undefined))]))
    }

    if (held && !limitHit) {
      add(
        8,
        <Text key="hold-msg" color="warning" wrap="truncate-end">
          ‖ Held: {held.reason}. <Text dimColor>Enter again sends it here.</Text>
        </Text>,
      )
      const compactC = choice('compact-send', 'Compact & send', 'same task', 'c', !held.isNewTask, () => compactNow($, held.text))
      const handoffC = choice('handoff-task', 'Hand off', 'new task', 'h', held.isNewTask, () => handOff($, held.text))
      add(9, choices(held.isNewTask ? [handoffC, compactC] : [compactC, handoffC]))
    } else if (chatAlert) {
      if (isRed) {
        add(
          8,
          <Text key="alert-msg" color="error" wrap="truncate-end">
            ▲{' '}
            {lv === 'cold'
              ? `Cache expired: your next message re-sends all ${fmtK(hs.tokens)} at full price.`
              : `Long chat: every message re-reads all ${fmtK(hs.tokens)}, and focus drops.`}
          </Text>,
        )
      }
      const compactC = choice('compact', hs.isCompacting ? 'Compacting…' : 'Compact', 'same task', 'c', !recommendHandoff, () => compactNow($))
      const handoffC = choice('handoff', hs.isHandingOff ? 'Writing…' : 'Hand off', 'new task', 'h', recommendHandoff, () => handOff($))
      add(9, choices(recommendHandoff ? [handoffC, compactC] : [compactC, handoffC]))
    }

    // ---- fill what is left: every step by name first, then agents ----
    let used = rows.reduce((s, r) => s + r.rows, 0)
    const spare = () => Math.max(0, room - used)

    // The full step list replaces the one-line view when it fits, with names as long as the room
    // allows. Running agents keep one row for their summary; finished ones give way.
    if (plan && stepsCompactAt >= 0 && plan.done < plan.steps.length) {
      const reserve = running.length > 0 ? 1 : 0
      for (const width of [48, 28, 18]) {
        const chips = plan.steps.map(s => clip(s, width))
        const need = wrappedRows(chips.reduce((s, c) => s + c.length + 5, 0), inner)
        if (need - 1 > spare() - reserve) continue
        rows[stepsCompactAt] = {
          prio: 5,
          rows: need,
          el: (
            <Text key="steps" wrap="wrap">
              {chips.map((step, i) =>
                i < plan.done ? (
                  <Text key={`c${i}`} color="success">
                    ✓ <Text dimColor>{step}</Text>
                    {'   '}
                  </Text>
                ) : i === plan.done ? (
                  <Text key={`c${i}`} color="claude" bold>
                    ▶ {step}
                    {'   '}
                  </Text>
                ) : (
                  <Text key={`c${i}`} dimColor>
                    ○ {step}
                    {'   '}
                  </Text>
                ),
              )}
            </Text>
          ),
        }
        used += need - 1
        break
      }
    }

    const agentRows: Row[] = []
    if (ags.length > 0) {
      const ordered = [...running, ...ags.filter(a => a.status !== 'running')]
      // Running agents get at least one row: a summary when there is no room for each.
      const avail = Math.max(running.length > 0 ? 1 : 0, spare())
      const fits = ordered.length <= avail
      const shown = fits ? ordered : ordered.slice(0, Math.max(0, avail - 1))
      for (const a of shown) {
        const kind = a.type && a.type !== 'general-purpose' && a.type !== a.label ? ` (${clip(a.type.replace(/^[^:]+:/, ''), 22)})` : ''
        if (a.status === 'running') {
          const step = a.plan ? ` · step ${Math.min(a.plan.done + 1, a.plan.steps)}/${a.plan.steps}` : ''
          agentRows.push({
            prio: 4,
            rows: 1,
            el: (
              <Text key={`ag-${a.id}`} wrap="truncate-end">
                <Text color="claude">● </Text>
                <Text bold>{a.label}</Text>
                <Text dimColor>
                  {kind}
                  {step} · {plural(a.tools, 'tool')} · {fmtDur(now - a.startedAt)}
                  {a.lastAction && !narrow ? ` · ${a.lastAction}` : ''}
                </Text>
              </Text>
            ),
          })
        } else {
          agentRows.push({
            prio: 2,
            rows: 1,
            el: (
              <Text key={`ag-${a.id}`} wrap="truncate-end">
                <Text color={a.status === 'done' ? 'success' : 'error'}>{a.status === 'done' ? '✓ ' : '✗ '}</Text>
                <Text dimColor>
                  {a.label}
                  {kind} · {a.status === 'done' ? '' : 'stopped after '}
                  {fmtDur(a.endedAt - a.startedAt)}
                </Text>
              </Text>
            ),
          })
        }
      }
      if (!fits) {
        const hidden = ordered.length - shown.length
        const hiddenRunning = Math.max(0, running.length - shown.filter(a => a.status === 'running').length)
        agentRows.push({
          prio: 4,
          rows: 1,
          el: (
            <Text key="ag-more" wrap="truncate-end">
              <Text color="claude">{hiddenRunning > 0 ? '● ' : '  '}</Text>
              <Text dimColor>
                {shown.length > 0 ? `+${hidden} more` : `${plural(running.length, 'agent')} running`}
                {hiddenRunning > 0 && shown.length > 0 ? ` (${hiddenRunning} running)` : ''} · /workbar shows all
              </Text>
            </Text>
          ),
        })
      }
      used += agentRows.length
    }

    // Order on screen: header or plan, warnings, agents, actions last (nearest the prompt).
    const actions = rows.filter(r => r.prio >= 9)
    const kept = fitRows([...rows.filter(r => r.prio < 9), ...agentRows, ...actions], room)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={state.color} paddingX={1} width={cols}>
        {kept}
      </Box>
    )
  })
}
