// Pure helpers: formatting, time estimates, usage pace and the band's row budget.
// Nothing here touches the engine, so tests can call it directly.
import type { Plan } from '../types'

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export const fmtK = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)
export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
export const fmtMin = (min: number) => (min < 1 ? 'under 1m' : min < 90 ? `${Math.round(min)}m` : `${(min / 60).toFixed(1)}h`)
export const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
export const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, Math.max(1, n - 1)) + '…' : one
}
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// ---- time estimates ----
// Models tend to estimate how long a person would take, not how long they take themselves, so first
// estimates run long. Each finished plan stores actual/estimated; the median of the last 20 scales the next.
export const CALIB_MIN = 0.15
export const CALIB_MAX = 3
export const DEFAULT_CALIB = 0.5 // until 3 plans have finished

export function median(values: number[]): number {
  const s = values.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  if (s.length === 0) return NaN
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export function calibrationFrom(ratios: number[] | undefined): number {
  const r = (ratios ?? []).filter(x => Number.isFinite(x) && x > 0)
  if (r.length < 3) return DEFAULT_CALIB
  return clamp(median(r), CALIB_MIN, CALIB_MAX)
}

// Minutes of work since the plan started, leaving out time spent waiting on you (questions, plan approval).
export function activeMinutes(p: Plan, now: number, waitingSince: number): number {
  const waiting = waitingSince > 0 && waitingSince >= p.startedAt ? now - waitingSince : 0
  return Math.max(0, now - p.startedAt - p.waitMs - waiting) / 60000
}

// A plan from Claude's report, or the next state of one. Steps already finished when a plan first
// arrives (it often comes a few tool calls in) are its `baseDone`: they took no time on this plan's
// clock, so they never count towards its pace. An estimate is minutes from when it was given.
export function advancePlan(prev: Plan | null, steps: string[], estimateMin: number, done: number, at: number, source: Plan['source']): Plan {
  const startedAt = prev?.startedAt ?? at
  const waitMs = prev?.waitMs ?? 0
  const keep = Math.min(done, prev?.done ?? 0)
  const doneAt = (prev?.doneAt ?? []).slice(0, keep)
  const doneActive = (prev?.doneActive ?? []).slice(0, keep)
  const activeNow = Math.max(0, at - startedAt - waitMs) / 60000
  while (doneAt.length < done) doneAt.push(at)
  while (doneActive.length < done) doneActive.push(activeNow)
  const isNewEstimate = estimateMin > 0
  return {
    steps,
    estimateMin: isNewEstimate ? estimateMin : prev?.estimateMin ?? 0,
    firstEstimateMin: prev?.firstEstimateMin || estimateMin,
    done,
    startedAt,
    doneAt,
    doneActive,
    waitMs,
    source,
    sampled: prev?.sampled,
    baseDone: Math.min(done, prev ? prev.baseDone ?? 0 : done),
    estActive: isNewEstimate ? activeNow : prev?.estActive ?? 0,
    estDone: isNewEstimate ? done : prev?.estDone ?? 0,
  }
}

// Time left on something expected to take `expected` minutes, `spent` minutes in. Once past three
// quarters of it, expect a third as much again as has gone already: a step that runs over usually
// has more to go, so the count never sits at "under 1m" while the work goes on.
const OVERRUN_SHARE = 1 / 3
const remainingOf = (expected: number, spent: number) => Math.max(expected - spent, spent * OVERRUN_SHARE, 0)

// Before a step is finished on this plan's clock: the calibrated estimate counts down from when it was
// given. After that, the pace of those steps takes over, weighed against the estimate's per-step share
// as if it were one finished step (early steps, often reading, tend to be the quick ones).
const PRIOR_WEIGHT = 1
export function minutesLeft(p: Plan, now: number, calib: number, waitingSince = 0): number | null {
  const n = Math.max(1, p.steps.length)
  if (p.done >= n) return 0
  const active = activeMinutes(p, now, waitingSince)
  const base = clamp(p.baseDone ?? 0, 0, p.done)
  const estDone = clamp(p.estDone ?? 0, 0, n - 1)
  const prior = p.estimateMin > 0 ? p.estimateMin * calib : 0
  const sinceEstimate = Math.max(0, active - (p.estActive ?? 0))
  const ran = p.done - base
  if (ran <= 0) return prior > 0 ? remainingOf(prior, sinceEstimate) : null
  const firstAt = base > 0 ? p.doneActive[base - 1] ?? 0 : 0
  const lastAt = clamp(p.doneActive[p.done - 1] ?? active, firstAt, Math.max(firstAt, active))
  const observed = Math.max(0.05, (lastAt - firstAt) / ran)
  const priorPerStep = prior / (n - estDone)
  const perStep = prior > 0 ? (PRIOR_WEIGHT * priorPerStep + ran * observed) / (PRIOR_WEIGHT + ran) : observed
  return remainingOf(perStep, Math.max(0, active - lastAt)) + perStep * (n - p.done - 1)
}

// actual/estimated for a finished (or mostly finished) plan, or null when it says nothing reliable.
// Only the work this plan's clock saw counts: the steps left when it arrived, against its first estimate.
export function calibrationSample(p: Plan, activeMin: number): number | null {
  const base = clamp(p.baseDone ?? 0, 0, p.done)
  const todo = p.steps.length - base
  const ran = p.done - base
  if (p.firstEstimateMin <= 0 || todo <= 0 || ran < Math.ceil(todo / 2) || activeMin < 0.5) return null
  const projected = activeMin * (todo / ran)
  return clamp(projected / p.firstEstimateMin, 0.03, 20)
}

// ---- after a compaction ----
// Claude Code's context figure comes from the last reply, so until the next one it can still read the
// size from before a compaction. A reading close to that old size is stale; the first lower one ends the guard.
export function freshTokens(reading: number, current: number, compactedFrom: number): { tokens: number; isStale: boolean } {
  if (compactedFrom > 0 && reading >= compactedFrom * 0.9) return { tokens: current, isStale: true }
  return { tokens: reading, isStale: false }
}

// Why a compaction did not run, in words that say what to do next.
export function compactSkipText(reason: string, justCompacted: boolean): string {
  if (/not enough|too few|nothing to compact/i.test(reason)) {
    return justCompacted
      ? 'Nothing new to compact: this chat was just compacted. Compact again once it has grown.'
      : 'Too few messages to compact yet: there is nothing to save.'
  }
  return `Compact did not run: ${clip(reason, 120)}`
}

// Two plans are the same piece of work when they share a step.
export const sharesStep = (a: string[], b: string[]) => {
  const seen = new Set(a.map(s => s.toLowerCase()))
  return b.some(s => seen.has(s.toLowerCase()))
}

// ---- topic check, the free part ----
const STOP = new Set(
  'that this with from have what when then them they your about into also just like make sure want need please could would should there their here will more some only than very each which while still after before because does done being been were these those other really thing things okay yeah'.split(' '),
)
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9_.\-/]{4,}/g) ?? []).filter(w => !STOP.has(w)))

