// Parses Claude Code transcript JSONL (~/.claude/projects/<project>/<session>.jsonl
// and the agent transcripts under <session>/subagents/) into deduplicated
// requests grouped into exchanges.
//
// Pure and incremental: lines are fed one at a time and never kept, so a
// transcript of hundreds of megabytes parses in bounded memory. The mod ($.fs)
// and the CLI (node:fs) both feed it.
//
// What the files hold, as surveyed on Claude Code 2.1.2xx-2.1.321 transcripts:
// - One API response is written as one line per content block, each repeating
//   the same usage. Lines are merged by message id (else request id), keeping
//   the line with the most output (older builds wrote partial counts).
// - A request whose lines carry no stop_reason was cut short in the file
//   (sidechain lines of 2.1.219-2.1.293): its output count is a lower bound,
//   so the output is estimated from the content it wrote when that is larger.
// - usage.iterations: "message" entries are the executor's own passes and add
//   up to the top-level counts (around an advisor call there are two passes over
//   the same conversation: billed as their sum, judged by the first and last);
//   an "advisor_message" is the advisor model run inside the request, with its
//   own model and counts, and the top level leaves it out; after a refusal the
//   "fallback_message" is the request served (the top level holds it, with the
//   declined pass's cache split) and each declined "message" pass was billed too.
// - Agent and workflow-agent requests live only in their own files. An agent
//   is charged to the exchange that launched it (the Agent tool result names
//   its agentId, a SendMessage result its resumedAgentId, a Workflow result its
//   transcriptDir; a resumed run keeps its id, and its later requests go to the
//   exchange that resumed it), else to the exchange running when it made the request.
// - A turn can start from a meta line with a non-human origin (another session's
//   message, a notice) when the main loop was idle: that is an exchange too.
// - Compaction's own summary request is not written to the transcript.

import type { ApiUsage, Exchange, Req, RequestKind, Tokens, Ttl } from './usage.ts'
import { addTokens, preview, subtractTokens, tokensFromApiUsage, totalTokens, ZERO_TOKENS } from './usage.ts'

export type AgentFile = {
  /** The file's path, for messages and for its workflow run id. */
  path: string
  text: string
  /** The agent's id, from the file name (agent-<id>.jsonl) when the lines do not carry one. */
  agentId?: string
}

export type ParsedTranscript = {
  sessionId?: string
  title?: string
  exchanges: Exchange[]
  /** Requests made before the first prompt (session-start work). */
  preamble: Req[]
  /** The cache lifetime the session's requests asked for, when the transcript says. */
  ttl?: Ttl
  models: string[]
  /** Lines that did not parse (a half-written last line is normal). */
  badLines: number
  /** Lines that repeated a request already seen (merged, counted once). */
  mergedLines: number
  /** Lines skipped without parsing (tool results and other bulk). */
  skippedLines: number
  /** Requests whose output count was a lower bound in the file and was estimated from their content. */
  estimatedOutputs: number
  /** Timestamp of the last line read, ms. */
  lastAt?: number
  /** When a compaction ran after the main thread's last request (none since). */
  compactedAt?: number
}

type Line = Record<string, unknown>

function asObj(x: unknown): Record<string, unknown> | undefined {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined
}

function timeOf(o: Line): number | undefined {
  const t = str(o.timestamp)
  if (!t) return undefined
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : undefined
}

/** The text of a user message's content (string, or its text blocks), or undefined when it is not a prompt (tool results). */
function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  let hasOther = false
  for (const b of content) {
    const block = asObj(b)
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image' || block.type === 'document') texts.push(`[${block.type}]`)
    else hasOther = true
  }
  if (texts.length === 0) return hasOther ? undefined : ''
  return texts.join(' ')
}

/**
 * Notices the desktop app writes into the chat as a user message, with nothing
 * marking where they came from: the wrapper they start with, once Claude
 * Code's reminders are set aside, and what their row reads.
 */
const APP_EVENTS: Readonly<Record<string, string>> = {
  'side-sessions-event': 'Sessions Claude started reported back',
  'ci-monitor-event': 'Update on a pull request',
}

