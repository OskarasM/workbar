import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AgentRun, ChromeIssue, FileTouch, Health, Hold, Live, Plan, Stuck } from '../types'
import {
  absPath,
  activeMinutes,
  bandBudget,
  calibrationFrom,
  calibrationSample,
  clip,
  deleteTargets,
  fitRows,
  fmtDur,
  fmtK,
  fmtMin,
  hhmm,
  limitLabel,
  minutesLeft,
  nextPaceBases,
  paceFullAt,
  plural,
  wrappedRows,
} from './lib'

// ---- options (Claude Code's /config, under workbar) ----
type Opts = {
  band: 'auto' | 'always' | 'off'
  progressTool: boolean
  holdMessages: boolean
  topicCheck: boolean
  amberTokens: number
  redTokens: number
  cacheTtl: 'auto' | '5m' | '1h'
  notify: boolean
  notifyAfterSeconds: number
  pushUrl: string
  activityDir: string
}
function readOpts(raw: unknown): Opts {
  const o = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const amber = num(o.amberTokens, 150_000)
  return {
    band: o.band === 'always' || o.band === 'off' ? o.band : 'auto',
    progressTool: o.progressTool !== false,
    holdMessages: o.holdMessages !== false,
    topicCheck: o.topicCheck === true,
    amberTokens: amber,
    redTokens: Math.max(amber + 1, num(o.redTokens, 300_000)),
    cacheTtl: o.cacheTtl === '5m' || o.cacheTtl === '1h' ? o.cacheTtl : 'auto',
    notify: o.notify !== false,
    notifyAfterSeconds: num(o.notifyAfterSeconds, 120),
    pushUrl: /^https?:\/\//i.test(str(o.pushUrl)) ? str(o.pushUrl) : '',
    activityDir: str(o.activityDir),
  }
}
let opts = readOpts(undefined)

const COLD_HOLD_TOKENS = 100_000 // with the cache expired, hold messages above this size
const TOPIC_CHECK_TOKENS = 60_000
const ASK_ALERT_MS = 15_000 // alert when a question from Claude waits this long
const STUCK_AFTER = 3 // failed tool calls in a row

// One description, read by Claude with the tool list; nothing goes into CLAUDE.md or the system prompt.
const PROGRESS_TOOL = 'mcp__workbar__progress'
const PROGRESS_DESCRIPTION =
  "Live progress bar for the user. For a task needing more than ~3 tool calls, call it first with `steps` (3-10 short labels) and `estimate_minutes`: your own wall-clock time to finish, usually minutes, not the hours a person would take. After each step, put `done` (steps finished) in the same response as your next tool call, never alone. If the plan changes, resend the full `steps` and a new estimate. Skip it for quick answers."
const MIDRUN_NOTE = 'If this changes the work, resend mcp__workbar__progress with the full updated `steps` and estimate alongside your next tool call.'
const TASKS_PANE = 'workbar-tasks'
const CHROME_PREFIX = 'mcp__claude-in-chrome__'
const CHROME_DOWN = /not connected|receiving end does not exist|not detected|no browser (is )?connected/i
const CHROME_NOTE =
  'The user has been shown how to reconnect the Chrome extension (/chrome, then Reconnect extension). Do not switch approach or drop the browser step: say in one line what you need the browser for, then wait for the user to say it is reconnected, and retry.'

const EMPTY_LIVE: Live = { isWorking: false, startedAt: 0, tools: 0, lastAction: '', plan: null, waitingSince: 0, lastRun: null }
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
}

const live = atom({ plugin: 'workbar', key: 'live' } as const, EMPTY_LIVE)
const health = atom({ plugin: 'workbar', key: 'health' } as const, EMPTY_HEALTH)
const hold = atom({ plugin: 'workbar', key: 'hold' } as const, null as Hold)
const tick = atom({ plugin: 'workbar', key: 'tick' } as const, 0)
const chrome = atom({ plugin: 'workbar', key: 'chrome' } as const, null as ChromeIssue)
const stuck = atom({ plugin: 'workbar', key: 'stuck' } as const, null as Stuck)
const agents = atom({ plugin: 'workbar', key: 'agents' } as const, [] as AgentRun[])
const files = atom({ plugin: 'workbar', key: 'files' } as const, [] as FileTouch[])
const filesOpen = atom({ plugin: 'workbar', key: 'filesOpen' } as const, false)
const asking = atom({ plugin: 'workbar', key: 'asking' } as const, null as string | null)

