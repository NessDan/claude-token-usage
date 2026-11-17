// usage-meter: how much usage each message used, beside the chat.
//
// Live: every model request's usage as it lands (turn.step), the plan-limit
// readings around each turn (turn.start / turn.complete), compaction requests
// (session.compact). After each turn the session's transcript is read again
// (in-process when small, through Node when large) for the exact split: cache
// lifetimes, the advisor model's own tokens, agents' transcripts.
//
// Draws: a pane (one row per message, newest first: your message, Claude's
// reply, the cache, plan points), a one-line band above the prompt (the cache
// countdown and what the next message will cost to read), /usage-meter.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  LimitReadingState,
  LiveExchange,
  LiveReq,
  LiveState,
  MeasureState,
  MeterReq,
  MeterRow,
  MeterView,
} from '../types/index.d.ts'
import { CLAUDE_COLOR, isColdRow, meterSvg, miniChartSvg, NEUTRAL_COLOR, sparkline, splitBarSvg, WARN_COLOR, YOU_COLOR } from '../lib/chart.ts'
import { modelLabel, priceFor } from '../lib/pricing.ts'
import { agentIdFromPath, cleanPrompt, createTranscriptParser, forEachLine, runIdFromPath } from '../lib/transcript.ts'
import type { LimitReading, Ttl } from '../lib/usage.ts'
import { bar, estimateNext, fmtDuration, fmtPoints, fmtTokens, fmtUsd, limitDeltas, limitLabel, preview, ttlMs } from '../lib/usage.ts'
import { buildTranscriptView, isCovered, reqOfLastMain, withLive } from '../lib/view.ts'

const PANE = 'usage-meter'
const TITLE = 'Usage meter'
/** $.fs.read takes files up to 4 MiB. */
const READ_LIMIT = 4_000_000
/** Past this much transcript text the Node helper does the reading. */
const IN_PROCESS_LIMIT = 16_000_000
/** Rows the pane draws (the newest). */
const PANE_ROWS = 80
/** Development aid: when set, every rebuild writes a summary of the view here. Off in the shipped mod. */
const SNAPSHOT_PATH: string = ''
/** The pane's notes toggle, kept with the expanded rows. */
const ABOUT = 'usage-meter-about'
/** Said whenever the band is hidden, so it can be found again. */
const HIDE_HINT = 'Usage band hidden. Type /usage-meter show (or /usage-meter) to bring it back.'

const VIEW = atom({ plugin: 'usage-meter', key: 'view' } as const, null, { shape: 'view-1' })
const LIVE = atom({ plugin: 'usage-meter', key: 'live' } as const, { exchanges: [], agentHome: {}, extras: [] }, { shape: 'live-2' })
const LIMIT_LOG = atom({ plugin: 'usage-meter', key: 'limitLog' } as const, [], { shape: 'limits-1' })
const MEASURE = atom({ plugin: 'usage-meter', key: 'measure' } as const, null, { shape: 'measure-1' })
const TRANSCRIPT = atom({ plugin: 'usage-meter', key: 'transcript' } as const, null)
const UI = atom({ plugin: 'usage-meter', key: 'ui' } as const, { expanded: [], bandHidden: false, notesHidden: false }, { shape: 'ui-2' })
const TICK = atom({ plugin: 'usage-meter', key: 'tick' } as const, 0)

/// Module state: lost on a reload, rebuilt from the transcript.
/** The transcript's own view, as last read, and the path it was read from. */
let base: MeterView | null = null
let basePath: string | undefined
/** Bumped whenever the session's transcript changes (/clear, resume): a read begun before is dropped. */
let sessionGen = 0
/** The main-loop turn running now. */
let turn: { id: string; at: number; before: LimitReadingState[]; since?: number } | undefined
/** When a turn this load heard last ended: toasts are only for messages from then on. */
let seenTurnAt: number | undefined
/** When the plan-limit readings were last refreshed (they come with each API response). */
let lastReadingAt: number | undefined
/** The origin of the prompt about to start the next main turn, as prompt.submit stamped it. */
let pendingOrigin: { kind: string; at: number } | undefined
let refreshing = false
let refreshAgain = false
let lastBuild = 0
let buildPending = false
let toasted = ''
/** The Node helper failed once: do not keep trying it. */
let helperFailed = false
/** The pane was placed on a surface this load. */
let panePlaced = false

// ---------------------------------------------------------------- small helpers

/** A line in the debug log only (claude --debug), never the transcript. */
function dbg($: EngineInterface, text: string): void {
  $.ui.log(`usage-meter: ${text}`, { to: 'debug' })
}

function readings(list: readonly LimitReading[]): LimitReadingState[] {
  return list.map(x => (x.resetsAt ? { kind: x.kind, percentUsed: x.percentUsed, resetsAt: x.resetsAt } : { kind: x.kind, percentUsed: x.percentUsed }))
}