// True when a message shares (almost) no words with the earlier requests: the only case worth a model call.
export function looksUnrelated(text: string, earlier: string[]): boolean {
  const mine = words(text)
  if (mine.size < 4) return false // too short to judge; follow-ups are usually short
  const seen = words(earlier.join(' '))
  let shared = 0
  for (const w of mine) if (seen.has(w)) shared++
  return shared / mine.size < 0.15
}

// ---- usage pace: when the current rate would use up a limit window ----
export type PaceBase = { kind: string; resetsAt: string; pct: number; at: number }

export function nextPaceBases(bases: PaceBase[], limits: { kind: string; pct: number; resetsAt: string }[], now: number): PaceBase[] {
  return limits.map(x => {
    const b = bases.find(y => y.kind === x.kind)
    return b && b.resetsAt === x.resetsAt && x.pct >= b.pct ? b : { kind: x.kind, resetsAt: x.resetsAt, pct: x.pct, at: now }
  })
}

// When the window would hit 100% at the rate since it was first seen, if that is before it resets.
export function paceFullAt(base: PaceBase | undefined, pct: number, resetsAt: string, now: number): number | null {
  if (!base || now - base.at < 10 * 60000 || pct <= base.pct) return null
  const rate = (pct - base.pct) / (now - base.at)
  const at = now + (100 - pct) / rate
  const reset = Date.parse(resetsAt)
  return Number.isFinite(reset) && at >= reset ? null : at
}