/** The app notice a prompt is (its wrapper's name), or undefined for anything else. */
export function appEventOf(text: string): string | undefined {
  const rest = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trimStart()
  const m = /^<([a-z-]+)>/.exec(rest)
  return m && m[1]! in APP_EVENTS ? m[1] : undefined
}

/** Turns command wrappers into "/x args", a task notification into its summary, an app notice into what it is, and drops other tags. */
export function cleanPrompt(text: string): string {
  if (/^\s*<task-notification>/.test(text)) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)
    const status = /<status>([\s\S]*?)<\/status>/.exec(text)
    return summary?.[1]?.trim() || `Background task ${status?.[1]?.trim() ?? 'finished'}`
  }
  const event = appEventOf(text)
  if (event) return APP_EVENTS[event]!
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)
    const cmd = name[1] ?? ''
    return `${cmd.startsWith('/') ? cmd : `/${cmd}`}${args && args[1] ? ` ${args[1]}` : ''}`
  }
  // Only the wrappers Claude Code itself injects come out; anything the person
  // typed that looks like markup (pasted HTML, code) stays as typed.
  return ownWords(
    text
      .replace(/<(system-reminder|ide_selection|ide_opened_file|ide_diagnostics|local-command-caveat|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g, ' ')
      .replace(/<\/?(command-message|command-name|command-args|user-prompt-submit-hook)>/g, ' '),
  )
}

const REPLY_MARK = /<!--\s*reply\b[^>]*-->/g

/**
 * A reply made in the desktop app starts each part with `<!-- reply N -->` and
 * the lines it answers, quoted (`> ...`): the person's own words are the rest.
 * Only a message carrying that mark is touched; a quote alone is kept, unquoted.
 */
function ownWords(text: string): string {
  if (!text.match(REPLY_MARK)) return text
  const lines = text.replace(REPLY_MARK, '\n').split('\n')
  const own = lines.filter(l => !/^\s*>/.test(l)).join('\n').trim()
  return own || lines.map(l => l.replace(/^\s*>\s?/, '')).join('\n').trim()
}

function originOf(o: Line): string {
  const origin = asObj(o.origin)
  return (origin ? str(origin.kind) : undefined) ?? 'human'
}

/**
 * True for a user line that starts an exchange: a typed prompt, or a notification
 * that starts a turn. `wakes` is true when the main loop was idle (its last
 * request ended its turn): a meta line from another source (a peer session's
 * message, a notice) then starts a turn of its own; delivered into a running
 * turn it does not.
 */
function isPromptLine(o: Line, wakes: boolean): boolean {
  if (o.type !== 'user') return false
  const kind = str(asObj(o.origin)?.kind)
  const metaWake = o.isMeta === true && !!kind && kind !== 'human' && wakes
  if ((o.isMeta === true && !metaWake) || o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true || o.isSidechain === true) return false
  const msg = asObj(o.message)
  if (!msg || msg.role !== 'user') return false
  const text = promptText(msg.content)
  if (text === undefined) return false
  if (/^\s*<local-command-(stdout|stderr)>/.test(text)) return false
  if (/^\s*\[Request interrupted by user/.test(text)) return false
  return true
}

function approxEqual(a: Tokens, b: Tokens): boolean {
  const ta = totalTokens(a)
  const tb = totalTokens(b)
  return Math.abs(ta - tb) <= Math.max(2, ta * 0.001)
}

/** Characters of content a line's message wrote (text, thinking, tool input): a floor for its output. */
function contentChars(msg: Record<string, unknown>): number {
  const content = msg.content
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const b of content) {
    const block = asObj(b)
    if (!block) continue
    if (typeof block.text === 'string') n += block.text.length
    if (typeof block.thinking === 'string') n += block.thinking.length
    if (block.type === 'tool_use' && block.input !== undefined) {
      try {
        n += JSON.stringify(block.input).length
      } catch {
        // unserializable input: leave it out
      }
    }
  }
  return n
}

type LineReqs = { reqs: Req[]; complete: boolean; chars: number }