// Facts about this machine and session, read once at session start.
let sessionCwd = ''
let home = ''
let isWindows = false
let settingsTtl: '5m' | '1h' | '' = ''
let hasActivityDir = false
let errStreak = { tool: '', count: 0 }
const SESSION_TAG = crypto.randomUUID()

// ---- activity markers for your own scripts ----
async function markActivity($: EngineInterface, state: 'busy' | 'idle') {
  if (!hasActivityDir) return
  try {
    await $.fs.write(`${opts.activityDir.replace(/[\\/]+$/, '')}/${SESSION_TAG}.txt`, `${state} ${await $.clock.now()}`)
  } catch {
    // a script reading these falls back to its own timeout
  }
}

// ---- alerts: desktop (Windows toast, or the terminal's own channel) and optional phone push ----
// Windows Terminal has no notification channel Claude Code can use ($.ui.notify only rings the bell
// there), so on Windows pop-ups go through Windows itself. Title and text travel in the environment.
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
  if (!opts.notify && !opts.pushUrl) return
  const at = await $.clock.now()
  if (at - lastAlertAt < 5000) return // one alert for one moment
  lastAlertAt = at
  const jobs: Promise<unknown>[] = []
  if (opts.notify) {
    jobs.push(
      isWindows
        ? $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', TOAST_PS], {
            env: { WB_TITLE: 'Claude Code', WB_TEXT: text },
            timeoutMs: 15000,
          })
        : $.ui.notify(text, { title: 'Claude Code' }),
    )
  }
  if (opts.pushUrl) jobs.push($.http.fetch(opts.pushUrl, { method: 'POST', body: text, headers: { Title: 'Claude Code', Tags: 'robot' } }))
  await Promise.allSettled(jobs) // a missed alert is not worth failing anything for
}

// ---- files touched since your last message ----
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
type FileOp = { path: string; kind: 'edit' | 'delete'; existed: boolean }
const toAbs = (raw: string) => absPath(raw, sessionCwd, home, isWindows)

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    await $.fs.stat(path)
    return true
  } catch {
    return false
  }
}