// ---- a usage limit, shared by every chat on this machine ----
// The limit is the account's, so when one chat hits it every chat is at it. One small file says so:
// when it was hit, until when it can last at most, and when someone logged in after it.
export type SharedLimit = { hitAt: number; until: number; clearedAt: number }
export const LIMIT_MAX_MS = 5 * 60 * 60_000 // a 5-hour window resets by then at the latest

export function parseSharedLimit(text: string): SharedLimit | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const hitAt = num(o.hitAt)
    return hitAt > 0 ? { hitAt, until: num(o.until) || hitAt + LIMIT_MAX_MS, clearedAt: num(o.clearedAt) } : null
  } catch {
    return null
  }
}

// Whether a chat should treat the account as at its limit: hit, not logged in or reset since, and not
// answered for this chat since (its own successful reply after the hit says otherwise).
export const isSharedLimitOn = (s: SharedLimit | null, now: number, lastOkAt: number) =>
  !!s && s.hitAt > s.clearedAt && now < s.until && s.hitAt > lastOkAt

// When a limit hit now ends at the latest: the earliest reset of a window that is full, else 5 hours.
export function limitUntil(limits: { pct: number; resetsAt: string }[], now: number): number {
  const resets = limits
    .filter(x => x.pct >= 100)
    .map(x => Date.parse(x.resetsAt))
    .filter(t => Number.isFinite(t) && t > now)
  return resets.length > 0 ? Math.min(...resets) : now + LIMIT_MAX_MS
}

export const limitLabel =(kind: string) => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? 'week' : kind.replace(/_/g, ' '))

// ---- the band's height ----
// The band shares the bottom of the screen with the prompt and with Claude Code's own dialogs. A tree
// taller than its room scrolls in a small window, and on the main screen a tall bottom area pushes past
// the terminal and breaks the redraw. So the band always fits a fixed budget, borders included.
export const BAND_MAX_ROWS = 12

export function bandBudget(maxRows: number | undefined, viewportRows: number | undefined, isFullscreen: boolean | undefined): number {
  const room = maxRows ?? 20
  const screen = viewportRows && viewportRows > 0 ? viewportRows : 40
  const share = isFullscreen === true ? room : Math.min(room, Math.max(5, Math.floor(screen / 3)))
  return clamp(share, 3, BAND_MAX_ROWS)
}

// Rows a wrapping line takes at a width (a little pessimistic, as word wrap leaves gaps).
export const wrappedRows = (chars: number, width: number) => Math.max(1, Math.ceil((chars * 1.1) / Math.max(10, width)))

// Keep the most important rows that fit, shown in their original order.
export function fitRows<T>(items: { prio: number; rows: number; el: T }[], room: number): T[] {
  const ranked = items.map((it, i) => ({ ...it, i })).sort((a, b) => b.prio - a.prio || a.i - b.i)
  const kept: typeof ranked = []
  let used = 0
  for (const it of ranked) {
    if (used + it.rows > room) continue
    kept.push(it)
    used += it.rows
  }
  return kept.sort((a, b) => a.i - b.i).map(it => it.el)
}