function clock(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

function clockSeconds(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

/** Two spellings of one file (slashes, drive-letter case) are the same file. */
function samePath(a: string, b: string): boolean {
  const k = (p: string) => {
    const s = p.replace(/[\\/]+/g, '/')
    return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s
  }
  return k(a) === k(b)
}

function originOfText(text: string): string {
  if (/^\s*<task-notification>/.test(text)) return 'task-notification'
  return text.trim() ? 'human' : 'continue'
}

/** Who started a row: the person (typed, from a phone, queued), a machine (a notification, another session), or unknown. */
function originClass(origin: string): 'person' | 'machine' | 'other' {
  if (['human', 'composer', 'bridge', 'sdk', 'queued'].includes(origin)) return 'person'
  if (['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay'].includes(origin)) return 'machine'
  return 'other'
}

function originLabel(origin: string): string {
  switch (origin) {
    case 'task-notification':
      return 'Background task: '
    case 'queued':
      return 'Sent while Claude worked: '
    case 'continue':
      return 'Continued: '
    case 'peer':
    case 'peer-send-message':
      return 'Another session: '
    case 'scheduled-trigger':
      return 'Scheduled task: '
    default:
      return ''
  }
}

/** Who woke Claude, for a sentence: "you", "the background task's notification", ... */
function wakerWords(origin: string): string {
  switch (origin) {
    case 'task-notification':
      return "the background task's notification"
    case 'peer':
    case 'peer-send-message':
      return "another session's message"
    case 'scheduled-trigger':
      return 'the scheduled task'
    default:
      return 'this turn'
  }
}

function ttlFallback(measure: MeasureState | null): Ttl {
  // Claude Code gives the main conversation the 1-hour cache on a subscription within its plan.
  return measure && measure.rateLimits.length ? '1h' : '5m'
}

function ttlWords(ttl: Ttl): string {
  return ttl === '1h' ? '1-hour' : '5-minute'
}

function openLive(s: LiveState, ex: LiveExchange): LiveState {
  return { ...s, exchanges: [...s.exchanges.filter(x => x.id !== ex.id), ex].slice(-60) }
}

/** The live exchange for agents' steps that belong to no message being shown live. */
const BACKGROUND = 'background-agents'

/**
 * Files a live request under the exchange it belongs to: an agent's under the
 * exchange it was first seen in, a main-thread step under its own turn. An
 * agent first heard while a turn runs goes to that turn. Steps of an agent whose
 * message the transcript already holds, and steps heard with no turn running (a
 * turn already running when the meter loaded), go to a partial exchange that is
 * never "running" and is dropped once the transcript is read again.
 */
function addLive(s: LiveState, req: LiveReq, runningTurn: string | undefined, stepTurn: string): LiveState {
  const exchanges = [...s.exchanges]
  const agentHome = { ...s.agentHome }
  const home = req.agentId ? agentHome[req.agentId] : undefined
  let idx = -1
  if (home) idx = exchanges.findIndex(x => x.id === home)
  if (idx < 0 && req.kind === 'main') idx = exchanges.findIndex(x => x.id === stepTurn)
  if (idx < 0 && req.agentId && !home && runningTurn) idx = exchanges.findIndex(x => x.id === runningTurn)
  if (idx < 0) {
    const id = req.kind === 'main' ? stepTurn : BACKGROUND
    idx = exchanges.findIndex(x => x.id === id)
    if (idx < 0) {
      exchanges.push({
        id,
        at: req.at,
        prompt: req.kind === 'main' ? '(a turn that was running when the meter loaded)' : 'Background agents still working',
        origin: req.kind === 'main' ? 'continue' : 'background',
        open: false,
        partial: true,
        reqs: [],
      })
      idx = exchanges.length - 1
    }
  }
  const ex = exchanges[idx]!
  if (req.agentId && !agentHome[req.agentId]) agentHome[req.agentId] = ex.id
  exchanges[idx] = { ...ex, reqs: [...ex.reqs.filter(r => r.key !== req.key), req] }
  return { ...s, exchanges, agentHome }
}

/**
 * Where an agent the engine is starting belongs: a new subagent, and one a
 * SendMessage resumes, to the turn running now; one another agent starts, to
 * where that agent belongs; a workflow's agents, to the turn that launched or
 * resumed their run. With no turn running, the background row.
 */
function homeAgent(s: LiveState, agentId: string, e: { parentAgentId?: string; workflow?: { runId: string } }, running: string | undefined): LiveState {
  const agentHome = { ...s.agentHome }
  const runHome = { ...(s.runHome ?? {}) }
  let home: string
  if (e.workflow && e.workflow.runId) {
    home = runHome[e.workflow.runId] ?? running ?? BACKGROUND
    runHome[e.workflow.runId] = home
  } else if (e.parentAgentId) {
    home = agentHome[e.parentAgentId] ?? running ?? BACKGROUND
  } else {
    home = running ?? BACKGROUND
  }
  agentHome[agentId] = home
  return { ...s, agentHome, runHome }
}

function closeLive(s: LiveState, turnId: string, at: number): LiveState {
  return { ...s, exchanges: s.exchanges.map(x => (x.id === turnId ? { ...x, open: false, endAt: at } : x)) }
}

/** What a message's first request did with the cache, in a few words. */
function youWords(r: MeterRow): string {
  switch (r.cache) {
    case 'warm':
      return `read ${fmtTokens(r.youRead)} from cache`
    case 'cold':
      return `cache had lapsed: re-wrote ${fmtTokens(r.rewritten)}`
    case 'partial':
      return `cache partly lapsed: re-wrote ${fmtTokens(r.rewritten)}`
    case 'reset':
      return r.reason === 'compaction'
        ? `context rebuilt after compaction: wrote ${fmtTokens(r.youWrite)}`
        : `a shorter conversation was sent (a rewind or cleared tool results): wrote ${fmtTokens(r.youWrite)}`
    case 'first':
      return `first message: wrote ${fmtTokens(r.youWrite)} to cache`
    default:
      return r.youRead || r.youWrite ? `read ${fmtTokens(r.youRead)} · wrote ${fmtTokens(r.youWrite)}` : 'no request yet'
  }
}

function claudeWords(r: MeterRow): string {
  const parts = [`${r.mainReqs} request${r.mainReqs === 1 ? '' : 's'}`]
  if (r.agentReqs) parts.push(`${r.agentReqs} in ${r.agents || 1} agent${r.agents === 1 ? '' : 's'}`)
  if (r.advisorReqs) parts.push(`advisor ×${r.advisorReqs}`)
  parts.push(`${r.estimated ? '≈' : ''}${fmtTokens(r.out)} written`)
  return parts.join(' · ')
}

/** Why the first request of a row found the cache lapsed, worded for whoever started the row. */
function coldWords(r: MeterRow, ttl: Ttl): string | undefined {
  if (r.cache !== 'cold' && r.cache !== 'partial') return undefined
  if (!r.rewritten) return undefined
  const penalty = r.penalty - r.midTurn.reduce((s, m) => s + m.penalty, 0) - r.agentCold.penalty
  const tail = `re-wrote ${fmtTokens(r.rewritten)} tokens, +${fmtUsd(penalty)} over a warm cache`
  if (r.reason === 'model-switch') return `▲ The model changed, and each model has its own cache: ${tail}`
  if (r.reason !== 'idle') return `▲ The cache missed: something early in the conversation changed (a tool, plugin or setting change, or a Claude Code update): ${tail}`
  const gap = fmtDuration(r.idleMs ?? 0)
  switch (originClass(r.origin)) {
    case 'person':
      return `▲ You were away ${gap}, past the ${ttlWords(ttl)} cache: your message ${tail}`
    case 'machine':
      return `▲ ${wakerWords(r.origin).replace(/^./, c => c.toUpperCase())} woke Claude ${gap} after its last request, past the ${ttlWords(ttl)} cache: it ${tail}`
    default:
      return `▲ This turn started ${gap} after Claude's last request, past the ${ttlWords(ttl)} cache: it ${tail}`
  }
}

/** A row's plan-limit change, labelled with what it covers. */
function limitWords(r: MeterRow): string | undefined {
  if (!r.limits || !r.limits.length) return undefined
  const since = r.limitsSince === undefined ? '' : r.limitsSince > 0 ? ` since ${clock(r.limitsSince)}` : ' since the last reading'
  const each = r.limits.map(l => (l.didReset ? `${l.label} reset, now ${l.now ?? l.delta}%` : `${l.label} ${fmtPoints(l.delta)}`))
  return `Plan (all your sessions${since}): ${each.join(' · ')}`
}

/** The one line shown beneath Claude's answer for the message that just finished. */
function noteLine(r: MeterRow, ttl: Ttl): string {
  const parts = [`Usage: you ${fmtUsd(r.you)} (${youWords(r)})`, `Claude ${r.estimated ? '≈' : ''}${fmtUsd(r.claude)} (${claudeWords(r)})`]
  const plan = limitWords(r)
  if (plan) parts.push(plan)
  // Each lapse with its own figure: the first request's, mid-turn ones, agents'.
  const mid = r.midTurn.reduce((s, m) => s + m.penalty, 0)
  const first = r.penalty - mid - r.agentCold.penalty
  if (first > 0.005) {
    const why =
      r.reason === 'idle'
        ? originClass(r.origin) === 'person'
          ? `after ${fmtDuration(r.idleMs ?? 0)} away, past the ${ttlWords(ttl)} cache`
          : `${fmtDuration(r.idleMs ?? 0)} after Claude's last request, past the ${ttlWords(ttl)} cache`
        : r.reason === 'model-switch'
          ? 'the model changed'
          : 'the cache missed'
    parts.push(`▲ ${why}: +${fmtUsd(first)}`)
  }
  if (mid > 0.005) parts.push(`▲ mid-turn: +${fmtUsd(mid)}`)
  if (r.agentCold.penalty > 0.005) parts.push(`△ agents' caches: +${fmtUsd(r.agentCold.penalty)}`)
  return parts.join(' · ')
}

/** A later main-thread request of a row that found the cache lapsed, worded by why. */
function midTurnWords(m: MeterRow['midTurn'][number]): string {
  const tail = `re-wrote ${fmtTokens(m.rewritten)} tokens, +${fmtUsd(m.penalty)}`
  switch (m.reason) {
    case 'idle':
      return `▲ Mid-turn wait of ${fmtDuration(m.idleMs)} (a question or permission prompt, or a long tool): ${tail}`
    case 'model-switch':
      return `▲ Mid-turn, the model changed (each model has its own cache): ${tail}`
    case undefined:
      return `▲ Mid-turn, the cache had lapsed: ${tail}`
    default:
      return `▲ Mid-turn, the cache missed ${fmtDuration(m.idleMs)} after the previous request (something early in the conversation changed): ${tail}`
  }
}

function detailWords(q: MeterReq): string {
  if (q.count && q.count > 1) {
    return `${q.agent ?? q.kind} · ${q.count} requests · ${q.model ? `${modelLabel(q.model)} · ` : ''}read ${fmtTokens(q.read)} · wrote ${fmtTokens(q.write)}${uncachedWords(q)} · out ${fmtTokens(q.out)} · ${fmtUsd(q.usd)}`
  }
  const who = q.kind === 'agent' ? `agent ${q.agent ?? ''}`.trim() : q.kind === 'side' ? 'declined attempt' : q.kind
  return `${clockSeconds(q.at)} ${who} · ${modelLabel(q.model)} · read ${fmtTokens(q.read)} · wrote ${fmtTokens(q.write)}${uncachedWords(q)} · out ${fmtTokens(q.out)} · ${fmtUsd(q.usd)}`
}

/** Input sent without the cache, when it is worth a mention (an advisor run reads the whole conversation so). */
function uncachedWords(q: MeterReq): string {
  return q.uncached && q.uncached >= 1_000 ? ` · uncached ${fmtTokens(q.uncached)}` : ''
}

// ---------------------------------------------------------------- building the view

async function rebuild($: EngineInterface): Promise<void> {
  lastBuild = await $.clock.now()
  const live = await read($, LIVE)
  const log = await read($, LIMIT_LOG)
  const measure = await read($, MEASURE)
  const view = withLive(base, live.exchanges, log, base?.ttl ?? ttlFallback(measure), lastBuild, live.extras ?? [], live.compactedAt)
  await update($, VIEW, () => view)
  if (SNAPSHOT_PATH) {
    // Development aid, off unless SNAPSHOT_PATH is set: a small summary of what the pane draws.
    const rows = view.rows.slice(-6).map(r => ({ n: r.n, id: r.id, prompt: r.prompt.slice(0, 40), origin: r.origin, live: !!r.live, open: !!r.open, you: r.you, claude: r.claude, cache: r.cache, reason: r.reason, mainReqs: r.mainReqs, agentReqs: r.agentReqs, limits: r.limits, limitsSince: r.limitsSince }))
    const snapshot = { at: lastBuild, source: view.source, ttl: view.ttl, totals: view.totals, compactedAt: view.compactedAt, estimatedRequests: view.estimatedRequests, rows, liveExchanges: live.exchanges.map(x => ({ id: x.id, origin: x.origin, open: x.open, partial: !!x.partial, reqs: x.reqs.length, agentReqs: x.reqs.filter(r => r.kind === 'agent').length })), agentHomes: live.agentHome, runHomes: live.runHome ?? {}, measure, transcript: await read($, TRANSCRIPT) }
    $.fs.write(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 1)).catch(() => undefined)
  }
}

/** Rebuilds at most once a second while requests stream in. */
async function scheduleRebuild($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (now - lastBuild >= 1_000) {
    await rebuild($)
    return
  }
  if (buildPending) return
  buildPending = true
  $.clock.after(1_000 - (now - lastBuild), () => {
    buildPending = false
    void rebuild($)
  })
}

async function agentFilesOf($: EngineInterface, sessionPath: string): Promise<{ path: string; size: number; agentId: string; runId?: string }[]> {
  const root = `${sessionPath.replace(/\.jsonl$/i, '')}/subagents`
  const out: { path: string; size: number; agentId: string; runId?: string }[] = []
  if (!(await $.fs.exists(root))) return out
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries
    try {
      entries = await $.fs.list(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`
      if (e.kind === 'dir') await walk(p, depth + 1)
      else if (e.kind === 'file' && /^agent-.+\.jsonl$/.test(e.name)) {
        const runId = runIdFromPath(p)
        out.push(runId ? { path: p, size: e.size, agentId: agentIdFromPath(p) ?? p, runId } : { path: p, size: e.size, agentId: agentIdFromPath(p) ?? p })
      }
    }
  }
  await walk(root, 0)
  return out
}

/** The transcript's view: read in-process when small, through the Node helper when large; null when neither works. */
async function loadTranscript($: EngineInterface, path: string, fallback: Ttl): Promise<MeterView | null> {
  let size = 0
  try {
    const st = await $.fs.stat(path)
    if (st.kind !== 'file') return null
    size = st.size
  } catch {
    return null
  }
  const now = await $.clock.now()
  const agents = await agentFilesOf($, path)
  const biggest = Math.max(size, ...agents.map(a => a.size))
  const total = size + agents.reduce((s, a) => s + a.size, 0)
  if (biggest <= READ_LIMIT && total <= IN_PROCESS_LIMIT) {
    try {
      const p = createTranscriptParser()
      forEachLine(await $.fs.read(path), l => p.line(l))
      for (const a of agents) {
        try {
          forEachLine(await $.fs.read(a.path), l => p.agentLine(l, a.agentId, a.runId))
        } catch {
          // an agent file that vanished or grew past the limit: skip it
        }
      }
      const parsed = p.result()
      dbg($, `read ${path} in-process (${size} bytes, ${agents.length} agent files): ${parsed.exchanges.length} messages`)
      return buildTranscriptView(parsed, fallback, now)
    } catch (err) {
      dbg($, `in-process read failed: ${(err as Error).message}`)
    }
  }
  if (helperFailed) return null
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/summarize.ts`, path, '--ttl', fallback], { timeoutMs: 180_000 })
    if (r.exitCode === 0 && !r.isStdoutTruncated && r.stdout.trim().startsWith('{')) {
      const view = JSON.parse(r.stdout) as MeterView
      dbg($, `read ${path} through Node (${total} bytes in all): ${view.rows.length} messages`)
      return view
    }
    dbg($, `Node helper exit ${r.exitCode}${r.isStdoutTruncated ? ' (output cut)' : ''}: ${r.stderr.slice(0, 300)}`)
    helperFailed = true
  } catch (err) {
    dbg($, `Node helper failed to start: ${(err as Error).message}`)
    helperFailed = true
  }
  return null
}

