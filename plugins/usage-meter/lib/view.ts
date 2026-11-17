// Builds what the pane and the band draw (MeterView) from a parsed transcript,
// and adds the exchanges seen live that the transcript does not have yet.
// Pure: the mod runs it in-process, the Node helper (scripts/summarize.ts) for
// transcripts too big for the mod to read.

import type {
  LimitLogEntry,
  LiveExchange,
  LiveReq,
  MeterLastMain,
  MeterReq,
  MeterRow,
  MeterTotals,
  MeterView,
} from '../types/index.d.ts'
import { priceFor } from './pricing.ts'
import type { ParsedTranscript } from './transcript.ts'
import type { Exchange, ExchangeReport, Req, SessionReport, Ttl } from './usage.ts'
import { analyzeSession, cacheWrites, promptTokens, requestCost, totalTokens, ZERO_TOKENS } from './usage.ts'

/** Messages kept in the view (the newest). */
export const MAX_ROWS = 300
/** Messages that keep their per-request lines (the newest). */
export const DETAIL_ROWS = 40
/** Main-thread requests listed per message; agents are listed one line each. */
const MAX_DETAIL_MAIN = 40
const MAX_DETAIL_AGENTS = 20

export function emptyTotals(): MeterTotals {
  return { usd: 0, you: 0, claude: 0, penalty: 0, cold: 0, midTurnCold: 0, agentCold: 0, tokens: 0, requests: 0, messages: 0 }
}

function addTotals(a: MeterTotals, b: MeterTotals): MeterTotals {
  return {
    usd: a.usd + b.usd,
    you: a.you + b.you,
    claude: a.claude + b.claude,
    penalty: a.penalty + b.penalty,
    cold: a.cold + b.cold,
    midTurnCold: a.midTurnCold + b.midTurnCold,
    agentCold: a.agentCold + b.agentCold,
    tokens: a.tokens + b.tokens,
    requests: a.requests + b.requests,
    messages: a.messages + b.messages,
  }
}

function detailOf(rep: ExchangeReport, unknownWrites: Ttl): MeterReq[] {
  const reqs = [...rep.ex.reqs].sort((a, b) => a.at - b.at)
  const out: MeterReq[] = []
  const mains = reqs.filter(r => r.kind !== 'agent')
  for (const r of mains.slice(0, MAX_DETAIL_MAIN)) {
    out.push({
      at: r.at,
      kind: r.kind,
      model: r.model,
      read: r.tokens.cacheRead,
      write: cacheWrites(r.tokens),
      uncached: r.tokens.input,
      out: r.tokens.output,
      usd: requestCost(r, priceFor, unknownWrites),
    })
  }
  if (mains.length > MAX_DETAIL_MAIN) {
    const rest = mains.slice(MAX_DETAIL_MAIN)
    out.push(aggregate(rest, 'main', `${rest.length} more requests`, unknownWrites))
  }
  const byAgent = new Map<string, Req[]>()
  for (const r of reqs) {
    if (r.kind !== 'agent') continue
    const id = r.agentId ?? '?'
    const list = byAgent.get(id) ?? []
    list.push(r)
    byAgent.set(id, list)
  }
  const agents = [...byAgent.entries()].map(([id, list]) => aggregate(list, 'agent', id, unknownWrites))
  agents.sort((a, b) => b.usd - a.usd)
  out.push(...agents.slice(0, MAX_DETAIL_AGENTS))
  if (agents.length > MAX_DETAIL_AGENTS) {
    const rest = agents.slice(MAX_DETAIL_AGENTS)
    out.push({
      at: rest[0]?.at ?? 0,
      kind: 'agent',
      model: '',
      read: rest.reduce((s, x) => s + x.read, 0),
      write: rest.reduce((s, x) => s + x.write, 0),
      uncached: rest.reduce((s, x) => s + (x.uncached ?? 0), 0),
      out: rest.reduce((s, x) => s + x.out, 0),
      usd: rest.reduce((s, x) => s + x.usd, 0),
      agent: `${rest.length} more agents`,
      count: rest.reduce((s, x) => s + (x.count ?? 1), 0),
    })
  }
  return out
}

