import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { bandBudget, calibrationFrom, fitRows, minutesLeft } from './lib'
import type { Plan } from '../types'

const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
} as never
const idle = (extra: object = {}) => ({ ...(BAND as object), isWorking: false, ...extra }) as never

let now = 1_000_000
const engine = (on: On) => {
  on('clock.now', () => ({ value: now }))
  on('store.get', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
}
const bigChat = (on: On, tokens = 320_000) => {
  on('store.set', () => ({ value: undefined }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.usage', () => ({ value: { context: { tokens, window: 1_000_000, percent: 32 }, rateLimits: [] } }) as never)
}

// ---- pure helpers ----

test('calibration takes the median of past plans, within 0.15 and 3', async () => {
  // a real history: Claude's estimates ran about 3x long
  const history = [0.25, 0.4, 0.86, 0.27, 0.11, 0.12, 3.3, 0.1, 12, 1.68, 1.15, 0.29, 0.3, 0.34, 0.3, 0.22, 0.23, 2.71, 0.54, 0.26]
  const c = calibrationFrom(history)
  expect(c > 0.25 && c < 0.35).toBe(true)
  expect(calibrationFrom([0.01, 0.02, 0.03])).toBe(0.15)
  expect(calibrationFrom([0.9])).toBe(0.5) // too few: the default
})

test('time left follows the pace of finished steps, not only the first estimate', async () => {
  const p: Plan = {
    steps: ['a', 'b', 'c', 'd'],
    estimateMin: 40,
    firstEstimateMin: 40,
    done: 2,
    startedAt: 0,
    doneAt: [60_000, 120_000],
    doneActive: [1, 2],
    waitMs: 0,
    source: 'progress',
  }
  // two steps in 2 minutes: about 1 minute per step is left for each of the last two, give or take the prior
  const left = minutesLeft(p, 120_000, 1, 0)!
  expect(left).toBeGreaterThan(1.5)
  expect(left).toBeLessThan(6)
})

test('the band never asks for more rows than a third of the screen, or 12', async () => {
  expect(bandBudget(40, 30, false)).toBe(10)
  expect(bandBudget(40, 100, false)).toBe(12)
  expect(bandBudget(6, 60, true)).toBe(6)
  expect(bandBudget(2, 10, false)).toBe(3)
  expect(fitRows([{ prio: 1, rows: 1, el: 'a' }, { prio: 9, rows: 1, el: 'b' }, { prio: 5, rows: 2, el: 'c' }], 3)).toEqual(['b', 'c'])
})

// ---- the band ----

test('a progress plan shows the current step, count and time left', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'build the switch', turnId: 't1' })
  now += 3 * 60_000
  const r = await $.tool.call({
    tool: 'mcp__workbar__progress',
    steps: ['Read code', 'Write mode', 'Test'],
    estimate_minutes: 10,
    done: 1,
  } as never)
  expect(r).toMatchObject({ result: 'ok' })
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: BAND } as never)
  expect(await ui.find({ text: /▶ Write mode/ })).toBeDefined()
  expect(await ui.find({ text: /left/ })).toBeDefined()
})

test('in a short band the steps fold into one line with the current step named', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'build', turnId: 't1b' })
  await $.tool.call({ tool: 'mcp__workbar__progress', steps: ['Read the code', 'Write the mode', 'Test it', 'Ship'], estimate_minutes: 10, done: 1 } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: { ...(BAND as object), maxRows: 4, bodyColumns: 50 } } as never)
  expect(await ui.find({ text: /Write the mode/ })).toBeDefined()
  expect(await ui.find({ text: /next: Test it/ })).toBeDefined()
  expect(await ui.find({ text: /○ Ship/ })).toBeUndefined()
})

test('without a plan or agents the band stays out of the way while Claude works', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return (<Text>engine band</Text>) as never
  })
  on('tool.call', () => ({ result: 'done' }) as never)
  await $.turn.start({ text: 'look around', turnId: 't2' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x/Settings.cs' } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: BAND } as never)
  expect(await ui.find({ text: /engine band/ })).toBeDefined()
  expect(await ui.find({ text: /Settings\.cs/ })).toBeUndefined()
})