/** Reads the usage of one assistant line into requests (the request itself, plus any advisor run inside it). */
export function requestsOfLine(o: Line, kind: RequestKind, agentId: string | undefined): LineReqs {
  const msg = asObj(o.message)
  const none: LineReqs = { reqs: [], complete: false, chars: 0 }
  if (!msg) return none
  const usage = asObj(msg.usage)
  let model = str(msg.model)
  if (!usage || !model || model === '<synthetic>') return none
  const at = timeOf(o) ?? 0
  const session = str(o.sessionId)
  const key = str(msg.id) ?? str(o.requestId) ?? str(o.uuid) ?? `${model}@${at}`
  const fast = usage.speed === 'fast'
  const geoRaw = str(usage.inference_geo)
  const geo = geoRaw && geoRaw !== 'global' ? geoRaw : undefined
  const stu = asObj(usage.server_tool_use)
  const webSearches =
    stu && typeof stu.web_search_requests === 'number' && stu.web_search_requests > 0 ? stu.web_search_requests : undefined
  let tokens = tokensFromApiUsage(usage as ApiUsage)
  let firstPass: Tokens | undefined
  let lastPass: Tokens | undefined
  const extras: Req[] = []
  const iterations = usage.iterations
  if (Array.isArray(iterations) && iterations.length > 1) {
    const passes: { tokens: Tokens; model?: string }[] = []
    let fallback: { tokens: Tokens; model?: string } | undefined
    const others = new Map<string, { model: string; kind: RequestKind; tokens: Tokens }>()
    for (const it of iterations) {
      const io = asObj(it)
      if (!io) continue
      const type = str(io.type) ?? 'message'
      const t = tokensFromApiUsage(io as ApiUsage)
      if (type === 'message') {
        passes.push({ tokens: t, model: str(io.model) })
        continue
      }
      if (type === 'fallback_message') {
        fallback = { tokens: t, model: str(io.model) }
        continue
      }
      const isAdvisor = type.includes('advisor')
      const m = str(io.model) ?? (isAdvisor ? str(o.advisorModel) : undefined) ?? model
      // The advisor's run, and any other side pass, is its own request whatever
      // loop asked for it: it never joins the agent's or the conversation's cache
      // thread (the advisor reads uncached by design).
      const k: RequestKind = isAdvisor ? 'advisor' : type.includes('compact') ? 'compact' : 'side'
      const slot = `${k}:${m}`
      const had = others.get(slot)
      others.set(slot, { model: m, kind: k, tokens: had ? addTokens(had.tokens, t) : t })
    }
    if (fallback) {
      // A refusal fallback: the request served is the fallback pass, at its own
      // model and with its own cache split. Each declined pass before it was
      // billed too, at its model: a request of its own, outside every cache thread.
      tokens = fallback.tokens
      model = fallback.model ?? model
      passes.forEach((p, i) => {
        if (totalTokens(p.tokens) === 0) return
        extras.push({ key: `${key}#declined${i}`, at, model: p.model ?? model!, tokens: p.tokens, kind: 'side', agentId, geo, session })
      })
    } else if (passes.length) {
      let executor: Tokens = { ...ZERO_TOKENS }
      for (const p of passes) executor = addTokens(executor, p.tokens)
      let otherSum: Tokens = { ...ZERO_TOKENS }
      for (const x of others.values()) otherSum = addTokens(otherSum, x.tokens)
      if (approxEqual(tokens, executor)) {
        // Same totals; the iterations carry each pass's 5m/1h split, the top level only the first's.
        tokens = executor
      } else if (totalTokens(otherSum) > 0 && approxEqual(tokens, addTokens(executor, otherSum))) {
        tokens = subtractTokens(tokens, otherSum)
      }
      if (passes.length > 1) {
        // The executor read the same conversation once per pass (around an advisor call).
        firstPass = passes[0]!.tokens
        lastPass = passes[passes.length - 1]!.tokens
      }
    }
    let i = 0
    for (const x of others.values()) {
      if (totalTokens(x.tokens) === 0) continue
      extras.push({ key: `${key}#iter${i++}`, at, model: x.model, tokens: x.tokens, kind: x.kind, agentId, geo, session })
    }
  }
  const main: Req = { key, at, model, tokens, kind, agentId }
  if (session) main.session = session
  if (fast) main.fast = true
  if (geo) main.geo = geo
  if (webSearches) main.webSearches = webSearches
  if (firstPass) main.firstPass = firstPass
  if (lastPass) main.lastPass = lastPass
  return { reqs: [main, ...extras], complete: msg.stop_reason != null, chars: contentChars(msg) }
}