/**
 * Finds this session's transcript without waiting for a settings-hook event
 * (a mod loaded mid-session hears none until the next prompt):
 * <config>/projects/<the session's directory, every character outside [A-Za-z0-9-] made "-">/<session id>.jsonl,
 * else whichever project folder holds <session id>.jsonl.
 */
async function findTranscript($: EngineInterface): Promise<{ path: string; sessionId: string } | null> {
  let id = ''
  try {
    id = await $.session.id()
  } catch {
    return null
  }
  if (!id) return null
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const userProfile = await $.env.get('USERPROFILE')
  const home = await $.env.get('HOME')
  // Joined with the root's own separator, so the path matches what the settings hooks report.
  const join = (a: string, ...rest: string[]) => {
    const sep = a.includes('\\') ? '\\' : '/'
    return [a.replace(/[\\/]+$/, ''), ...rest].join(sep)
  }
  const roots = configDir ? [configDir] : [userProfile, home].filter((x): x is string => !!x).map(h => join(h, '.claude'))
  const slug = (dir: string) => dir.replace(/[^A-Za-z0-9-]/g, '-')
  const dirs: string[] = []
  for (const get of [() => $.session.root(), () => $.session.cwd()]) {
    try {
      dirs.push(slug(await get()))
    } catch {
      // not known here
    }
  }
  for (const root of roots) {
    const projects = join(root, 'projects')
    for (const d of dirs) {
      const p = join(projects, d, `${id}.jsonl`)
      if (await $.fs.exists(p)) return { path: p, sessionId: id }
    }
    try {
      for (const entry of await $.fs.list(projects)) {
        if (entry.kind !== 'dir') continue
        const p = join(projects, entry.name, `${id}.jsonl`)
        if (await $.fs.exists(p)) return { path: p, sessionId: id }
      }
    } catch {
      // no projects folder under this root
    }
  }
  return null
}

