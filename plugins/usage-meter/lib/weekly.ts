// The weekly-share estimate: what share of the weekly plan limit a message
// used, worked out from its API-equivalent dollars and a rate calibrated
// against the account's own weekly readings.
//
// Why calibrate: Claude Code gives plugins the weekly window as a percentage
// that, on most accounts, moves in whole-point steps, so the change measured
// around one message reads +0% or +1%. Over many messages the steps themselves
// are exact. Between the moment the reading stepped to 41% and the moment it
// stepped to 45%, the window moved 4 points, and the meter knows what was spent
// in between. Points ÷ dollars is the rate, and a message's share is its
// dollars × the rate.
//
// Why pooled: the readings are account-wide. Every chat on this computer that
// runs the meter keeps its spend (by the minute) and the readings it saw in a
// ledger in $.store, one key per chat, and the calibration divides the points
// by what all of them spent. A chat calibrating on its own spend while four
// others ran would put every share about five times too high.
//
// Pure: no imports, no Node, no DOM. The mod, the Node helper and the tests use it.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** $.store keys of the ledger: one per chat, `ledger1:<session id>`. Another format would take another prefix. */
export const LEDGER_PREFIX = 'ledger1:'
/** How far back the calibration looks. */
export const HORIZON_MS = 7 * DAY
/** How long ledger data is kept: a little past the horizon. */
export const KEEP_MS = 8 * DAY
/** A step counts as an anchor only when a reading of the value below it came at most this long before. */
export const ANCHOR_GAP_MS = 10 * MIN
/** No reading from any chat for this long splits the calibration, so usage elsewhere while every chat here was idle stays out of it. */
export const SPLIT_GAP_MS = HOUR
/** Weekly points the calibration has to span before an estimate is shown. */
export const MIN_POINTS = 3
/** The spend inside the anchors' brackets (how far the stretches' ends could be off) must stay under this share of the spend measured. */
export const MAX_EDGE_SHARE = 0.25
/** Steps this recent wait for the other chats' ledgers to catch up (a working chat's entry is never more than 30 seconds behind). */
export const SETTLE_MS = 2 * MIN
/** Two reset times this close are the same window. */
const SAME_WINDOW_MS = HOUR
/** Caps on one chat's entry: minutes of spend, and runs of readings. */
const MAX_MINUTES = 20_000
const MAX_RUNS = 5_000

/** API-equivalent dollars by the minute: [minutes since the epoch, dollars], ascending. */
export type SpendSeries = [number, number][]

/**
 * One run of a weekly reading, as one chat saw it.
 * - `first`: when the value was first known: the end of the response that first reported it.
 * - `last`: the latest time it was known to still hold: the start of the last request that reported it.
 * - `resets`: the window's reset time, ms.
 */
export type SeenRun = { first: number; last: number; pct: number; resets: number }

/** One chat's ledger, decoded. */
export type ChatLedger = { id: string; at: number; spend: SpendSeries; seen: SeenRun[] }

/**
 * A ledger entry as $.store keeps it. The series are compact strings because
 * the store rewrites its whole file, pretty-printed, on every write, and caps it
 * at 4 MiB for every key together.
 */
export type LedgerEntry = { v: 1; at: number; spend: string; seen: string }

/** One weekly reading: its value and window, and the request it came with (sent at `start`, done at `end`). */
export type Reading = { pct: number; resets: number; start: number; end: number }

export type Calibration = {
  /** Enough data for an estimate: at least MIN_POINTS points measured, with the stretches' ends known closely enough. */
  ready: boolean
  /** Weekly percentage points per API-equivalent dollar spent on this computer. */
  pointsPerUsd: number
  /** Weekly points measured between anchors, and what the chats here spent over the same stretches. */
  points: number
  usd: number
  /** What was spent inside the anchors' brackets: how far the stretches' ends could be off, $. */
  edgeUsd: number
  /** Chats whose spend fell in the stretches. */
  chats: number
  /** Stretches measured (one per window and per spell of activity). */
  stretches: number
  /** The first and last anchor used. */
  from?: number
  to?: number
  /** The newest weekly reading any chat here saw: its value, its window's reset, and when it was last known to hold. */
  latest?: LatestReading
}