test('while Claude shows a plan for approval the band gives up its room', async (t$, on) => {
  const $ = t$
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return (<Text>engine band</Text>) as never
  })
  on('clock.after', () => ({ value: undefined }) as never)
  let duringDialog: unknown
  on('tool.call', async (_$, e) => {
    if ((e as { tool: string }).tool === 'ExitPlanMode') {
      const ui = await t$.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: BAND } as never)
      duringDialog = await ui.find({ text: /engine band/ })
    }
    return { result: 'ok' } as never
  })
  await $.turn.start({ text: 'plan it', turnId: 't2b' })
  await $.tool.call({ tool: 'mcp__workbar__progress', steps: ['Explore', 'Plan'], estimate_minutes: 5, done: 1 } as never)
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'x' } as never)
  expect(duringDialog).toBeDefined()
})

test('time spent waiting on your answer does not eat into the estimate', async ($, on) => {
  engine(on)
  const status: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('clock.after', () => ({ value: undefined }) as never)
  on('tool.call', e => {
    if ((e as unknown as { tool: string }).tool === 'AskUserQuestion') now += 10 * 60_000 // you take 10 minutes to answer
    return { result: 'ok' } as never
  })
  await $.turn.start({ text: 'build', turnId: 't2c' })
  await $.tool.call({ tool: 'mcp__workbar__progress', steps: ['A', 'B', 'C'], estimate_minutes: 10 } as never)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  // default calibration 0.5: 10 minutes shows as 5, and the 10 minutes of waiting are not counted
  expect(status[status.length - 1]).toMatch(/^▶ 0\/3 · ~5m left$/)
})

test('a message into a 350k chat is held once, and a second Enter sends it', async ($, on) => {
  engine(on)
  bigChat(on, 350_000)
  on('clock.after', () => ({ value: undefined }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.turn.start({ text: 'first task', turnId: 't3' })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't3', reason: 'answer' } as never)
  const first = await $.prompt.submit({ text: 'now a different job on the website header' } as never)
  expect(first.drop).toBeDefined()
  const again = await $.prompt.submit({ text: 'now a different job on the website header' } as never)
  expect(again.drop).toBeUndefined()
  expect(again.text).toBe('now a different job on the website header')
})

test('with holding turned off, a big chat still lets every message through', { options: { holdMessages: false } }, async ($, on) => {
  engine(on)
  bigChat(on, 350_000)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.turn.start({ text: 'first task', turnId: 't3b' })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't3b', reason: 'answer' } as never)
  const r = await $.prompt.submit({ text: 'keep going' } as never)
  expect(r.drop).toBeUndefined()
})

test('a resent plan with a new step updates the band', async ($, on) => {
  engine(on)
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  await $.turn.start({ text: 'build it', turnId: 't4' })
  await $.tool.call({ tool: 'mcp__workbar__progress', steps: ['Read', 'Write', 'Test'], estimate_minutes: 9, done: 1 } as never)
  const mid = await $.prompt.submit({ text: 'also add a dark mode toggle', turnId: 't4' } as never)
  expect(String(mid.context ?? '')).toMatch(/updated `steps`/)
  await $.tool.call({ tool: 'mcp__workbar__progress', steps: ['Read', 'Write', 'Dark mode toggle', 'Test'], estimate_minutes: 12 } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: BAND } as never)
  expect(await ui.find({ text: /▶ Write/ })).toBeDefined()
  expect(await ui.find({ text: /✓ Read/ })).toBeDefined()
  expect(await ui.find({ text: /○ Dark mode toggle/ })).toBeDefined()
})

test('Claude’s own todo list drives the bar when it reports no plan', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.turn.start({ text: 'fix it', turnId: 't4b' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Find the bug', status: 'completed', activeForm: 'Finding' },
      { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing' },
      { content: 'Add a test', status: 'pending', activeForm: 'Testing' },
    ],
  } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: BAND } as never)
  expect(await ui.find({ text: /33%/ })).toBeDefined()
  expect(await ui.find({ text: /▶ Fix the bug/ })).toBeDefined()
})

test('three failed calls in a row raise a warning, and a success clears it', async ($, on) => {
  engine(on)
  let fail = true
  on('tool.call', () => (fail ? { result: null, isError: true, text: 'exit 1' } : { result: 'ok' }) as never)
  await $.turn.start({ text: 'run tests', turnId: 't4c' })
  await $.tool.call({ tool: 'mcp__workbar__progress', steps: ['Test'], estimate_minutes: 2 } as never)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: BAND } as never)
  expect(await ui.find({ text: /3 failed Bash calls in a row/ })).toBeDefined()
  fail = false
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  expect(await ui.find({ text: /failed Bash calls/ })).toBeUndefined()
})