type Draft = { req: Req; output: number; complete: boolean; chars: number }

/** Keeps one request per key: the line with the most output (streamed lines can carry partial counts), the earliest time. */
function mergeInto(map: Map<string, Draft>, r: Req, complete: boolean, chars: number): boolean {
  const had = map.get(r.key)
  if (!had) {
    map.set(r.key, { req: r, output: r.tokens.output, complete, chars })
    return false
  }
  const at = had.req.at && r.at ? Math.min(had.req.at, r.at) : had.req.at || r.at
  const next: Draft = r.tokens.output >= had.output ? { req: { ...r, at }, output: r.tokens.output, complete: had.complete || complete, chars: had.chars + chars } : { ...had, req: { ...had.req, at }, complete: had.complete || complete, chars: had.chars + chars }
  // The response's first line is the one written right after a compaction: keep its mark.
  if (had.req.afterCompaction || r.afterCompaction) next.req = { ...next.req, afterCompaction: true }
  // And when it was sent, as its first line had it.
  const sentAt = had.req.sentAt ?? r.sentAt
  if (sentAt !== undefined) next.req = { ...next.req, sentAt }
  map.set(r.key, next)
  return true
}

/**
 * The request as kept. A request whose lines never carried a stop_reason
 * (agent lines of Claude Code 2.1.219-2.1.293) holds only a lower bound for its
 * output: it is marked estimated, and its output raised to the visible content
 * it wrote (~4 characters a token) when that is larger. Hidden thinking cannot
 * be seen in the file, so the estimate stays low.
 */
function finalReq(d: Draft): { req: Req; estimated: boolean } {
  if (d.complete || d.req.kind === 'advisor' || d.req.kind === 'side') return { req: d.req, estimated: false }
  const guess = Math.round(d.chars / 4)
  const output = Math.max(guess, d.req.tokens.output)
  return { req: { ...d.req, estimated: true, tokens: { ...d.req.tokens, output } }, estimated: true }
}

function ttlOfApiRequest(o: Line): Ttl | undefined {
  const cc = o.cacheControl
  if (!Array.isArray(cc)) return undefined
  let found: Ttl | undefined
  for (const c of cc) {
    const co = asObj(c)
    const v = asObj(co?.value)
    const ttl = v ? str(v.ttl) : undefined
    if (ttl !== '1h' && ttl !== '5m') continue
    if (Array.isArray(co?.path) && co.path[0] === 'messages') return ttl
    found = found ?? ttl
  }
  return found
}

/** Cheap pre-checks: most of a transcript's bytes are tool results and snapshots that carry neither prompts nor usage. */
function worthParsing(raw: string): boolean {
  if (raw.includes('"type":"tool_result"')) {
    // Only the results that launch or resume an agent or a workflow matter here.
    return raw.includes('"agentId"') || raw.includes('"resumedAgentId"') || raw.includes('"transcriptDir"')
  }
  return (
    raw.includes('"usage"') ||
    raw.includes('"type":"user"') ||
    raw.includes('"customTitle"') ||
    raw.includes('"type":"system"') ||
    raw.includes('"type":"summary"') ||
    raw.includes('"type":"api-request"') ||
    raw.includes('"queued_command"')
  )
}

export type TranscriptParser = {
  /** Feeds one line of the session's own transcript. */
  line(raw: string): void
  /** Feeds one line of an agent transcript; `runId` names the workflow run a workflow agent belongs to. */
  agentLine(raw: string, agentId: string, runId?: string): void
  /** The exchanges so far, agents placed. Cheap enough to call after every batch. */
  result(): ParsedTranscript
}

type OpenExchange = {
  id: string
  prompt: string
  origin: string
  at: number
  /** A compaction happened between the previous main request and this exchange's first one. */
  compactedBefore: boolean
  /** Whether a main-thread request has been recorded yet. */
  hasMain: boolean
  /** Delivered into a running turn (a queued message): it started no turn of its own. */
  inTurn: boolean
  reqs: Map<string, Draft>
}