/** A weekly reading as of a moment: `pct` used, the window resetting at `resets`, known at `at`. */
export type LatestReading = { pct: number; resets: number; at: number }

// ---------------------------------------------------------------- encoding

function enc(n: number): string {
  return Math.round(n).toString(36)
}

function dec(s: string | undefined): number {
  if (!s) return NaN
  const n = parseInt(s, 36)
  return Number.isFinite(n) ? n : NaN
}

/** Sorts a series by minute and adds up repeated minutes. */
function normalize(series: SpendSeries): SpendSeries {
  const m = new Map<number, number>()
  for (const [k, usd] of series) if (Number.isFinite(k) && usd > 0) m.set(k, (m.get(k) ?? 0) + usd)
  return [...m.entries()].sort((a, b) => a[0] - b[0])
}

/** `minute:microdollars` pairs in base 36, comma-separated. */
export function encodeSpend(series: SpendSeries): string {
  return normalize(series)
    .filter(([, usd]) => usd * 1e6 >= 0.5)
    .map(([m, usd]) => `${enc(m)}:${enc(usd * 1e6)}`)
    .join(',')
}

export function decodeSpend(s: unknown): SpendSeries {
  if (typeof s !== 'string' || !s) return []
  const out: SpendSeries = []
  for (const part of s.split(',')) {
    const [a, b] = part.split(':')
    const m = dec(a)
    const micro = dec(b)
    if (Number.isFinite(m) && m > 0 && Number.isFinite(micro) && micro > 0) out.push([m, micro / 1e6])
  }
  return normalize(out)
}

/** `first:last:pct×10:resets` in base 36 (times in seconds), comma-separated. */
export function encodeSeen(runs: readonly SeenRun[]): string {
  return runs.map(r => [r.first / 1000, r.last / 1000, r.pct * 10, r.resets / 1000].map(enc).join(':')).join(',')
}

export function decodeSeen(s: unknown): SeenRun[] {
  if (typeof s !== 'string' || !s) return []
  const out: SeenRun[] = []
  for (const part of s.split(',')) {
    const [a, b, c, d] = part.split(':').map(dec)
    if (![a, b, c, d].every(x => x !== undefined && Number.isFinite(x))) continue
    out.push({ first: a! * 1000, last: b! * 1000, pct: c! / 10, resets: d! * 1000 })
  }
  return out
}

export function encodeEntry(l: { at: number; spend: SpendSeries; seen: readonly SeenRun[] }): LedgerEntry {
  return { v: 1, at: Math.round(l.at), spend: encodeSpend(l.spend), seen: encodeSeen(l.seen) }
}

/** A stored entry, or undefined when it is not one (another format, damage). */
export function decodeEntry(id: string, raw: unknown): ChatLedger | undefined {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
  if (!o || o.v !== 1 || typeof o.at !== 'number' || !Number.isFinite(o.at)) return undefined
  return { id, at: o.at, spend: decodeSpend(o.spend), seen: decodeSeen(o.seen) }
}

// ---------------------------------------------------------------- one chat's ledger

/** Adds up dollars by the minute they were spent in, from `from` on. */
export function spendByMinute(items: Iterable<{ at: number; usd: number }>, from = -Infinity): SpendSeries {
  const m = new Map<number, number>()
  for (const x of items) {
    if (!(x.usd > 0) || !Number.isFinite(x.at) || x.at < from) continue
    const k = Math.floor(x.at / MIN)
    m.set(k, (m.get(k) ?? 0) + x.usd)
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0])
}

/** Two series added up. */
export function addSpend(a: SpendSeries, b: SpendSeries): SpendSeries {
  return normalize([...a, ...b])
}

/** `base`'s minutes before `fromMinute`, then `over`'s from that minute on. */
export function overlaySpend(base: SpendSeries, over: SpendSeries, fromMinute: number): SpendSeries {
  return normalize([...base.filter(([m]) => m < fromMinute), ...over.filter(([m]) => m >= fromMinute)])
}

function sameWindow(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_WINDOW_MS
}

