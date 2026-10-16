// Pure helpers: formatting, time estimates, usage pace, paths and the band's row budget.
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

// Before any step is done: the calibrated estimate counts down. After that, the pace of the finished
// steps takes over, weighed against the estimate's per-step share as if it were half a finished step.
const PRIOR_WEIGHT = 0.5
export function minutesLeft(p: Plan, now: number, calib: number, waitingSince = 0): number | null {
  const n = Math.max(1, p.steps.length)
  if (p.done >= n) return 0
  const active = activeMinutes(p, now, waitingSince)
  const prior = p.estimateMin > 0 ? p.estimateMin * calib : 0
  if (p.done <= 0) return prior > 0 ? Math.max(prior - active, prior * 0.1) : null
  const doneAt = clamp(p.doneActive[p.done - 1] ?? active, 0.05, Math.max(0.05, active))
  const observed = doneAt / p.done
  const perStep = prior > 0 ? (PRIOR_WEIGHT * (prior / n) + p.done * observed) / (PRIOR_WEIGHT + p.done) : observed
  const onCurrent = Math.max(0, active - doneAt)
  return Math.max(perStep - onCurrent, perStep * 0.25) + perStep * (n - p.done - 1)
}

// actual/estimated for a finished (or mostly finished) plan, or null when it says nothing reliable.
export function calibrationSample(p: Plan, activeMin: number): number | null {
  const n = p.steps.length
  if (p.firstEstimateMin <= 0 || n === 0 || p.done < Math.ceil(n / 2) || activeMin < 0.5) return null
  const projected = activeMin * (n / Math.max(1, p.done))
  return clamp(projected / p.firstEstimateMin, 0.03, 20)
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

export const limitLabel = (kind: string) => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? 'week' : kind.replace(/_/g, ' '))

// ---- paths ----
export function absPath(raw: string, cwd: string, home: string, isWindows: boolean): string {
  let s = raw.trim().replace(/^["']|["']$/g, '')
  if (isWindows) {
    const drive = /^\/([a-zA-Z])\/(.*)$/.exec(s) // Git Bash spelling: /c/Users/...
    if (drive) s = `${(drive[1] ?? 'c').toUpperCase()}:/${drive[2] ?? ''}`
  }
  if (home && (s === '~' || s.startsWith('~/') || s.startsWith('~\\'))) s = home.replace(/[\\/]+$/, '') + s.slice(1)
  const isAbs = /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/')
  if (!isAbs && cwd) s = `${cwd.replace(/[\\/]+$/, '')}/${s}`
  return isWindows ? s.replace(/\//g, '\\') : s
}

// Paths a shell command deletes, best effort: plain paths only, never globs or variables.
const DELETE_CMD = /^(?:sudo\s+)?(?:rm|del|erase|rmdir|rd|ri|unlink|remove-item|git\s+rm)\b/i
export function deleteTargets(command: string): string[] {
  const out: string[] = []
  for (const seg of command.split(/&&|\|\||;|\n|\|/)) {
    const part = seg.trim()
    if (!DELETE_CMD.test(part)) continue
    const toks = part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    for (const tok of toks.slice(1)) {
      if (tok.startsWith('-') || /^rm$/i.test(tok) || /[*?$`(){}]/.test(tok)) continue
      out.push(tok)
    }
  }
  return out.slice(0, 20)
}

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