/** Re-reads the transcript, folds what it now holds out of the live list, and redraws. */
async function refresh($: EngineInterface): Promise<void> {
  if (refreshing) {
    refreshAgain = true
    return
  }
  refreshing = true
  try {
    do {
      refreshAgain = false
      const gen = sessionGen
      let ref = await read($, TRANSCRIPT)
      if (!ref || !ref.path) {
        const found = await findTranscript($)
        if (found && gen === sessionGen) {
          await update($, TRANSCRIPT, () => found)
          dbg($, `found transcript ${found.path}`)
          ref = found
        }
      }
      const measure = await read($, MEASURE)
      if (ref && ref.path) {
        const path = ref.path
        const loaded = await loadTranscript($, path, ttlFallback(measure))
        if (gen !== sessionGen) {
          // A /clear or resume landed while this read ran: it was of the old session.
          refreshAgain = true
          continue
        }
        if (loaded) {
          base = loaded
          basePath = path
          // The transcript now holds every exchange whose first main request came
          // before its newest one; agents' steps heard with no turn of their own are
          // in it too, filed under the exchange that launched them.
          const mark = loaded.lastMain?.at ?? -Infinity
          await update($, LIVE, s => {
            const exchanges = s.exchanges.filter(x => x.open || (!x.partial && !isCovered(x, mark)))
            const ids = new Set(exchanges.map(x => x.id))
            // An agent whose message the transcript now holds stays out of later messages.
            const agentHome: Record<string, string> = {}
            for (const [agent, ex] of Object.entries(s.agentHome).slice(-1_000)) agentHome[agent] = ids.has(ex) ? ex : BACKGROUND
            const runHome: Record<string, string> = {}
            for (const [run, ex] of Object.entries(s.runHome ?? {}).slice(-200)) runHome[run] = ids.has(ex) ? ex : BACKGROUND
            return { ...s, exchanges, agentHome, runHome }
          })
        } else if (basePath !== undefined && !samePath(basePath, path)) {
          // The session changed and its transcript is not written yet.
          base = null
          basePath = undefined
        }
      }
      await rebuild($)
      await toastIfCold($)
    } while (refreshAgain)
  } catch {
    // a failed refresh leaves the last view standing
  } finally {
    refreshing = false
  }
}