function aggregate(list: readonly Req[], kind: 'main' | 'agent', label: string, unknownWrites: Ttl): MeterReq {
  let read = 0
  let write = 0
  let uncached = 0
  let out = 0
  let usd = 0
  const models = new Set<string>()
  for (const r of list) {
    read += r.tokens.cacheRead
    write += cacheWrites(r.tokens)
    uncached += r.tokens.input
    out += r.tokens.output
    usd += requestCost(r, priceFor, unknownWrites)
    models.add(r.model)
  }
  return {
    at: list[0]?.at ?? 0,
    kind,
    model: models.size === 1 ? [...models][0]! : models.size > 1 ? 'mixed' : '',
    read,
    write,
    uncached,
    out,
    usd,
    agent: label,
    count: list.length,
  }
}

function toRow(rep: ExchangeReport, opts: { live: boolean; open: boolean; detail: boolean; unknownWrites: Ttl }): MeterRow {
  const midTurn = rep.coldLater
    .filter(c => c.thread === 'main')
    .map(c => (c.reason ? { idleMs: c.idleMs ?? 0, rewritten: c.rewritten, penalty: c.penaltyUsd, reason: c.reason } : { idleMs: c.idleMs ?? 0, rewritten: c.rewritten, penalty: c.penaltyUsd }))
  const agentColds = rep.coldLater.filter(c => c.thread === 'agent')
  const row: MeterRow = {
    id: rep.ex.id,
    n: rep.ex.n,
    at: rep.ex.at,
    prompt: rep.ex.prompt,
    origin: rep.ex.origin,
    you: rep.you.usd,
    claude: rep.claude.usd,
    total: rep.total.usd,
    youRead: rep.you.tokens.cacheRead,
    youWrite: cacheWrites(rep.you.tokens) + rep.you.tokens.input,
    out: rep.total.tokens.output,
    tokens: totalTokens(rep.total.tokens),
    mainReqs: rep.claude.mainRequests,
    agentReqs: rep.claude.agentRequests,
    agents: rep.claude.agents,
    advisorReqs: rep.claude.advisorRequests,
    cache: rep.cache.state,
    rewritten: rep.cache.state === 'cold' || rep.cache.state === 'partial' ? rep.cache.rewritten : 0,
    penalty: rep.penaltyUsd,
    midTurn,
    agentCold: { count: agentColds.length, penalty: agentColds.reduce((s, c) => s + c.penaltyUsd, 0) },
  }
  if (rep.cache.reason) row.reason = rep.cache.reason
  if (rep.cache.idleMs !== undefined) row.idleMs = rep.cache.idleMs
  if (rep.ex.inTurn) row.inTurn = true
  if (rep.estimatedRequests > 0) row.estimated = true
  if (opts.live) row.live = true
  if (opts.open) row.open = true
  if (opts.detail) row.detail = detailOf(rep, opts.unknownWrites)
  return row
}

function totalsOf(s: SessionReport): MeterTotals {
  return {
    usd: s.total.usd,
    you: s.you.usd,
    claude: s.claude.usd,
    penalty: s.penaltyUsd,
    cold: s.coldCount,
    midTurnCold: s.midTurnColdCount,
    agentCold: s.agentColdCount,
    tokens: totalTokens(s.total.tokens),
    requests: s.total.requests,
    // Background agents heard after their turn ended are work, not a message.
    messages: s.reports.filter(r => r.ex.origin !== 'background').length,
  }
}

function lastMainOfReq(r: Req | undefined): MeterLastMain | undefined {
  if (!r) return undefined
  // What the next request builds on: the last executor pass (one pass per advisor call).
  const t = r.lastPass ?? r.tokens
  const out: MeterLastMain = { at: r.at, model: r.model, input: t.input, read: t.cacheRead, write: cacheWrites(t), output: t.output }
  if (r.fast) out.fast = true
  if (r.geo) out.geo = r.geo
  return out
}

/** The last main request as a Req again (for judging the next exchange's cache). */
export function reqOfLastMain(m: MeterLastMain | undefined, ttl: Ttl): Req | undefined {
  if (!m) return undefined
  return {
    key: `last@${m.at}`,
    at: m.at,
    model: m.model,
    kind: 'main',
    fast: m.fast,
    geo: m.geo,
    tokens: {
      ...ZERO_TOKENS,
      input: m.input,
      cacheRead: m.read,
      cacheWrite1h: ttl === '1h' ? m.write : 0,
      cacheWrite5m: ttl === '5m' ? m.write : 0,
      output: m.output,
    },
  }
}