type AgentDraft = Draft & { runId?: string }

export function createTranscriptParser(): TranscriptParser {
  const opened: OpenExchange[] = []
  const preamble = new Map<string, Draft>()
  const agentReqs = new Map<string, AgentDraft>()
  /**
   * The exchanges that launched or resumed each agent, in order, each from the
   * time it applies: a launch from its exchange's start (a synchronous Agent
   * call's result arrives only once the agent is done), a resume from the
   * moment the resume was recorded.
   */
  const agentHomes = new Map<string, { ex: OpenExchange; from: number }[]>()
  /**
   * The exchanges that launched or resumed each workflow run (a resume keeps the
   * run id), in order: the first launch from its exchange's start, a resume from
   * the moment it was recorded.
   */
  const runHomes = new Map<string, { ex: OpenExchange; from: number }[]>()
  /** Launch results already counted: a transcript can repeat history lines. */
  const seenLaunches = new Set<string>()
  const models = new Set<string>()
  let sessionId: string | undefined
  let title: string | undefined
  let ttl: Ttl | undefined
  let current: OpenExchange | undefined
  let compactedSince = false
  /** When the last compaction boundary was written. */
  let compactAt: number | undefined
  /** The stop reason of the main thread's last request: "tool_use" while a turn runs. */
  let lastMainStop: string | undefined
  let lastAt: number | undefined
  /**
   * When the main thread's next request was sent: the api-request line Claude
   * Code writes as it sends one (with its model), else the last line it answers
   * (the prompt, or the tool results), written a moment before it is sent.
   */
  let sending: { at: number; model: string | undefined } | undefined
  let lastInputAt: number | undefined
  let badLines = 0
  let mergedLines = 0
  let skippedLines = 0

  const parse = (raw: string): Line | undefined => {
    const s = raw.trim()
    if (!s) return undefined
    if (!worthParsing(s)) {
      skippedLines += 1
      return undefined
    }
    try {
      const o = JSON.parse(s)
      if (asObj(o)) return o as Line
    } catch {
      // a half-written line
    }
    badLines += 1
    return undefined
  }

  const open = (id: string, text: string, origin: string, at: number | undefined, inTurn = false): void => {
    current = { id, prompt: preview(text, 200), origin, at: at ?? lastAt ?? 0, compactedBefore: false, hasMain: false, inTurn, reqs: new Map() }
    opened.push(current)
  }

  const noteLaunch = (o: Line, at: number | undefined): void => {
    const r = asObj(o.toolUseResult)
    if (!r || !current) return
    const home = (id: string | undefined, from: number) => {
      if (!id || !current) return
      const homes = agentHomes.get(id) ?? []
      if (homes[homes.length - 1]?.ex !== current) homes.push({ ex: current, from })
      agentHomes.set(id, homes)
    }
    home(str(r.agentId), current.at)
    home(str(r.resumedAgentId), at ?? current.at)
    const dir = str(r.transcriptDir)
    if (dir) {
      const runId = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
      const launchKey = str(o.uuid) ?? str(r.taskId)
      if (runId && !(launchKey && seenLaunches.has(launchKey))) {
        if (launchKey) seenLaunches.add(launchKey)
        const homes = runHomes.get(runId) ?? []
        if (homes[homes.length - 1]?.ex !== current) homes.push({ ex: current, from: homes.length === 0 ? current.at : at ?? current.at })
        runHomes.set(runId, homes)
      }
    }
  }

  const line = (raw: string): void => {
    const o = parse(raw)
    if (!o) return
    const at = timeOf(o)
    if (at !== undefined) lastAt = Math.max(lastAt ?? 0, at)
    sessionId = sessionId ?? str(o.sessionId)
    switch (o.type) {
      case 'custom-title':
        title = str(o.customTitle) ?? title
        return
      case 'summary':
        title = title ?? str(o.summary)
        return
      case 'api-request': {
        const t = ttlOfApiRequest(o)
        if (t) ttl = t
        if (at !== undefined && o.isSidechain !== true) sending = { at, model: str(asObj(o.params)?.model) }
        return
      }
      case 'system': {
        if (str(o.subtype) === 'compact_boundary') {
          compactedSince = true
          compactAt = at ?? lastAt
        }
        return
      }
      case 'user': {
        if (at !== undefined && o.isSidechain !== true) lastInputAt = at
        if (o.isCompactSummary === true) {
          compactedSince = true
          compactAt = compactAt ?? at ?? lastAt
        }
        if (o.toolUseResult) noteLaunch(o, at)
        if (!isPromptLine(o, lastMainStop !== 'tool_use')) return
        // Each prompt line starts its own exchange. (promptId is no key: older
        // builds gave every prompt of a session the same one.)
        const msg = asObj(o.message)
        const text = promptText(msg?.content) ?? ''
        // The app's notices carry no origin of their own: they read as typed.
        const origin = originOf(o)
        open(str(o.uuid) ?? `${str(o.promptId) ?? 'p'}:${opened.length}`, cleanPrompt(text), origin === 'human' && appEventOf(text) ? 'app-event' : origin, at)
        return
      }
      case 'attachment': {
        // A message typed while Claude was working, delivered into the running turn.
        const a = asObj(o.attachment)
        if (!a || a.type !== 'queued_command' || o.isSidechain === true) return
        const text = str(a.prompt) ?? ''
        if (!text.trim()) return
        open(str(o.uuid) ?? `q:${opened.length}`, cleanPrompt(text), str(a.commandMode) === 'task-notification' ? 'task-notification' : 'queued', at, true)
        return
      }
      case 'assistant': {
        const sidechain = o.isSidechain === true
        const got = requestsOfLine(o, sidechain ? 'agent' : 'main', sidechain ? str(o.agentId) ?? 'sidechain' : undefined)
        got.reqs.forEach((r, i) => {
          models.add(r.model)
          const complete = i === 0 ? got.complete : true
          const chars = i === 0 ? got.chars : 0
          if (sidechain) {
            if (mergeInto(agentReqs, r, complete, chars)) mergedLines += 1
            return
          }
          if (r.kind === 'main') {
            // When it was sent: its api-request line, else the line it answers.
            if (at !== undefined) {
              const sent = sending && sending.at <= at && (!sending.model || sending.model === r.model) ? sending.at : lastInputAt !== undefined && lastInputAt <= at ? lastInputAt : undefined
              if (sent !== undefined) r.sentAt = sent
            }
            // An auto-compaction runs after the prompt arrives and before its first
            // request: it belongs to the exchange whose first request follows it.
            if (current && !current.hasMain && compactedSince) current.compactedBefore = true
            // The first request after any compaction, mid-turn included, rebuilt the context on purpose.
            if (compactedSince) r.afterCompaction = true
            if (current) current.hasMain = true
            compactedSince = false
            compactAt = undefined
            const stop = str(asObj(o.message)?.stop_reason)
            if (stop) lastMainStop = stop
          }
          if (mergeInto(current ? current.reqs : preamble, r, complete, chars)) mergedLines += 1
        })
        // The api-request line and the line answered belonged to this response; the next writes its own.
        if (!sidechain && got.reqs.some(r => r.kind === 'main')) {
          sending = undefined
          lastInputAt = undefined
        }
        return
      }
      default:
        return
    }
  }

  const agentLine = (raw: string, agentId: string, runId?: string): void => {
    const o = parse(raw)
    if (!o || o.type !== 'assistant') return
    const id = str(o.agentId) ?? agentId
    const got = requestsOfLine(o, 'agent', id)
    got.reqs.forEach((r, i) => {
      models.add(r.model)
      // The agent's own request joins its cache chain; an advisor run, a declined
      // fallback pass or another side pass inside it stays out.
      const req: Req = { ...r, kind: r.kind === 'main' ? 'agent' : r.kind, agentId: id }
      const had = agentReqs.get(req.key)
      if (mergeInto(agentReqs, req, i === 0 ? got.complete : true, i === 0 ? got.chars : 0)) mergedLines += 1
      const d = agentReqs.get(req.key)
      if (d && (runId || had?.runId)) (d as AgentDraft).runId = runId ?? had?.runId
    })
  }

  const homeOf = (r: Req, runId: string | undefined, sorted: readonly OpenExchange[]): OpenExchange | undefined => {
    const homes = r.agentId ? agentHomes.get(r.agentId) : undefined
    if (homes && homes.length) {
      let pick: OpenExchange | undefined
      for (const h of homes) if (h.from <= r.at + 1_000) pick = h.ex
      if (pick) return pick
    }
    if (runId) {
      let pick: OpenExchange | undefined
      for (const h of runHomes.get(runId) ?? []) if (h.from <= r.at + 1_000) pick = h.ex
      if (pick) return pick
    }
    return exchangeAt(sorted, r.at)
  }

  const result = (): ParsedTranscript => {
    const sorted = [...opened].sort((a, b) => a.at - b.at)
    const extra = new Map<OpenExchange, Req[]>()
    const pre: Req[] = []
    let estimatedOutputs = 0
    const keep = (d: Draft): Req => {
      const f = finalReq(d)
      if (f.estimated) estimatedOutputs += 1
      return f.req
    }
    for (const d of preamble.values()) pre.push(keep(d))
    for (const d of agentReqs.values()) {
      const r = keep(d)
      const ex = homeOf(r, (d as AgentDraft).runId, sorted)
      if (ex) {
        const list = extra.get(ex) ?? []
        list.push(r)
        extra.set(ex, list)
      } else pre.push(r)
    }
    const exchanges: Exchange[] = []
    for (const ex of opened) {
      const reqs = [...[...ex.reqs.values()].map(keep), ...(extra.get(ex) ?? [])].sort((a, b) => a.at - b.at)
      // A command that asked nothing of the model gets no row.
      if (reqs.length === 0) continue
      const last = reqs[reqs.length - 1]!
      exchanges.push({
        id: ex.id,
        n: exchanges.length + 1,
        prompt: ex.prompt,
        origin: ex.origin,
        at: ex.at,
        endAt: last.at,
        reqs,
        compactedBefore: ex.compactedBefore || undefined,
        inTurn: ex.inTurn || undefined,
      })
    }
    const out: ParsedTranscript = {
      sessionId,
      title,
      exchanges,
      preamble: pre.sort((a, b) => a.at - b.at),
      ttl,
      models: [...models].sort(),
      badLines,
      mergedLines,
      skippedLines,
      estimatedOutputs,
      lastAt,
    }
    // A compaction after the last main request: the next message rebuilds from the summary.
    if (compactedSince && compactAt !== undefined) out.compactedAt = compactAt
    return out
  }

  return { line, agentLine, result }
}