/** One toast for a message that just paid for a lapsed cache: only one from a turn this load saw end. */
async function toastIfCold($: EngineInterface): Promise<void> {
  const view = await read($, VIEW)
  if (!view || !view.rows.length) return
  const last = [...view.rows].reverse().find(r => r.origin !== 'background')
  if (!last || last.open || last.id === toasted) return
  if (seenTurnAt === undefined || last.at < seenTurnAt - 60_000) return
  // The conversation's own lapses (its first request and mid-turn ones): agents' caches are another matter.
  const usd = last.penalty - last.agentCold.penalty
  if (usd < 0.25 || !isColdRow(last)) return
  toasted = last.id
  const tokens = last.rewritten + last.midTurn.reduce((s, m) => s + m.rewritten, 0)
  const who = originClass(last.origin) === 'person' ? 'that message' : wakerWords(last.origin).replace(/^this turn$/, 'that turn')
  const byTime = (last.cache === 'cold' && last.reason === 'idle') || last.midTurn.some(m => m.reason === 'idle')
  $.ui.toast(`${byTime ? 'Cache had lapsed' : 'Cache missed'}: ${who} re-wrote ${fmtTokens(tokens)} tokens of conversation (+${fmtUsd(usd)} over a warm cache).`, { timeoutMs: 8_000 })
}

/** Opens the pane beside the chat once a surface that docks panes is attached (not on a terminal: there it opens on /usage-meter). */
async function openPaneUnasked($: EngineInterface): Promise<void> {
  if (panePlaced) return
  try {
    const surfaces = await $.session.surfaces()
    if (!surfaces.length || surfaces.every(s => s === 'terminal')) return
    const r = await $.ui.open({ id: PANE, title: TITLE })
    panePlaced = r.isPlaced
  } catch {
    // no surface yet: the next turn tries again
  }
}

async function notePath($: EngineInterface, path: string | undefined, sessionId: string | undefined): Promise<void> {
  if (!path) return
  const had = await read($, TRANSCRIPT)
  if (had && had.path === path) return
  if (had && samePath(had.path, path)) {
    // The same file spelled another way: keep the settings hooks' spelling, nothing else changes.
    await update($, TRANSCRIPT, () => ({ path, sessionId: sessionId ?? had.sessionId }))
    return
  }
  if (had) {
    // Another session (a /clear, a resume): start over at once, and drop any read
    // of the old one still running.
    sessionGen += 1
    base = null
    basePath = undefined
    seenTurnAt = undefined
    await update($, LIVE, () => ({ exchanges: [], agentHome: {}, extras: [] }))
    await update($, LIMIT_LOG, () => [])
  }
  await update($, TRANSCRIPT, () => ({ path, sessionId: sessionId ?? '' }))
  dbg($, `transcript ${path}`)
  await rebuild($)
  $.clock.after(200, () => {
    void refresh($)
  })
}