/** The view of a transcript alone. `ttlFallback` is used when the transcript does not say which cache lifetime the session runs on. */
export function buildTranscriptView(parsed: ParsedTranscript, ttlFallback: Ttl, now: number): MeterView {
  const report = analyzeSession(parsed.exchanges, { price: priceFor, ttl: parsed.ttl ?? ttlFallback }, parsed.preamble)
  const ttl = report.mainTtl ?? parsed.ttl ?? ttlFallback
  const reps = report.reports
  const first = Math.max(0, reps.length - MAX_ROWS)
  const rows = reps.slice(first).map((rep, i, all) =>
    toRow(rep, { live: false, open: false, detail: i >= all.length - DETAIL_ROWS, unknownWrites: '5m' }),
  )
  const view: MeterView = {
    rows,
    hiddenRows: first,
    totals: totalsOf(report),
    ttl,
    source: 'transcript',
    builtAt: now,
  }
  if (parsed.sessionId) view.sessionId = parsed.sessionId
  if (parsed.title) view.title = parsed.title
  const lm = lastMainOfReq(report.lastMain)
  if (lm) view.lastMain = lm
  if (parsed.compactedAt !== undefined) view.compactedAt = parsed.compactedAt
  const estimated = report.reports.reduce((s, r) => s + r.estimatedRequests, 0)
  if (estimated) view.estimatedRequests = estimated
  return view
}

/**
 * Whether the transcript already holds a live exchange: its first main-thread
 * request was sent before the newest main-thread request the transcript has
 * (`mark`, the time that request's response was written). A live exchange with
 * no main request (agents' steps) is judged by its own start.
 */
export function isCovered(l: LiveExchange, mark: number): boolean {
  let first = Infinity
  for (const r of l.reqs) if (r.kind === 'main' && r.at < first) first = r.at
  return first !== Infinity ? first < mark : l.at < mark
}

/**
 * A live request as a Req. The hook gives one write count with no lifetime
 * split: the main conversation's writes are counted at the session's lifetime,
 * an agent's and a compaction's at 5 minutes, the lifetime Claude Code gives
 * subagents, workflows, forks and compaction even on a subscription.
 */
export function reqOfLive(r: LiveReq, sessionTtl: Ttl): Req {
  const ttl: Ttl = r.kind === 'main' ? sessionTtl : '5m'
  return {
    key: r.key,
    at: r.at,
    model: r.model,
    kind: r.kind,
    agentId: r.agentId,
    live: true,
    tokens: {
      ...ZERO_TOKENS,
      input: r.input,
      cacheRead: r.read,
      cacheWrite1h: ttl === '1h' ? r.write : 0,
      cacheWrite5m: ttl === '5m' ? r.write : 0,
      output: r.output,
    },
  }
}

/** A row for usage no message of yours set off (a compaction's summary request). */
function backgroundRow(r: LiveReq, ttl: Ttl): MeterRow {
  const req = reqOfLive(r, ttl)
  const usd = requestCost(req, priceFor, ttl)
  return {
    id: `bg-${r.key}`,
    n: 0,
    at: r.at,
    prompt: r.kind === 'compact' ? 'Compaction: Claude summarized the conversation' : 'Background request',
    origin: 'background',
    you: 0,
    claude: usd,
    total: usd,
    youRead: 0,
    youWrite: 0,
    out: r.output,
    tokens: totalTokens(req.tokens),
    mainReqs: 0,
    agentReqs: 0,
    agents: 0,
    advisorReqs: 0,
    cache: 'none',
    rewritten: 0,
    penalty: 0,
    midTurn: [],
    agentCold: { count: 0, penalty: 0 },
    live: true,
  }
}

/**
 * Adds the live exchanges that start after the base view's last message and
 * the background requests the transcript never records, and attaches the
 * plan-limit changes recorded live to the messages they belong to.
 */