test('a disconnected Chrome extension shows reconnect help and tells Claude to wait', async ($, on) => {
  engine(on)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.notify', () => ({ value: { isSent: true, channel: 'test' } }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('tool.call', () => ({ result: null, isError: true, text: 'Browser extension is not connected. Please ensure the Claude browser extension is installed and running' }) as never)
  await $.turn.start({ text: 'check the site', turnId: 't5' })
  const r = await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'https://example.com' } as never)
  expect(String((r as { context?: string[] }).context ?? '')).toMatch(/wait for the user/)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: BAND } as never)
  expect(await ui.find({ text: /Chrome extension disconnected/ })).toBeDefined()
})

test('a large chat offers Compact for the same task and Hand off for a new one', async ($, on) => {
  engine(on)
  bigChat(on)
  await $.turn.start({ text: 'task', turnId: 't6' })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't6', reason: 'answer' } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: idle() } as never)
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  expect(await ui.find({ key: 'handoff' })).toBeDefined()
  expect(await ui.find({ text: /★ Compact/ })).toBeDefined()
  expect(await ui.find({ text: /ACTION/ })).toBeDefined()
})

test('in a narrow tab the actions stay on one line and the recommended one is starred', async ($, on) => {
  engine(on)
  bigChat(on)
  await $.turn.start({ text: 'task', turnId: 't7' })
  await $.tool.call({ tool: 'mcp__workbar__progress', steps: ['A', 'B'], estimate_minutes: 5, done: 2 } as never)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't7', reason: 'answer' } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: idle({ bodyColumns: 44 }) } as never)
  expect(await ui.find({ text: /★ Hand off/ })).toBeDefined()
  expect(await ui.find({ text: /same task|new task/ })).toBeUndefined() // hints drop first
})

test('many subagents in a short band collapse into a summary row', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'sonnet', agentId: `ag${++n}` }) as never)
  await $.turn.start({ text: 'fan out', turnId: 't8a' })
  await $.tool.call({ tool: 'mcp__workbar__progress', steps: ['Search', 'Merge'], estimate_minutes: 5 } as never)
  for (let i = 0; i < 10; i++) await $.agent.spawn({ prompt: 'dig', description: `Explore area ${i}`, subagentType: 'Explore' } as never)
  // 8 rows: 2 for the border, 2 for the plan, 4 for agents: 3 named and a summary
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: { ...(BAND as object), maxRows: 8 } } as never)
  expect(await ui.find({ text: /Explore area 0/ })).toBeDefined()
  expect(await ui.find({ text: /Explore area 2/ })).toBeDefined()
  expect(await ui.find({ text: /Explore area 3/ })).toBeUndefined()
  expect(await ui.find({ text: /\+7 more \(7 running\)/ })).toBeDefined()
})

test('each subagent gets a row that shows its progress, and finishing marks it done', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'ag1' }) as never)
  on('tool.call', () => ({ result: 'done' }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.turn.start({ text: 'audit the design', turnId: 't8' })
  await $.agent.spawn({ prompt: 'review it', description: 'Audit the panel design', subagentType: 'impeccable-finish-reviewer' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'C:/x/Flyout.xaml', agentId: 'ag1' } as never)
  await $.tool.call({ tool: 'mcp__workbar__progress', steps: ['Read', 'Judge', 'Report'], done: 1, agentId: 'ag1' } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: BAND } as never)
  expect(await ui.find({ text: /Audit the panel design/ })).toBeDefined()
  expect(await ui.find({ text: /step 2\/3 · 1 tool/ })).toBeDefined()
  expect(await ui.find({ text: /Flyout\.xaml/ })).toBeDefined()
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 'a-t', reason: 'answer', agentId: 'ag1' } as never)
  expect(await ui.find({ text: /✓ / })).toBeDefined()
})

test('with the main turn over but an agent still running, the band says WAITING and offers no Compact', async ($, on) => {
  engine(on)
  bigChat(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'ag2' }) as never)
  await $.turn.start({ text: 'research', turnId: 't9' })
  await $.agent.spawn({ prompt: 'dig', description: 'Background research', subagentType: 'general-purpose', background: true } as never)
  await $.turn.complete({ answer: 'started', durationMs: 1000, isAborted: false, turnId: 't9', reason: 'answer' } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: idle() } as never)
  expect(await ui.find({ text: /WAITING/ })).toBeDefined()
  expect(await ui.find({ text: /1 agent still running/ })).toBeDefined()
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
})