/**
 * Adds one reading to a chat's runs. A new run starts when the value or the
 * window changed, or after a gap of SPLIT_GAP_MS with no reading; otherwise the
 * run goes on. `changed`: the value or the window changed (worth telling the
 * other chats at once).
 */
export function noteReading(runs: readonly SeenRun[], x: Reading): { runs: SeenRun[]; changed: boolean } {
  if (![x.pct, x.resets, x.start, x.end].every(Number.isFinite)) return { runs: [...runs], changed: false }
  const last = runs[runs.length - 1]
  if (last && last.pct === x.pct && sameWindow(last.resets, x.resets) && x.start - Math.max(last.first, last.last) <= SPLIT_GAP_MS) {
    if (x.start <= last.last) return { runs: [...runs], changed: false }
    return { runs: [...runs.slice(0, -1), { ...last, last: x.start }], changed: false }
  }
  const changed = !last || last.pct !== x.pct || !sameWindow(last.resets, x.resets)
  const next = [...runs, { first: x.end, last: Math.min(x.start, x.end), pct: x.pct, resets: x.resets }]
  return { runs: next.slice(-MAX_RUNS), changed }
}

/** Drops what is older than KEEP_MS. */
export function pruneLedger<T extends { spend: SpendSeries; seen: SeenRun[] }>(l: T, now: number): T {
  const since = now - KEEP_MS
  const fromMinute = Math.floor(since / MIN)
  return {
    ...l,
    spend: l.spend.filter(([m]) => m >= fromMinute).slice(-MAX_MINUTES),
    seen: l.seen.filter(r => Math.max(r.first, r.last) >= since).slice(-MAX_RUNS),
  }
}

// ---------------------------------------------------------------- calibration

