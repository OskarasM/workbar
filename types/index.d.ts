export type Plan = {
  steps: string[]
  estimateMin: number // latest estimate for the whole task
  firstEstimateMin: number // the first one, which calibration compares against
  done: number
  startedAt: number
  doneAt: number[] // wall-clock time each step finished
  doneActive: number[] // minutes of work (waiting on you left out) when each step finished
  waitMs: number // time spent waiting on you since the plan started
  source: 'progress' | 'todos' // Claude's progress reports, or its own todo or task list
  carried?: boolean // brought over from your previous message and not updated by Claude since
  sampled?: boolean // already counted towards calibration
}

export type Live = {
  isWorking: boolean
  startedAt: number
  tools: number
  lastAction: string
  plan: Plan | null
  waitingSince: number // a question or plan dialog is open since then; 0 when none
  lastRun: { seconds: number; estimateMin: number | null; steps: number; done: number; tools: number } | null
  carryPlan?: boolean // the plan was unfinished when the last turn ended: the next message continues it
  endedAt?: number // when the last turn ended
  nudged?: boolean // Claude was asked for a plan in this turn
}

// A short line the band keeps for a while: what just happened, or why an action did not run.
export type Notice = { text: string; tone: 'info' | 'warning'; until: number } | null

export type Health = {
  tokens: number
  prompts: number
  lastResponseAt: number
  firstPrompt: string
  recentPrompts: string[]
  allowedUntilTokens: number
  isHandingOff: boolean
  isCompacting: boolean
  limits: { kind: string; pct: number; resetsAt: string }[]
  paceBases: { kind: string; resetsAt: string; pct: number; at: number }[]
  costUsd: number
  limitNoticeAt: number // when Claude Code said the usage limit was reached; 0 when it has not
  compactStartedAt?: number // a compaction is running since then
  compactedAt?: number // when this chat was last compacted
  compactedFrom?: number // its size just before; readings near it until the next reply are stale
  compactedTo?: number // its size just after (0: not reported)
  promptsAtCompact?: number // messages sent before that compaction
}

export type Hold = { text: string; reason: string; isNewTask: boolean } | null

export type ChromeIssue = { message: string } | null

// Several failed tool calls in a row in the main conversation: Claude may be going in circles.
export type Stuck = { tool: string; count: number } | null

// A subagent Claude started (Explore, a review agent, a fork...), tracked from spawn to its last answer.
export type AgentRun = {
  id: string
  label: string
  type: string
  startedAt: number
  endedAt: number
  tools: number
  lastAction: string
  status: 'running' | 'done' | 'stopped'
  plan: { steps: number; done: number } | null
}

// A file Claude wrote, edited or deleted since your last message, by its full path.
export type FileTouch = { path: string; kind: 'added' | 'changed' | 'removed' }

declare module 'claude-code' {
  interface PluginState {
    workbar: {
      live: Live
      health: Health
      hold: Hold
      tick: number
      chrome: ChromeIssue
      stuck: Stuck
      agents: AgentRun[]
      files: FileTouch[]
      filesOpen: boolean
      asking: string | null
      notice: Notice
    }
  }
}