export function withLive(
  base: MeterView | null,
  live: readonly LiveExchange[],
  limitLog: readonly LimitLogEntry[],
  ttlFallback: Ttl,
  now: number,
  extras: readonly LiveReq[] = [],
  liveCompactedAt?: number,
): MeterView {
  const ttl = base?.ttl ?? ttlFallback
  const mark = base?.lastMain?.at ?? -Infinity
  // Agent requests that had finished before the transcript was read are in it already.
  const readAt = base?.source === 'transcript' ? base.builtAt : -Infinity
  const fresh = live
    .filter(l => !isCovered(l, mark))
    .map(l => ({ ...l, reqs: l.reqs.filter(r => r.kind === 'main' || r.end === undefined || r.end > readAt) }))
    .filter(l => l.reqs.length > 0)
  let rows = base ? [...base.rows] : []
  let totals = base ? base.totals : emptyTotals()
  let lastMain = base?.lastMain
  if (fresh.length) {
    const startN = (base ? base.hiddenRows + base.rows.length : 0) + 1
    const exchanges: Exchange[] = fresh.map((l, i) => ({
      id: l.id,
      n: startN + i,
      prompt: l.prompt,
      origin: l.origin,
      at: l.at,
      endAt: l.endAt,
      isOpen: l.open,
      reqs: l.reqs.map(r => reqOfLive(r, ttl)),
    }))
    const seed = reqOfLastMain(base?.lastMain, ttl)
    const report = analyzeSession(exchanges, { price: priceFor, ttl, unknownWrites: ttl }, seed ? [seed] : [])
    report.reports.forEach((rep, i) => {
      rows.push(toRow(rep, { live: true, open: !!fresh[i]?.open, detail: true, unknownWrites: ttl }))
    })
    totals = addTotals(totals, totalsOf(report))
    lastMain = lastMainOfReq(report.lastMain) ?? lastMain
  }
  if (extras.length) {
    const firstAt = rows.length ? rows[0]!.at : -Infinity
    const bg = extras.filter(x => x.at >= firstAt).map(x => backgroundRow(x, ttl))
    for (const b of bg) {
      totals = addTotals(totals, { ...emptyTotals(), usd: b.total, claude: b.claude, tokens: b.tokens, requests: 1 })
    }
    rows = [...rows, ...bg].sort((a, b) => a.at - b.at)
  }
  // Plan-limit changes were recorded once per turn. Each goes to exactly one row:
  // the one that started the turn (a message delivered into a running turn, or a
  // background row, started none).
  if (limitLog.length) {
    const claimed = new Map<number, LimitLogEntry>()
    for (const e of [...limitLog].sort((a, b) => a.at - b.at)) {
      if (!e.deltas.length) continue
      let pick = -1
      rows.forEach((row, i) => {
        if (row.inTurn || row.origin === 'background' || claimed.has(i)) return
        if (row.at < e.at - 60_000 || row.at > e.at + 5_000) return
        if (pick < 0 || row.at >= rows[pick]!.at) pick = i
      })
      if (pick >= 0) claimed.set(pick, e)
    }
    rows = rows.map((row, i) => {
      const e = claimed.get(i)
      if (!e) {
        if (!row.limits) return row
        const { limits: _drop, limitsSince: _since, ...rest } = row
        return rest
      }
      return e.since !== undefined ? { ...row, limits: e.deltas, limitsSince: e.since } : { ...row, limits: e.deltas }
    })
  }
  let hidden = base?.hiddenRows ?? 0
  if (rows.length > MAX_ROWS) {
    hidden += rows.length - MAX_ROWS
    rows = rows.slice(rows.length - MAX_ROWS)
  }
  const view: MeterView = {
    rows,
    hiddenRows: hidden,
    totals,
    ttl,
    source: base?.source === 'transcript' ? 'transcript' : fresh.length ? 'live' : base?.source ?? 'none',
    builtAt: now,
  }
  if (base?.sessionId) view.sessionId = base.sessionId
  if (base?.title) view.title = base.title
  if (base?.note) view.note = base.note
  if (lastMain) view.lastMain = lastMain
  // A compaction newer than the last main request means the next message rebuilds from the summary.
  const compactedAt = Math.max(base?.compactedAt ?? -Infinity, liveCompactedAt ?? -Infinity)
  if (Number.isFinite(compactedAt) && (!lastMain || compactedAt > lastMain.at)) view.compactedAt = compactedAt
  // Only transcript requests can carry an estimated output; live ones are exact.
  if (base?.estimatedRequests) view.estimatedRequests = base.estimatedRequests
  return view
}

/** Whether a view is worth drawing. */
export function hasData(v: MeterView | null | undefined): v is MeterView {
  return !!v && v.rows.length > 0
}

/** The prompt size the last main request implies for the next one (what it re-sends). */
export function nextContextTokens(m: MeterLastMain): number {
  return promptTokens({ ...ZERO_TOKENS, input: m.input, cacheRead: m.read, cacheWrite1h: m.write }) + m.output
}