/** Index of the first minute at or after `minute`. */
function lowerBound(series: SpendSeries, minute: number): number {
  let lo = 0
  let hi = series.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (series[mid]![0] < minute) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Dollars spent between t1 and t2. A minute's dollars count in proportion to the part of the minute inside. */
export function spendBetween(series: SpendSeries, t1: number, t2: number): number {
  if (!(t2 > t1)) return 0
  const last = Math.floor(t2 / MIN)
  let sum = 0
  for (let i = lowerBound(series, Math.floor(t1 / MIN)); i < series.length; i++) {
    const [m, usd] = series[i]!
    if (m > last) break
    const start = m * MIN
    const overlap = Math.min(start + MIN, t2) - Math.max(start, t1)
    if (overlap > 0) sum += usd * (overlap / MIN)
  }
  return sum
}

/** Runs grouped by window (reset times within an hour of each other). */
function byWindow(runs: readonly SeenRun[]): SeenRun[][] {
  const sorted = [...runs].sort((a, b) => a.resets - b.resets)
  const out: SeenRun[][] = []
  let start = -Infinity
  for (const r of sorted) {
    if (!out.length || r.resets - start > SAME_WINDOW_MS) {
      out.push([])
      start = r.resets
    }
    out[out.length - 1]!.push(r)
  }
  return out
}

/** Runs split into spells of activity: SPLIT_GAP_MS with no reading from any chat ends a spell. */
function spells(runs: readonly SeenRun[]): SeenRun[][] {
  const from = (r: SeenRun) => Math.min(r.first, r.last)
  const to = (r: SeenRun) => Math.max(r.first, r.last)
  const sorted = [...runs].sort((a, b) => from(a) - from(b))
  const out: SeenRun[][] = []
  let end = -Infinity
  for (const r of sorted) {
    if (!out.length || from(r) - end > SPLIT_GAP_MS) out.push([])
    out[out.length - 1]!.push(r)
    end = Math.max(end, to(r))
  }
  return out
}

/**
 * The steps of one spell that are known closely in time. For each value above
 * the lowest seen: when it was first known (`at`), and the latest time a lower
 * value was known to hold before that (`from`); the step happened in between.
 * A reading lower than one already reported (another chat's stale one) is no
 * evidence and does not count.
 */
function anchorsOf(spell: readonly SeenRun[], now: number): { at: number; from: number; pct: number }[] {
  const values = [...new Set(spell.map(r => r.pct))].sort((a, b) => a - b)
  const out: { at: number; from: number; pct: number }[] = []
  for (let k = 1; k < values.length; k++) {
    const v = values[k]!
    let at = Infinity
    for (const r of spell) if (r.pct >= v && r.first < at) at = r.first
    let from = -Infinity
    for (const r of spell) if (r.pct < v && r.last <= at && r.last > from) from = r.last
    if (!Number.isFinite(at) || !Number.isFinite(from)) continue
    if (at > now - SETTLE_MS || at - from > ANCHOR_GAP_MS) continue
    out.push({ at, from, pct: v })
  }
  return out
}

/**
 * Weekly points per API-equivalent dollar, from every chat's readings and spend.
 *
 * Within each window and each spell of activity, the first and last step known
 * closely in time bound a stretch: the window moved exactly the difference of
 * their values, and the chats spent what their ledgers hold in between. The
 * rate is all the stretches' points over all their spend.
 */
export function calibrate(chats: readonly ChatLedger[], now: number): Calibration {
  const since = now - HORIZON_MS
  const runs = chats
    .flatMap(c => c.seen)
    .filter(r => [r.first, r.last, r.pct, r.resets].every(Number.isFinite) && Math.max(r.first, r.last) >= since)
  let points = 0
  let usd = 0
  let edgeUsd = 0
  let stretches = 0
  let from: number | undefined
  let to: number | undefined
  const used = new Set<string>()
  for (const window of byWindow(runs)) {
    for (const spell of spells(window)) {
      const anchors = anchorsOf(spell, now)
      const a = anchors[0]
      const b = anchors[anchors.length - 1]
      if (!a || !b || b.pct <= a.pct || b.at <= a.at) continue
      let spent = 0
      let edge = 0
      const here: string[] = []
      for (const c of chats) {
        const s = spendBetween(c.spend, a.at, b.at)
        if (s > 0) here.push(c.id)
        spent += s
        edge += spendBetween(c.spend, a.from, a.at) + spendBetween(c.spend, b.from, b.at)
      }
      if (!(spent > 0)) continue
      for (const id of here) used.add(id)
      points += b.pct - a.pct
      usd += spent
      edgeUsd += edge
      stretches += 1
      from = from === undefined ? a.at : Math.min(from, a.at)
      to = to === undefined ? b.at : Math.max(to, b.at)
    }
  }
  points = Math.round(points * 10) / 10
  let latest: LatestReading | undefined
  for (const r of runs) {
    const at = Math.max(r.first, r.last)
    if (!latest || at > latest.at) latest = { pct: r.pct, resets: r.resets, at }
  }
  const out: Calibration = {
    ready: points >= MIN_POINTS && usd > 0 && edgeUsd <= usd * MAX_EDGE_SHARE,
    pointsPerUsd: usd > 0 ? points / usd : 0,
    points,
    usd,
    edgeUsd,
    chats: used.size,
    stretches,
  }
  if (from !== undefined) out.from = from
  if (to !== undefined) out.to = to
  if (latest) out.latest = latest
  return out
}

/** A message's estimated share of the weekly limit, in percent, or undefined until the calibration is ready. */
export function estimatedShare(usd: number, cal: { ready: boolean; pointsPerUsd: number } | null | undefined): number | undefined {
  if (!cal || !cal.ready || !(cal.pointsPerUsd > 0) || !(usd > 0)) return undefined
  return usd * cal.pointsPerUsd
}

/** A share of the weekly limit: "<0.01%", "0.12%", "1.4%", "12%". The band is picked after rounding, so 0.996 reads "1.0%", not "1.00%". */
export function fmtShare(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return '0%'
  if (pct < 0.005) return '<0.01%'
  if (Number(pct.toFixed(2)) < 1) return `${pct.toFixed(2)}%`
  if (Number(pct.toFixed(1)) < 10) return `${pct.toFixed(1)}%`
  return `${Math.round(pct)}%`
}

/** An estimated share with its mark: "≈0.12%"; "<0.01%" is a bound already, so it takes none. */
export function fmtEstimate(pct: number): string {
  const s = fmtShare(pct)
  return s.startsWith('<') ? s : `≈${s}`
}