// ---------------------------------------------------------------- the module

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({
        name: 'usage-meter',
        description: 'Show how much usage each message used (opens a pane beside the chat)',
        argumentHint: '[show | hide | notes-off | notes-on]',
      })
    } catch {
      // a second registration after a reload is refused; the first stands
    }
    await openPaneUnasked($)
    $.clock.every(30_000, () => {
      void update($, TICK, n => (n % 1_000_000) + 1)
    })
    $.clock.after(100, () => {
      void refresh($)
    })
    return r
  })

  // The transcript's path reaches a mod only on the settings-hook events.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      await notePath($, e.transcript_path, e.session_id)
    } catch {
      // never stand in the session's way
    }
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    try {
      await notePath($, e.transcript_path, e.session_id)
    } catch {
      // never stand in the prompt's way
    }
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    try {
      await notePath($, e.transcript_path, e.session_id)
    } catch {
      // never stand in the turn's way
    }
    return next(e)
  })

  // Who sent the prompt that starts the next turn (the engine stamps it): a person,
  // a background task's notification, another session...
  on('prompt.submit', async ($, e, next) => {
    try {
      const kind = e.origin?.kind
      if (kind) pendingOrigin = { kind: kind === 'composer' ? 'human' : kind, at: await $.clock.now() }
    } catch {
      // never stand in the prompt's way
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    try {
      const at = await $.clock.now()
      let before: LimitReadingState[] = []
      try {
        before = readings((await $.session.usage()).rateLimits)
      } catch {
        // no readings off a subscription
      }
      // The readings come with API responses: when the last one is long gone, the
      // turn's change also covers whatever else used the account in between.
      const since = lastReadingAt === undefined ? 0 : at - lastReadingAt > 120_000 ? lastReadingAt : undefined
      turn = since === undefined ? { id: e.turnId, at, before } : { id: e.turnId, at, before, since }
      await openPaneUnasked($)
      const text = e.text ?? ''
      const origin = pendingOrigin && at - pendingOrigin.at < 30_000 ? pendingOrigin.kind : originOfText(text)
      pendingOrigin = undefined
      await update($, LIVE, s => openLive(s, { id: e.turnId, at, prompt: preview(cleanPrompt(text) || '(continued)', 200), origin, open: true, reqs: [] }))
      await scheduleRebuild($)
    } catch {
      // the meter never breaks a turn
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const r = yield* next(e)
    try {
      const u = r.usage
      if (u) {
        const endedAt = await $.clock.now()
        lastReadingAt = endedAt
        const req: LiveReq = {
          key: `${e.turnId}#${e.index}`,
          at: startedAt,
          end: endedAt,
          model: u.model,
          input: u.input_tokens,
          output: u.output_tokens,
          read: u.cache_read_input_tokens,
          write: u.cache_creation_input_tokens,
          kind: e.agentId ? 'agent' : 'main',
        }
        if (e.agentId) req.agentId = e.agentId
        dbg($, `step ${req.key}${e.agentId ? ` agent ${e.agentId}` : ''}: ${u.model} in ${u.input_tokens} read ${u.cache_read_input_tokens} write ${u.cache_creation_input_tokens} out ${u.output_tokens}`)
        await update($, LIVE, s => addLive(s, req, turn?.id, e.turnId))
        await scheduleRebuild($)
      }
    } catch {
      // the meter never breaks a step
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    try {
      const at = await $.clock.now()
      if (turn && turn.id === e.turnId) {
        seenTurnAt = turn.at
        let after: LimitReadingState[] = []
        try {
          after = readings((await $.session.usage()).rateLimits)
        } catch {
          // no readings off a subscription
        }
        const startedAt = turn.at
        const since = turn.since
        const deltas = limitDeltas(turn.before, after).map(d => ({ label: d.label, delta: d.delta, didReset: d.didReset, now: d.after }))
        if (deltas.length) {
          await update($, LIMIT_LOG, log => [
            ...log.filter(x => x.at !== startedAt),
            since === undefined ? { at: startedAt, deltas } : { at: startedAt, deltas, since },
          ].slice(-400))
        }
      }
      turn = undefined
      await update($, LIVE, s => closeLive(s, e.turnId, at))
      await rebuild($)
      $.clock.after(400, () => {
        void refresh($)
      })
      // A line beneath Claude's answer: display only, the transcript is never rewritten.
      const ui = await read($, UI)
      if (!ui.notesHidden && r.text === e.answer) {
        const view = await read($, VIEW)
        const row = view?.rows.find(x => x.id === e.turnId)
        if (view && row && row.mainReqs > 0) return { ...r, text: noteLine(row, view.ttl) }
      }
    } catch {
      // the meter never breaks a turn
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    try {
      const at = await $.clock.now()
      lastReadingAt = at
      const m: MeasureState = { rateLimits: readings(e.rateLimits), at }
      if (e.cost) m.costUsd = e.cost.usd
      await update($, MEASURE, () => m)
    } catch {
      // readings are a nicety
    }
    return r
  })

  // Each agent's home, as the engine starts it: the turn that spawned or resumed it.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      const id = 'agentId' in r ? r.agentId : undefined
      if (id) {
        const running = turn?.id
        await update($, LIVE, s => homeAgent(s, id, e, running))
      }
    } catch {
      // the meter never stands in an agent's way
    }
    return r
  })

  // A workflow run resumed in a later turn: its agents from now on are that turn's.
  on('tool.call', async ($, e, next) => {
    try {
      const runId = (e as unknown as { resumeFromRunId?: unknown }).resumeFromRunId
      if (e.tool === 'Workflow' && e.agentId === undefined && typeof runId === 'string' && runId && turn) {
        const t = turn.id
        await update($, LIVE, s => ({ ...s, runHome: { ...(s.runHome ?? {}), [runId]: t } }))
      }
    } catch {
      // the meter never stands in a tool's way
    }
    return next(e)
  })

  // The summary request a compaction makes is never written to the transcript: keep it here.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!('skip' in r)) {
        const at = await $.clock.now()
        if (r.usage) {
          lastReadingAt = at
          const u = r.usage
          const req: LiveReq = {
            key: `compact@${at}`,
            at,
            end: at,
            model: (await $.session.model()) ?? 'unknown',
            input: u.input_tokens,
            output: u.output_tokens,
            read: u.cache_read_input_tokens,
            write: u.cache_creation_input_tokens,
            kind: 'compact',
          }
          await update($, LIVE, s => ({ ...s, extras: [...(s.extras ?? []), req].slice(-100) }))
        }
        // The main conversation's compaction installs a summary: the next message
        // rebuilds from it. A subagent's or a fork's (agentId), and a summary only
        // prepared in advance ('precompute'), change nothing for the next message.
        if (e.agentId === undefined && e.trigger !== 'precompute') {
          await update($, LIVE, s => ({ ...s, compactedAt: at }))
        }
        await scheduleRebuild($)
      }
    } catch {
      // the meter never breaks a compaction
    }
    return r
  })

  on('command.run', { command: 'usage-meter' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'notes-off' || arg === 'notes-on') {
      await update($, UI, u => ({ ...u, notesHidden: arg === 'notes-off' }))
      return { text: arg === 'notes-off' ? 'Usage lines under replies turned off.' : 'Usage lines under replies turned on.' }
    }
    if (arg === 'hide' || arg === 'hide-band') {
      await update($, UI, u => ({ ...u, bandHidden: true }))
      return { text: HIDE_HINT }
    }
    await update($, UI, u => ({ ...u, bandHidden: false }))
    if (arg === 'show' || arg === 'show-band') return { text: 'Usage band shown above the prompt.' }
    await $.ui.open({ id: PANE, title: TITLE })
    $.clock.after(50, () => {
      void refresh($)
    })
    return { text: 'Usage meter opened.' }
  })

  // ---------------------------------------------------------------- the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = await read($, VIEW)
    const ui = await read($, UI)
    const measure = await read($, MEASURE)
    await read($, TICK)
    const now = await $.clock.now()
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // Graphics where the surface draws SVG; the terminal gets text.
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const cols = Math.max(24, e.props.bodyColumns)
    const W = Math.max(240, Math.min(560, cols * 8))

    if (!view || !view.rows.length) {
      return (
        <Box flexDirection="column" gap="xs">
          <Text weight="semibold">Usage per message</Text>
          <Text dimColor>Waiting for the first message of this session. Each message you send shows up here with what it used.</Text>
        </Box>
      )
    }

    const t = view.totals
    const ttl = view.ttl
    const est = estimateNext(reqOfLastMain(view.lastMain, ttl), now, ttl, priceFor, view.compactedAt)
    const limits = measure?.rateLimits ?? []
    const rows = view.rows.slice(-PANE_ROWS).reverse()
    const expanded = new Set(ui.expanded)
    const approx = view.estimatedRequests ? '≈' : ''

    // A quiet section label, with a note on the right.
    const label = (key: string, title: string, note?: string) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" alignItems="center" marginTop="lg">
        <Text size="caption" weight="medium" dimColor>
          {title}
        </Text>
        {note ? (
          <Text size="caption" dimColor>
            {note}
          </Text>
        ) : null}
      </Box>
    )
    const toggle = (id: string) =>
      update($, UI, u => ({ ...u, expanded: u.expanded.includes(id) ? u.expanded.filter(x => x !== id) : [...u.expanded, id].slice(-20) }))

    // ------------------------------------------------ this chat
    const session = (
      <Box key="session" flexDirection="column" gap="xs">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="caption" weight="medium" dimColor>
            This chat
          </Text>
          <Text size="caption" dimColor>
            {t.messages} message{t.messages === 1 ? '' : 's'} · {fmtTokens(t.tokens)} tokens
          </Text>
        </Box>
        <Box flexDirection="row" alignItems="flex-end" gap="sm">
          <Text size="title" weight="semibold" tabular>
            {approx}
            {fmtUsd(t.usd)}
          </Text>
          <Text dimColor>API-equivalent</Text>
        </Box>
        {Svg ? <Svg source={splitBarSvg(t.you, t.claude, W, 8)} alt={`Your messages ${fmtUsd(t.you)}, Claude's replies ${fmtUsd(t.claude)}`} height={8} /> : null}
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap="xs">
            <Text color={YOU_COLOR}>■</Text>
            <Text tabular>You {fmtUsd(t.you)}</Text>
          </Box>
          <Box flexDirection="row" gap="xs">
            <Text color={CLAUDE_COLOR}>■</Text>
            <Text tabular>
              Claude {approx}
              {fmtUsd(t.claude)}
            </Text>
          </Box>
        </Box>
        {t.penalty > 0.005 ? <Text color="warning">▲ {fmtUsd(t.penalty)} lost to lapsed caches</Text> : null}
      </Box>
    )

    // ------------------------------------------------ the cache
    let cache = null
    if (est.state !== 'none') {
      const left = est.state === 'warm' ? est.msLeft / ttlMs(ttl) : 0
      cache = (
        <Box key="cache" flexDirection="column" gap="xs">
          {label('cache-label', 'Cache', `${ttlWords(ttl)} lifetime`)}
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            {est.state === 'warm' ? (
              <Text>◷ Warm for {fmtDuration(est.msLeft)}</Text>
            ) : est.state === 'cold' ? (
              <Text color="warning">▲ Expired {fmtDuration(est.idleMs - ttlMs(ttl))} ago</Text>
            ) : (
              <Text>↺ Compacted</Text>
            )}
            {est.state === 'compacted' ? null : (
              <Text dimColor tabular>
                {fmtTokens(est.contextTokens)} tokens
              </Text>
            )}
          </Box>
          {est.state === 'warm' ? (
            Svg ? (
              <Svg source={meterSvg(left, W, 4, NEUTRAL_COLOR)} alt={`${fmtDuration(est.msLeft)} of the ${ttlWords(ttl)} cache left`} height={4} />
            ) : (
              <Text dimColor>{bar(left, 24)}</Text>
            )
          ) : null}
          {est.state === 'warm' ? (
            <Text dimColor>Your next message ≈ {fmtUsd(est.warmUsd)} to re-read the conversation</Text>
          ) : est.state === 'cold' ? (
            <Text color="warning">
              Your next message re-writes it ≈ {fmtUsd(est.coldUsd)} (warm: {fmtUsd(est.warmUsd)})
            </Text>
          ) : (
            <Text dimColor>Since the last request: your next message rebuilds the cache from the summary</Text>
          )}
        </Box>
      )
    }

    // ------------------------------------------------ plan limits
    const plan = limits.length ? (
      <Box key="plan" flexDirection="column" gap="xs">
        {label('plan-label', 'Plan limits', 'all your chats')}
        {limits.map(l => {
          const pct = Math.round(l.percentUsed * 10) / 10
          const high = l.percentUsed >= 80
          const resets = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN
          return (
            <Box key={`limit-${l.kind}`} flexDirection="column" gap="xs">
              <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                <Text>{limitLabel(l.kind)}</Text>
                {high ? (
                  <Text tabular color="warning">
                    ▲ {pct}% used
                  </Text>
                ) : (
                  <Text tabular>{pct}% used</Text>
                )}
              </Box>
              {Svg ? (
                <Svg source={meterSvg(l.percentUsed / 100, W, 4, high ? WARN_COLOR : NEUTRAL_COLOR)} alt={`${limitLabel(l.kind)}: ${pct}% used`} height={4} />
              ) : (
                <Text dimColor>{bar(l.percentUsed / 100, 24)}</Text>
              )}
              {Number.isFinite(resets) && resets > 0 ? (
                <Text size="caption" dimColor>
                  Resets in {fmtDuration(resets)}
                </Text>
              ) : null}
            </Box>
          )
        })}
      </Box>
    ) : null

    // ------------------------------------------------ cost per message
    const shown = Math.min(40, view.rows.length)
    const chart = Svg ? (
      <Box key="chart" flexDirection="column" gap="xs">
        {label('chart-label', 'Cost per message', `last ${shown}`)}
        <Svg source={miniChartSvg(view.rows, W, 104)} alt={`Cost of the last ${shown} messages: your message and Claude's reply, stacked`} height={104} isInteractive />
        <Box flexDirection="row" gap="sm">
          <Text size="caption" color={YOU_COLOR}>
            ■
          </Text>
          <Text size="caption" dimColor>
            your message
          </Text>
          <Text size="caption" color={CLAUDE_COLOR}>
            ■
          </Text>
          <Text size="caption" dimColor>
            Claude's reply
          </Text>
          <Text size="caption" color="warning">
            ▲
          </Text>
          <Text size="caption" dimColor>
            cache lapsed
          </Text>
        </Box>
      </Box>
    ) : (
      <Box key="spark" flexDirection="column" gap="xs">
        {label('spark-label', 'Cost per message', `last ${Math.min(30, view.rows.length)}`)}
        <Text dimColor>{sparkline(view.rows)}</Text>
      </Box>
    )

    // ------------------------------------------------ messages
    const stateChip = (r: MeterRow) => {
      switch (r.cache) {
        case 'cold':
          return (
            <Text size="caption" color="warning">
              ▲ cold
            </Text>
          )
        case 'partial':
          return (
            <Text size="caption" color="warning">
              △ partial
            </Text>
          )
        case 'warm':
          return (
            <Text size="caption" dimColor>
              warm
            </Text>
          )
        case 'reset':
          return (
            <Text size="caption" dimColor>
              ↺ rebuilt
            </Text>
          )
        case 'first':
          return (
            <Text size="caption" dimColor>
              first
            </Text>
          )
        default:
          return null
      }
    }
    const maxRow = Math.max(0.0001, ...rows.filter(r => r.origin !== 'background').map(r => r.total))
    const rowNodes = rows.map(row => {
      if (row.origin === 'background') {
        return (
          <Box key={row.id} flexDirection="row" justifyContent="space-between" alignItems="center" gap="md" marginTop="lg">
            <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
              <Text size="caption" dimColor wrap="truncate-end">
                {clock(row.at)} · {row.prompt}
              </Text>
            </Box>
            <Text size="caption" dimColor tabular>
              {fmtUsd(row.total)}
            </Text>
          </Box>
        )
      }
      const isOpen = expanded.has(row.id)
      const cold = coldWords(row, ttl)
      const origin = originLabel(row.origin).replace(/: $/, '')
      const meta = [`#${row.n}`, clock(row.at), origin, row.open ? 'running' : row.live ? 'live' : ''].filter(Boolean).join(' · ')
      const plan = limitWords(row)
      return (
        <Box key={row.id} flexDirection="column" gap="xs" marginTop="lg">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="md">
            <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
              <Text weight="medium" wrap="truncate-end">
                {row.prompt || '(no text)'}
              </Text>
            </Box>
            <Text weight="semibold" tabular>
              {row.estimated ? '≈' : ''}
              {fmtUsd(row.total)}
            </Text>
          </Box>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text size="caption" dimColor>
              {meta}
            </Text>
            {stateChip(row)}
          </Box>
          {Svg ? <Svg source={splitBarSvg(row.you, row.claude, W, 6, row.total / maxRow)} alt={`You ${fmtUsd(row.you)}, Claude ${fmtUsd(row.claude)}`} height={6} /> : null}
          <Box flexDirection="row" gap="sm">
            <Text color={YOU_COLOR}>■</Text>
            <Text tabular>You {fmtUsd(row.you)}</Text>
            <Text dimColor wrap="truncate-end">
              {youWords(row)}
            </Text>
          </Box>
          {cold ? <Text color="warning">{cold}</Text> : null}
          <Box flexDirection="row" gap="sm">
            <Text color={CLAUDE_COLOR}>■</Text>
            <Text tabular>
              Claude {row.estimated ? '≈' : ''}
              {fmtUsd(row.claude)}
            </Text>
            <Text dimColor wrap="truncate-end">
              {claudeWords(row)}
            </Text>
          </Box>
          {row.midTurn.map((m, i) => (
            <Text key={`mid-${i}`} color="warning">
              {midTurnWords(m)}
            </Text>
          ))}
          {row.agentCold.count ? (
            <Text dimColor>
              △ {row.agentCold.count} agent request{row.agentCold.count === 1 ? '' : 's'} found the agent's 5-minute cache lapsed: +{fmtUsd(row.agentCold.penalty)}
            </Text>
          ) : null}
          {plan ? (
            <Text size="caption" dimColor>
              {plan}
            </Text>
          ) : null}
          {row.detail && row.detail.length ? (
            <Button
              key={`toggle-${row.id}`}
              plain
              label={isOpen ? 'Hide requests' : `Show ${row.detail.length} request line${row.detail.length === 1 ? '' : 's'}`}
              onPress={() => toggle(row.id)}
            />
          ) : null}
          {isOpen && row.detail
            ? row.detail.map((q, i) => (
                <Text key={`d-${row.id}-${i}`} size="caption" dimColor wrap="truncate-end">
                  {detailWords(q)}
                </Text>
              ))
            : null}
        </Box>
      )
    })

    // ------------------------------------------------ notes
    const hidden = view.hiddenRows + Math.max(0, view.rows.length - PANE_ROWS)
    const about = expanded.has(ABOUT)
    const notes = (
      <Box key="foot" flexDirection="column" gap="xs" marginTop="lg">
        {hidden > 0 ? (
          <Text size="caption" dimColor>
            {hidden} older messages not shown (the command-line report lists them all).
          </Text>
        ) : null}
        {view.source === 'live' ? (
          <Text size="caption" dimColor>
            Counting live: the transcript has not been read yet.
          </Text>
        ) : null}
        <Button key="usage-meter-about" plain label={about ? 'Hide notes' : 'About these numbers'} onPress={() => toggle(ABOUT)} />
        {about ? (
          <Box flexDirection="column" gap="xs">
            <Text size="caption" dimColor>
              You: what reading the conversation plus your new message cost. Claude: everything it did to answer, thinking, writing, tools, agents and the advisor.
            </Text>
            <Text size="caption" dimColor>
              Dollars are API list-price equivalents for comparison; a subscription doesn't charge them. Plan limits are Claude Code's own readings for your whole account, so they include your other chats.
            </Text>
            {view.estimatedRequests ? (
              <Text size="caption" dimColor>
                ≈ {view.estimatedRequests} agent request{view.estimatedRequests === 1 ? '' : 's'} had incomplete output counts in the transcript: their output is estimated, likely low.
              </Text>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {session}
        {cache}
        {plan}
        {chart}
        {label('messages-label', 'Messages', 'newest first')}
        {rowNodes}
        {notes}
      </Box>
    )
  })

  // ---------------------------------------------------------------- the band above the prompt

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const ui = await read($, UI)
    if (ui.bandHidden) return next(e)
    const view = await read($, VIEW)
    if (!view || !view.rows.length) return next(e)
    await read($, TICK)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const ttl = view.ttl
    const est = estimateNext(reqOfLastMain(view.lastMain, ttl), now, ttl, priceFor, view.compactedAt)
    const last = [...view.rows].reverse().find(r => r.origin !== 'background')
    let line: string
    let warn = false
    if (e.props.isWorking && last && last.open) {
      line = `● This message so far: you ${fmtUsd(last.you)} · Claude ${fmtUsd(last.claude)} · ${last.mainReqs + last.agentReqs} requests`
    } else if (est.state === 'cold') {
      warn = true
      line = `▲ Cache expired ${fmtDuration(est.idleMs - ttlMs(ttl))} ago: your next message re-writes ${fmtTokens(est.contextTokens)} tokens ≈ ${fmtUsd(est.coldUsd)} (warm: ${fmtUsd(est.warmUsd)})`
    } else if (est.state === 'compacted') {
      line = '↺ Conversation compacted: your next message rebuilds the cache from the summary'
    } else if (est.state === 'warm') {
      line = `◷ Cache warm ${fmtDuration(est.msLeft)} · next message ≈ ${fmtUsd(est.warmUsd)} to re-read ${fmtTokens(est.contextTokens)}${last ? ` · last: you ${fmtUsd(last.you)}, Claude ${last.estimated ? '≈' : ''}${fmtUsd(last.claude)}` : ''}`
    } else {
      return next(e)
    }
    const below = await next(e)
    const hide = async (): Promise<void> => {
      await update($, UI, u => ({ ...u, bandHidden: true }))
      $.ui.toast(HIDE_HINT, { timeoutMs: 8_000 })
    }
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap="md" paddingX="sm">
          <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
            {warn ? (
              <Text color="warning" wrap="truncate-end">
                {line}
              </Text>
            ) : (
              <Text dimColor wrap="truncate-end">
                {line}
              </Text>
            )}
          </Box>
          <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
            <Button key="usage-meter-open" plain label="Usage" onPress={() => $.ui.open({ id: PANE, title: TITLE })} />
            <Button key="usage-meter-hide" plain label="Hide" onPress={hide} />
          </Box>
        </Box>
      </Box>
    )
  })
}