test('at a usage limit the band offers only Log in, without repeating the limit', async ($, on) => {
  engine(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('session.usage', () =>
    ({ value: { context: { tokens: 320_000, window: 1_000_000, percent: 32 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: '2030-01-01T00:00:00Z' }] } }) as never,
  )
  await $.turn.start({ text: 'more work', turnId: 't10' })
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't10', reason: 'error' } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: idle() } as never)
  expect(await ui.find({ key: 'login' })).toBeDefined()
  expect(await ui.find({ text: /★ Log in/ })).toBeDefined()
  expect(await ui.find({ text: /100%/ })).toBeUndefined()
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
})

test('files Claude adds, changes and deletes show as one line that opens to full paths', async ($, on) => {
  engine(on)
  on('env.get', (_$, e) => ({ value: (e as { name: string }).name === 'OS' ? 'Windows_NT' : undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const win = (p: string) => p.split('/').join(String.fromCharCode(92)) // the band shows Windows paths
  const onDisk = new Set([win('C:/proj/src/old.ts'), win('C:/proj/src/app.ts')])
  on('fs.stat', (_$, e) => {
    // On macOS and Linux the engine resolves a C:\ path against the real working folder first: match the end.
    const asked = (e as { path: string }).path
    if (![...onDisk].some(p => asked.endsWith(p))) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, isLink: false } } as never
  })
  on('tool.call', (_$, e) => {
    const a = e as unknown as { tool: string; file_path?: string }
    if (a.tool === 'Write' && a.file_path) onDisk.add(win(a.file_path))
    if (a.tool === 'Bash') onDisk.delete(win('C:/proj/src/old.ts'))
    return { result: 'ok' } as never
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'refactor', turnId: 't11' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/proj/src/new.ts', content: 'x' } as never)
  await $.tool.call({ tool: 'Edit', file_path: win('C:/proj/src/app.ts'), old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'rm -f "C:/proj/src/old.ts" && echo done' } as never)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't11', reason: 'answer' } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: idle() } as never)
  expect(await ui.find({ text: /3 files/ })).toBeDefined()
  expect(await ui.find({ text: /1 changed · 1 added · 1 removed/ })).toBeDefined()
  expect(await ui.find({ text: win('C:/proj/src/new.ts') })).toBeUndefined()
  await ui.press({ key: 'files-toggle' })
  expect(await ui.find({ text: /\+ added/ })).toBeDefined()
  expect(await ui.find({ text: win('C:/proj/src/new.ts') })).toBeDefined()
  expect(await ui.find({ text: /− removed/ })).toBeDefined()
})

test('the status line mirrors progress, and shows when Claude is asking you something', async ($, on) => {
  engine(on)
  const status: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('clock.after', () => ({ value: undefined }) as never)
  let seenWhileAsking: string | undefined
  on('tool.call', (_$, e) => {
    if ((e as { tool: string }).tool === 'AskUserQuestion') seenWhileAsking = status[status.length - 1]
    return { result: 'ok' } as never
  })
  await $.turn.start({ text: 'build', turnId: 't12' })
  await $.tool.call({ tool: 'mcp__workbar__progress', steps: ['A', 'B', 'C', 'D'], estimate_minutes: 8, done: 1 } as never)
  expect(status[status.length - 1]).toMatch(/^▶ 1\/4 · ~.+ left$/)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect(seenWhileAsking).toBe('◆ Claude has a question for you')
  expect(status[status.length - 1]).toMatch(/^▶ 1\/4/)
})

test('with the band off only the status line reports', { options: { band: 'off' } }, async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return (<Text>engine band</Text>) as never
  })
  await $.turn.start({ text: 'build', turnId: 't13' })
  await $.tool.call({ tool: 'mcp__workbar__progress', steps: ['A', 'B'], estimate_minutes: 4 } as never)
  const ui = await $.ui.mount({ plugin: 'workbar', surface: 'terminal', component: 'AbovePrompt', props: BAND } as never)
  expect(await ui.find({ text: /engine band/ })).toBeDefined()
})