function exchangeAt<T extends { at: number }>(sorted: readonly T[], at: number): T | undefined {
  let lo = 0
  let hi = sorted.length - 1
  let found: T | undefined
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const ex = sorted[mid]!
    if (ex.at <= at) {
      found = ex
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** Calls `fn` for each line of `text`. */
export function forEachLine(text: string, fn: (line: string) => void): void {
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    fn(text.slice(start, end))
    start = end + 1
  }
}

/** The agent id a subagent transcript's file name carries (agent-<id>.jsonl), if any. */
export function agentIdFromPath(path: string): string | undefined {
  const m = /agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(path.replace(/\\/g, '/'))
  return m ? m[1] : undefined
}

/** The workflow run a workflow agent's transcript sits under (subagents/workflows/<runId>/agent-x.jsonl), if any. */
export function runIdFromPath(path: string): string | undefined {
  const m = /\/workflows\/([^/]+)\/agent-[^/]+\.jsonl$/.exec(path.replace(/\\/g, '/'))
  return m ? m[1] : undefined
}

/** Parses a whole transcript held in memory (small files, tests). */
export function parseTranscript(mainText: string, agents: readonly AgentFile[] = []): ParsedTranscript {
  const p = createTranscriptParser()
  forEachLine(mainText, l => p.line(l))
  for (const f of agents) {
    const id = f.agentId ?? agentIdFromPath(f.path) ?? f.path
    const runId = runIdFromPath(f.path)
    forEachLine(f.text, l => p.agentLine(l, id, runId))
  }
  return p.result()
}