async function filesBefore($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<FileOp[]> {
  if (EDIT_TOOLS.has(tool)) {
    const raw = String(args.file_path ?? args.notebook_path ?? '')
    if (!raw) return []
    const path = toAbs(raw)
    return [{ path, kind: 'edit', existed: await exists($, path) }]
  }
  if (SHELL_TOOLS.has(tool) && typeof args.command === 'string') {
    const ops: FileOp[] = []
    for (const path of deleteTargets(args.command).map(toAbs)) if (await exists($, path)) ops.push({ path, kind: 'delete', existed: true })
    return ops
  }
  return []
}

function mergeFiles(list: FileTouch[], changes: FileTouch[]): FileTouch[] {
  const key = (p: string) => (isWindows ? p.toLowerCase() : p)
  const map = new Map(list.map(f => [key(f.path), f] as const))
  for (const c of changes) {
    const k = key(c.path)
    const prev = map.get(k)
    if (!prev) map.set(k, c)
    else if (c.kind === 'removed') {
      if (prev.kind === 'added') map.delete(k) // made and deleted within the task: nothing to show
      else map.set(k, c)
    } else if (prev.kind === 'removed') map.set(k, { path: c.path, kind: 'changed' })
  }
  return [...map.values()].slice(-300)
}

async function filesAfter($: EngineInterface, ops: FileOp[], isOk: boolean) {
  const changes: FileTouch[] = []
  for (const op of ops) {
    if (op.kind === 'edit') {
      if (isOk) changes.push({ path: op.path, kind: op.existed ? 'changed' : 'added' })
    } else if (!(await exists($, op.path))) changes.push({ path: op.path, kind: 'removed' })
  }
  if (changes.length > 0) await update($, files, list => mergeFiles(list, changes))
}

const FILE_MARK: Record<FileTouch['kind'], { sign: string; color: string; order: number }> = {
  added: { sign: '+', color: 'success', order: 0 },
  changed: { sign: '~', color: 'warning', order: 1 },
  removed: { sign: '−', color: 'error', order: 2 },
}
const fileSummary = (list: FileTouch[]) =>
  (['changed', 'added', 'removed'] as const)
    .map(k => [k, list.filter(f => f.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(' · ')
const sortFiles = (list: FileTouch[]) => [...list].sort((a, b) => FILE_MARK[a.kind].order - FILE_MARK[b.kind].order)

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

async function calibration($: EngineInterface): Promise<number> {
  return calibrationFrom((await $.store.get('calib')) as number[] | undefined)
}

const cacheTtlMs = (h: Health) => {
  const ttl = opts.cacheTtl !== 'auto' ? opts.cacheTtl : settingsTtl || (h.limits.length > 0 ? '1h' : '5m')
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

// A usage window used up and not yet reset: Claude Code says so itself; the band only adds a way to switch account.
const isLimitHit = (h: Health, now: number) => h.limits.some(x => x.pct >= 100 && (!x.resetsAt || !(Date.parse(x.resetsAt) <= now)))

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
    else if (!l.isWorking && isLimitHit(h, now)) text = '★ Log in to continue'
    else if (l.isWorking && st) text = `▲ ${st.count} failed ${st.tool} calls in a row${agentsTxt}`
    else if (l.isWorking && l.plan && l.plan.steps.length > 0) {
      const p = l.plan
      const left = timeLeft(p, now, await calibration($), l.waitingSince)
      text = `▶ ${p.done}/${p.steps.length}${left ? ` · ${left}` : ''}${agentsTxt}`
    } else if (running > 0) text = `● ${plural(running, 'agent')} running`
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

async function refreshTokens($: EngineInterface) {
  try {
    const usage = await $.session.usage()
    const tokens = usage.context.tokens ?? 0
    const at = await $.clock.now()
    const limits = usage.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt ?? '' }))
    await update($, health, h => ({
      ...h,
      tokens,
      lastResponseAt: at,
      limits,
      paceBases: nextPaceBases(h.paceBases ?? [], limits, at),
      costUsd: usage.cost?.usd ?? h.costUsd ?? 0,
    }))
  } catch {
    // usage is best effort; the band keeps its last reading
  }
}

async function isNewTopic($: EngineInterface, h: Health, text: string): Promise<boolean> {
  const prompt = `A user is working in one long AI coding chat.
Chat started with: """${clip(h.firstPrompt, 600)}"""
Recent requests: ${h.recentPrompts.map(p => `"""${clip(p, 250)}"""`).join(' ; ') || '(none)'}
New request: """${clip(text, 600)}"""
Is the new request a continuation of the same piece of work (same feature, bug, files or follow-up), or a different task that would be better started in a fresh chat? Answer with exactly one word: SAME or NEW.`
  const r = await $.model.complete({ model: 'haiku', prompt, maxTokens: 5, timeoutMs: 4000 })
  return r.isAnswered === true && /\bNEW\b/i.test(r.text)
}

const COMPACT_FOCUS =
  'Keep the goal, decisions with their reasons, exact file paths and commands, the current state, anything unverified, errors seen, and the next steps. Drop exploration that led nowhere.'

const LEVEL_RANK: Record<Level, number> = { ok: 0, amber: 1, cold: 2, red: 2 }
let lastAdvised: Level = 'ok'

// Same task, big chat: compact in place (keeps this session: approvals, background tasks, browser tabs).
async function compactNow($: EngineInterface, thenSend?: string) {
  const h = await read($, health)
  if (h.isCompacting || h.isHandingOff) return
  await update($, health, x => ({ ...x, isCompacting: true }))
  $.ui.toast('Compacting this chat…')
  $.clock.after(50, async () => {
    try {
      const r = await $.session.compact({ instructions: COMPACT_FOCUS })
      if ('skip' in r && r.skip) {
        $.ui.toast(`Compact skipped: ${r.skip}`)
        return
      }
      await update($, hold, () => null)
      if (thenSend) await $.prompt.submit({ text: thenSend, asUser: true })
    } catch {
      $.ui.toast('Compact failed. Run /compact yourself, or /handoff.')
    } finally {
      await update($, health, x => ({ ...x, isCompacting: false }))
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

// Claude's own todo list (TodoWrite) as a plan, for when it keeps one instead of reporting progress.
function planFromTodos(prev: Plan | null, todos: { content: string; status: string }[], at: number): Plan | null {
  if (todos.length === 0) return null
  const order = { completed: 0, in_progress: 1, pending: 2 } as Record<string, number>
  const sorted = [...todos].sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2))
  const steps = sorted.map(t => clip(String(t.content), 80)).slice(0, 20)
  const done = Math.min(steps.length, sorted.filter(t => t.status === 'completed').length)
  return advancePlan(prev && prev.source === 'todos' ? prev : null, steps, 0, done, at, 'todos')
}

function advancePlan(prev: Plan | null, steps: string[], estimateMin: number, done: number, at: number, source: Plan['source']): Plan {
  const startedAt = prev?.startedAt ?? at
  const waitMs = prev?.waitMs ?? 0
  const keep = Math.min(done, prev?.done ?? 0)
  const doneAt = (prev?.doneAt ?? []).slice(0, keep)
  const doneActive = (prev?.doneActive ?? []).slice(0, keep)
  const activeNow = Math.max(0, at - startedAt - waitMs) / 60000
  while (doneAt.length < done) doneAt.push(at)
  while (doneActive.length < done) doneActive.push(activeNow)
  const est = estimateMin > 0 ? estimateMin : prev?.estimateMin ?? 0
  return { steps, estimateMin: est, firstEstimateMin: prev?.firstEstimateMin || est, done, startedAt, doneAt, doneActive, waitMs, source }
}

export const register: Register = (on, options) => {
  opts = readOpts(options)

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
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
      home = (isWindows ? await $.env.get('USERPROFILE') : undefined) ?? (await $.env.get('HOME')) ?? ''
      if (isWindows) home = home.replace(/\\/g, '/')
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
    await step('/tasks', () => $.command.register({ name: 'tasks', description: 'Workbar: the task plan, agents, files changed and session health' }))
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
        await syncStatus($)
      })
    })
    if (failed.length > 0) $.ui.log(`workbar: could not set up ${failed.join('; ')}`)
    return next(e)
  })

  // The progress bar only exists when Claude can report a plan; say so once if the tool is missing.
  let toolMissingSaid = false
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (opts.progressTool && !toolMissingSaid && !e.tools.includes(PROGRESS_TOOL) && e.tools.includes('Agent')) {
      toolMissingSaid = true
      $.ui.log('workbar: Claude is not offered the progress tool in this chat, so the bar follows its todo list only. Run /reload-plugins, or start a new chat.')
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if ((e as { reason?: string }).reason === 'clear') {
      await update($, health, () => EMPTY_HEALTH)
      await update($, live, () => EMPTY_LIVE)
      await update($, hold, () => null)
      await update($, agents, () => [])
      await update($, files, () => [])
      await update($, asking, () => null)
      await update($, stuck, () => null)
    }
    return next(e)
  })

  on('command.run', { command: 'tasks' }, async $ => {
    await $.ui.open({ id: TASKS_PANE, title: 'Workbar' })
    return { text: 'Opened.' }
  })

  // The pane: everything in full, where height is no problem (it scrolls on its own).
  on('ui.render', { component: 'Pane', requestId: TASKS_PANE }, async ($, e) => {
    await read($, tick)
    const l = await read($, live)
    const h = await read($, health)
    const ags = await read($, agents)
    const fl = await read($, files)
    const now = await $.clock.now()
    const calib = await calibration($)
    const ratios = ((await $.store.get('calib')) as number[] | undefined) ?? []
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
      out.push(<Text key="noplan" dimColor>No plan yet. One shows when Claude works through several steps.</Text>)
    } else {
      const left = timeLeft(p, now, calib, l.waitingSince)
      out.push(
        head(
          'plan-h',
          `Plan ${p.done}/${p.steps.length}  ·  ${fmtMin(activeMinutes(p, now, l.waitingSince))} of work${left ? `  ·  ${left}` : ''}${p.source === 'todos' ? '  ·  from Claude’s todo list' : ''}`,
        ),
      )
      p.steps.forEach((s, i) => {
        const began = i === 0 ? p.startedAt : p.doneAt[i - 1] ?? p.startedAt
        out.push(
          i < p.done ? (
            <Text key={`s${i}`} dimColor wrap="truncate-end">
              ✓ {s}  {fmtDur((p.doneAt[i] ?? now) - began)}
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

    if (fl.length > 0) {
      out.push(head('f-h', `Files since your last message: ${fileSummary(fl)}`))
      for (const f of sortFiles(fl)) {
        out.push(
          <Text key={`f-${f.path}`} wrap="truncate-middle">
            <Text color={FILE_MARK[f.kind].color}>
              {FILE_MARK[f.kind].sign} {f.kind.padEnd(8)}
            </Text>
            {f.path}
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
    if (e.changed.includes('rateLimits')) {
      const at = await $.clock.now()
      const limits = e.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt ?? '' }))
      await update($, health, h => ({ ...h, limits, paceBases: nextPaceBases(h.paceBases ?? [], limits, at) }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && !('skip' in r && r.skip)) {
      const at = await $.clock.now()
      const after = 'tokensAfter' in r && typeof r.tokensAfter === 'number' ? r.tokensAfter : 0
      await update($, health, x => ({ ...x, tokens: after, allowedUntilTokens: 0, lastResponseAt: at }))
      lastAdvised = 'ok'
      const before = 'tokensBefore' in r && typeof r.tokensBefore === 'number' ? r.tokensBefore : 0
      if (before > 0) $.ui.toast(`Compacted: ${fmtK(before)} → ${after ? fmtK(after) : 'small'}`)
    }
    return r
  })

  on('command.run', { command: 'handoff' }, async $ => {
    void handOff($)
    return { text: 'Writing a handoff, then starting a fresh chat with it in the prompt box.' }
  })

  // Hold a message before it goes into a chat that is too big, cold, or about something else.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
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
    if (opts.holdMessages && !isRepeat && !agentsBusy && !isLimitHit(h, now) && h.tokens > h.allowedUntilTokens) {
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
      await update($, files, () => [])
      await update($, health, x => ({
        ...x,
        prompts: x.prompts + 1,
        firstPrompt: x.firstPrompt || text,
        recentPrompts: [...x.recentPrompts, text].slice(-2),
      }))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      errStreak = { tool: '', count: 0 }
      await update($, stuck, () => null)
      await update($, live, l => ({ ...l, isWorking: true, startedAt: at, tools: 0, lastAction: '', plan: null, waitingSince: 0 }))
      await markActivity($, 'busy')
      await syncStatus($)
    }
    return next(e)
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
      const prev = l.plan?.source === 'progress' ? l.plan : null
      const steps = Array.isArray(args.steps) ? args.steps.map(s => clip(String(s), 80)).filter(Boolean).slice(0, 20) : prev?.steps ?? []
      const est = typeof args.estimate_minutes === 'number' && args.estimate_minutes > 0 ? args.estimate_minutes : 0
      const done = typeof args.done === 'number' ? Math.max(0, Math.min(steps.length, Math.floor(args.done))) : prev?.done ?? 0
      // A plan that switches from the todo list keeps its start, so elapsed time stays honest.
      const base = prev ?? (l.plan ? { ...l.plan, done: 0, doneAt: [], doneActive: [], firstEstimateMin: 0, estimateMin: 0 } : null)
      return { ...l, plan: advancePlan(base, steps, est, done, at, 'progress') }
    })
    await syncStatus($)
    return { result: 'ok' }
  }).catch(() => ({ result: 'ok' }))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const any = e as unknown as Record<string, unknown>
    const agentId = (e as { agentId?: string }).agentId
    if (tool !== PROGRESS_TOOL) {
      const target = String(any.file_path ?? any.path ?? any.command ?? any.pattern ?? any.url ?? '')
      const name = tool.replace(/^mcp__([^_]+)__/, '$1:')
      const file = target.split(/[\\/]/).pop() ?? ''
      const action = clip(`${name} ${any.file_path || any.path ? file : target}`, 60)
      if (agentId === undefined) await update($, live, l => ({ ...l, tools: l.tools + 1, lastAction: action }))
      else await update($, agents, list => list.map(a => (a.id === agentId ? { ...a, tools: a.tools + 1, lastAction: action } : a)))
    }
    const ops = await filesBefore($, tool, any).catch(() => [] as FileOp[])
    const question = agentId === undefined ? QUESTION_TOOLS[tool] : undefined
    let askedAt = 0
    if (question) {
      askedAt = await $.clock.now()
      await update($, asking, () => question)
      await update($, live, l => ({ ...l, waitingSince: askedAt }))
      await syncStatus($)
      $.clock.after(ASK_ALERT_MS, async () => {
        if ((await read($, asking)) === question) await alert($, question)
      })
    }
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      if (question) {
        // Time spent waiting on you is not Claude's working time: keep it out of the estimates.
        const waited = Math.max(0, (await $.clock.now()) - askedAt)
        await update($, live, l => ({
          ...l,
          waitingSince: 0,
          plan: l.plan && l.plan.startedAt <= askedAt ? { ...l.plan, waitMs: l.plan.waitMs + waited } : l.plan,
        }))
        await update($, asking, () => null)
        await syncStatus($)
      }
    }
    if (ops.length > 0) await filesAfter($, ops, ran.deny === undefined && !ran.isError).catch(() => undefined)

    if (agentId === undefined && tool !== PROGRESS_TOOL) {
      // Claude's own todo list stands in for a plan when it has not reported one.
      if (tool === 'TodoWrite' && !ran.isError && Array.isArray(any.todos)) {
        const at = await $.clock.now()
        await update($, live, l =>
          l.plan?.source === 'progress' ? l : { ...l, plan: planFromTodos(l.plan, any.todos as { content: string; status: string }[], at) },
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

    // Browser extension dropped: show how to reconnect, and keep Claude from giving up on the browser step.
    if (!tool.startsWith(CHROME_PREFIX) || ran.deny !== undefined) return ran
    const text = typeof ran.text === 'string' ? ran.text : ''
    if (ran.isError && CHROME_DOWN.test(text)) {
      const was = await read($, chrome)
      await update($, chrome, () => ({ message: clip(text, 160) }))
      if (!was) {
        $.ui.toast('Chrome extension not connected: run /chrome and pick Reconnect extension.')
        void alert($, 'Chrome extension disconnected. In Claude Code run /chrome, then Reconnect extension.')
      }
      return { ...ran, context: [...(ran.context ?? []), CHROME_NOTE] }
    }
    if (!ran.isError) await update($, chrome, () => null)
    return ran
  }).catch(($, e, next) => next(e))

  // Claude Code's own "needs you" moments (a permission dialog, an MCP form).
  on('classic.Notification', async ($, e, next) => {
    const r = await next(e)
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog') {
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
    const l = await read($, live)
    const seconds = Math.round((at - l.startedAt) / 1000)
    const plan = l.plan
    if (plan && !e.isAborted && plan.source === 'progress') {
      const sample = calibrationSample(plan, activeMinutes(plan, at, 0))
      if (sample !== null) {
        const ratios = ((await $.store.get('calib')) as number[] | undefined) ?? []
        await $.store.set('calib', [...ratios, sample].slice(-20))
      }
    }
    await update($, live, x => ({
      ...x,
      isWorking: false,
      waitingSince: 0,
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
    if (seconds >= opts.notifyAfterSeconds && !e.isAborted) void alert($, `Finished in ${fmtDur(seconds * 1000)}`)
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
    const fl = await read($, files)
    const isFilesOpen = await read($, filesOpen)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)

    const running = ags.filter(a => a.status === 'running')
    const lv: Level = hs.tokens > 0 ? level(hs, now) : 'ok'
    // While subagents run, the chat is not free: compacting or handing off now would lose their results.
    const isFree = !l.isWorking && running.length === 0
    // At the limit Compact and Hand off would fail too: offer only Log in.
    const limitHit = !l.isWorking && isLimitHit(hs, now)
    const chatAlert = lv !== 'ok' && isFree && !limitHit
    const isRed = lv === 'red' || lv === 'cold'
    const plan = l.isWorking && l.plan && l.plan.steps.length > 0 ? l.plan : null

    if (l.isWorking) {
      // Claude Code's own spinner already says it is working and for how long; add only what it lacks.
      if (!plan && ags.length === 0 && !cx && !st) return next(e)
    } else {
      const worthIt = held || cx || limitHit || chatAlert || ags.length > 0 || fl.length > 0
      if (!worthIt && !(opts.band === 'always' && hs.tokens > 0)) return next(e)
    }

    const cols = Math.max(20, e.props.bodyColumns ?? 80)
    const inner = Math.max(16, cols - 4) // inside the border and padding
    const narrow = inner < 60
    const room = bandBudget(e.props.maxRows, e.viewport?.rows, e.viewport?.isFullscreen) - 2 // less the border

    const state = l.isWorking
      ? { label: '', color: st ? 'warning' : 'claude' }
      : running.length > 0
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
    const recap = !l.isWorking && lr && lr.seconds >= 60 && !narrow ? `  last ${fmtDur(lr.seconds * 1000)} · ${plural(lr.tools, 'tool')}` : ''
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
        <Text key="chat"> </Text>
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
      const tail = left ? `  ${left}${eta}` : ''
      const barW = Math.max(6, Math.min(40, inner - 6 - tail.length))
      const filled = Math.round(pct * barW)
      add(
        6,
        <Text key="bar" wrap="truncate-end">
          <Text color="claude">{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(barW - filled)}</Text>
          <Text bold> {String(Math.round(pct * 100)).padStart(3, ' ')}%</Text>
          <Text dimColor>{tail}</Text>
        </Text>,
      )
      // One line: a strip of marks for every step, then the current one by name.
      const cur = Math.min(plan.done, n - 1)
      const strip = n <= 12 && inner >= 40
      stepsCompactAt = rows.length
      add(
        5,
        <Text key="steps" wrap="truncate-end">
          {strip ? (
            <Text>
              <Text color="success">{'✓'.repeat(Math.min(plan.done, n))}</Text>
              <Text color="claude">{plan.done < n ? '▶' : ''}</Text>
              <Text dimColor>{'○'.repeat(Math.max(0, n - plan.done - 1))} </Text>
            </Text>
          ) : (
            ''
          )}
          <Text bold>
            {strip ? '' : `Step ${cur + 1}/${n} · `}
            {plan.steps[cur] ?? ''}
          </Text>
          {plan.done + 1 < n ? <Text dimColor>  next: {plan.steps[plan.done + 1]}</Text> : ''}
        </Text>,
      )
    } else if (!l.isWorking) {
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

    if (limitHit) {
      add(
        10,
        choices([
          choice('login', 'Log in', 'switch account', 'l', true, async () => {
            await update($, health, h => ({ ...h, limits: h.limits.filter(x => x.pct < 100) }))
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

    // ---- files touched: one line, opened on demand ----
    const filesAt = rows.length
    if (fl.length > 0) {
      add(
        3,
        <Box key="files" flexDirection="row">
          <Button
            key="files-toggle"
            plain
            label={`${isFilesOpen ? '▾' : '▸'} ${plural(fl.length, 'file')}`}
            onPress={() => update($, filesOpen, v => !v)}
          />
          <Text dimColor wrap="truncate-end">
            {'  '}
            {fileSummary(fl)}
          </Text>
        </Box>,
      )
    }

    // ---- fill what is left: agents first, then the full step list, then open file paths ----
    let used = rows.reduce((s, r) => s + r.rows, 0)
    const spare = () => Math.max(0, room - used)
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
                {hiddenRunning > 0 && shown.length > 0 ? ` (${hiddenRunning} running)` : ''} · /tasks shows all
              </Text>
            </Text>
          ),
        })
      }
      used += agentRows.length
    }

    // The full step list replaces the one-line strip when it fits.
    if (plan && stepsCompactAt >= 0) {
      const chips = plan.steps.map(s => clip(s, 28))
      const need = wrappedRows(chips.reduce((s, c) => s + c.length + 5, 0), inner)
      if (need - 1 <= spare()) {
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
      }
    }

    const fileRows: Row[] = []
    if (fl.length > 0 && isFilesOpen) {
      const sorted = sortFiles(fl)
      const cap = spare()
      const fits = sorted.length <= cap
      for (const f of (fits ? sorted : sorted.slice(0, Math.max(0, cap - 1)))) {
        fileRows.push({
          prio: 1,
          rows: 1,
          el: (
            <Text key={`file-${f.path}`} wrap="truncate-middle">
              <Text color={FILE_MARK[f.kind].color}>
                {'  '}
                {FILE_MARK[f.kind].sign} {narrow ? '' : f.kind.padEnd(8)}
              </Text>
              {f.path}
            </Text>
          ),
        })
      }
      if (!fits && cap > 0) {
        fileRows.push({ prio: 1, rows: 1, el: <Text key="file-more" dimColor>  +{sorted.length - Math.max(0, cap - 1)} more · /tasks shows all</Text> })
      }
    }

    // Order on screen: header or plan, warnings, agents, files, actions last (nearest the prompt).
    const actions = rows.filter(r => r.prio >= 9)
    const before = rows.slice(0, filesAt).filter(r => r.prio < 9)
    const fileLine = rows.slice(filesAt).filter(r => r.prio < 9)
    const kept = fitRows([...before, ...agentRows, ...fileLine, ...fileRows, ...actions], room)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={state.color} paddingX={1} width={cols}>
        {kept}
      </Box>
    )
  })
}
